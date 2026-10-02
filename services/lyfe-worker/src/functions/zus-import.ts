// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ZUS_PROVIDER } from '../../../../examples/medplum-provider/bots/shared/zus-push.ts';
import { handler as zusHandler } from '../../../../examples/medplum-provider/bots/zus-import.ts';
import { botEvent } from '../bot-event.ts';
import { inngest, PER_CLINIC_CONCURRENCY } from '../inngest.ts';
import { getMedplum } from '../medplum.ts';
import { heldPhase, holdWhileRateLimited } from '../providers/hold.ts';
import { withStepTimeout } from '../rate-limit.ts';
import { completeTask, failTask, setPhase, startTask } from '../task.ts';
import { classify } from './chart-import.ts';

/**
 * How long to let Zus's network queries run before reading the record.
 *
 * A patient already enrolled has their record ready now. A **fresh** patient
 * does not: enrolling starts queries out to Carequality and CommonWell, which
 * come back over hours, not seconds. The bot read the record immediately after
 * enrolling — so a fresh patient imported as an empty record and was marked
 * done, which looks like "Zus has nothing for them" and is not.
 *
 * This is the shape neither Medplum bot runtime could express: the wait is far
 * past any execution ceiling, and holding a worker open for it would be wrong
 * even if it were allowed. As Inngest steps, the wait costs nothing — the run
 * is suspended, not held.
 */
const FRESH_ENROLMENT_WAITS = ['30m', '2h', '6h'] as const;

/**
 * Pull a patient's Zus record.
 *
 * Split into steps so the slow path is durable: enrol, wait, pull, and if the
 * record is still empty, wait longer and try again. Each step is short; the
 * run spans hours without anything being held open, and a deploy or restart
 * in the middle loses nothing.
 */
export const zusImport = inngest.createFunction(
  {
    id: 'zus-record-import',
    name: 'Zus record import',
    concurrency: [
      { key: 'event.data.organizationId', limit: PER_CLINIC_CONCURRENCY },
      // One pull per patient at a time, and this one is a correctness
      // requirement rather than a fairness one.
      //
      // Every write is a conditional update keyed on the Zus id, which the
      // server resolves by *searching* and then creating or updating. That is
      // read-then-write, so two runs pulling the same patient at the same
      // moment can both search, both find nothing, and both create — which is
      // the one path by which a re-sync really can duplicate a chart. It is
      // not hypothetical now that a clinician can press a button: two clicks,
      // or a click arriving while the chart import's own pull is still in
      // flight, is exactly this race.
      //
      // Serialising per patient removes it without a lock, without a lease and
      // without anything to expire. The second run does not fail; it waits,
      // then re-pulls over a chart the first one has finished writing, where
      // every write is an idempotent no-op or a genuine update.
      { key: 'event.data.medplumPatientId', limit: 1 },
    ],
    // Raised from 3, matching chart import: a rate limit now reschedules via
    // RetryAfterError instead of spending an attempt, so the budget covers the
    // failures worth re-running.
    retries: 6,
  },
  { event: 'lyfe/zus.import.requested' },
  async ({ event, step, runId, logger }) => {
    const { organizationId, requester, medplumPatientId, batchId, reason } = event.data;
    logger.info('zus pull requested', { medplumPatientId, reason: reason ?? 'chart-import' });
    const medplum = await getMedplum();
    const organization = { reference: `Organization/${organizationId}` };

    const taskId = await step.run('open-task', async () =>
      withStepTimeout('open-task', async () => {
        const task = await startTask({
          medplum,
          organization,
          code: 'zus-import',
          patientId: medplumPatientId,
          runId,
          batchId,
        });
        return task.id as string;
      })
    );

    try {
      // Same brake as the chart import, different provider, and that symmetry
      // is the point: neither this function nor `holdWhileRateLimited` knows
      // anything about Zus beyond the key it is filed under. A third EHR adds
      // its own two lines here and inherits the behaviour whole.
      await holdWhileRateLimited({
        provider: ZUS_PROVIDER,
        organizationId,
        step,
        logger,
        onHold: async (until) => setPhase(medplum, taskId, heldPhase(ZUS_PROVIDER, until)),
      });

      // First attempt. For an already-enrolled patient this is the whole job,
      // and the waits below never happen.
      let result = await step.run('pull-record', async () =>
        withStepTimeout(`zus pull ${medplumPatientId}`, async () => {
          await setPhase(medplum, taskId, 'pulling Zus record');
          // The Task opened above is handed to the bot, so one import is one row.
          return zusHandler(medplum, botEvent(requester, { action: 'import', medplumPatientId, taskId }));
        })
      );

      // A fresh enrolment comes back successful but nearly empty, because the
      // networks have not answered yet. Counting what landed is the only way to
      // tell that apart from a patient who genuinely has no outside record.
      for (const [attempt, wait] of FRESH_ENROLMENT_WAITS.entries()) {
        if (total(result) > 0) {
          break;
        }
        logger.info('record empty, waiting for the networks', { medplumPatientId, wait });
        await setPhase(medplum, taskId, `enrolled — waiting ${wait} for the networks`);
        await step.sleep(`await-networks-${attempt}`, wait);
        result = await step.run(`re-pull-${attempt}`, async () =>
          withStepTimeout(`zus re-pull ${medplumPatientId}`, async () => {
            await setPhase(medplum, taskId, `pulling Zus record (attempt ${attempt + 2})`);
            return zusHandler(medplum, botEvent(requester, { action: 'import', medplumPatientId, taskId }));
          })
        );
      }

      if (!result.ok) {
        // Ineligible is not a failure: the office may simply not be enrolled in
        // Zus, which is a configuration choice. It closes the Task as complete
        // with the reason, rather than as an error someone has to triage.
        //
        // No index request from here either. A refused pull wrote nothing, so
        // there is nothing new to index — and the chart import has already had
        // this patient's own documents indexed, with a summary behind them. A
        // request here would re-extract and re-embed every document to discover
        // that none of them changed.
        const message = 'error' in result ? String(result.error) : 'Zus import failed';
        await step.run('close-skipped', () => setPhase(medplum, taskId, `skipped — ${message}`));
        await step.run('complete-skipped', () => completeTask(medplum, taskId, {}));
        return { skipped: true, reason: message };
      }

      const counts = ('counts' in result ? result.counts : {}) as Record<string, number>;
      await step.run('complete-task', () =>
        withStepTimeout('complete-task', () => completeTask(medplum, taskId, counts))
      );

      // The network half of the chain, and the half that matters most.
      //
      // Most of a patient's documents arrive here rather than from DrChrono —
      // the outside record is where the discharge summaries, the referral
      // letters and the imaging reports live. And it can arrive *hours* after
      // the chart: a fresh enrolment waits on the 30m/2h/6h ladder above, so an
      // index built when the chart landed describes a record that has since
      // grown. Re-indexing is how it catches up, and it is idempotent — a
      // document's chunks are replaced, never appended — so the second run
      // converges on the same index plus whatever the network added.
      //
      // Gated on something having actually been written. An empty result means
      // the networks returned nothing for this patient, in which case there is
      // no new document to index and re-running the whole extraction to confirm
      // that would be paid for in Textract and Bedrock calls.
      //
      // Fire-and-forget, as its own event, for the same reason `request-zus`
      // is: a failure in the indexer must never reach back and mark a network
      // pull that succeeded as failed.
      if (total(result) > 0) {
        await step.sendEvent('request-index', {
          name: 'lyfe/rag.ingest.requested',
          data: { organizationId, requester, patientId: medplumPatientId, batchId },
        });
      }

      return { counts, empty: total(result) === 0 };
    } catch (err) {
      // Reached only once the step has exhausted its retries, so the Task is
      // marked failed for a run that really is over — and the patient-keyed
      // view shows it without anyone opening Inngest.
      await step
        .run('record-failure', () =>
          failTask(medplum, taskId, classify(err), err instanceof Error ? err.message : String(err))
        )
        .catch(() => undefined);
      throw err;
    }
  }
);

/**
 * How many resources a Zus result actually wrote.
 * @param result - The bot's response.
 * @returns The total across every resource type.
 */
function total(result: unknown): number {
  const counts = (result as { counts?: Record<string, number> })?.counts;
  return counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;
}
