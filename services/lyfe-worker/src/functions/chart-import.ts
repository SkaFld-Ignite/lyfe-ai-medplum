// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { NonRetriableError } from 'inngest';
import { handler as drchronoHandler } from '../../../../examples/medplum-provider/bots/drchrono-import.ts';
import { botEvent } from '../bot-event.ts';
import { inngest, PER_CLINIC_CONCURRENCY } from '../inngest.ts';
import { getMedplum } from '../medplum.ts';
import { withStepTimeout } from '../rate-limit.ts';
import { attachPatient, completeTask, failTask, setPhase, startTask } from '../task.ts';

/**
 * Import one DrChrono chart.
 *
 * The import itself is the same code the Medplum bot ran — it was always a
 * plain function over a `MedplumClient`, so it moves across untouched. What
 * changes is everything around it: concurrency is keyed per clinic, retries
 * and backoff belong to Inngest, and there is no 15-minute execution ceiling
 * to design around.
 *
 * A FHIR `Task` is still written for every run. Inngest answers "why did forty
 * imports fail"; the Task answers "did this patient import", which is the
 * question the people using the product actually ask. See `task.ts`.
 */
export const chartImport = inngest.createFunction(
  {
    id: 'drchrono-chart-import',
    name: 'DrChrono chart import',
    concurrency: { key: 'event.data.organizationId', limit: PER_CLINIC_CONCURRENCY },
    // Raised from 3. With RetryAfterError a rate limit no longer consumes an
    // attempt usefully — it reschedules — so the budget is there for the
    // failures that are actually worth re-running.
    retries: 6,
  },
  { event: 'lyfe/chart.import.requested' },
  async ({ event, step, runId, logger }) => {
    const { organizationId, requester, drchronoPatientId, withZus, batchId } = event.data;
    const medplum = await getMedplum();
    const organization = { reference: `Organization/${organizationId}` };

    // The Task is opened BEFORE the import, not after it.
    //
    // It used to be created from the import's result, which meant a failed
    // import left no Medplum record at all — invisible on the Imports page,
    // findable only in Inngest. A 104-patient run made that concrete: 40
    // patients were created and only 28 had a Task, so twelve failures were
    // untraceable from the patient-keyed view that exists precisely to answer
    // "what happened to this patient".
    //
    // A chart import does not know its patient yet — the importer finds or
    // creates one — so the Task opens without `for`, carrying the DrChrono id
    // so it is still findable, and the patient is attached once resolved.
    const taskId = await step.run('open-task', async () =>
      withStepTimeout('open-task', async () => {
        const task = await startTask({
          medplum,
          organization,
          code: 'drchrono-import',
          sourceId: drchronoPatientId,
          runId,
          batchId,
        });
        return task.id as string;
      })
    );

    try {
      // The success check lives INSIDE the step, not after it.
      //
      // A throw in the function body retries the whole function, and Inngest
      // replays `import-chart` from its memoized result — so a failed import
      // would rethrow the same cached error three times without ever calling
      // DrChrono again. Throwing inside the step retries the step, which is
      // what a 429 or a timeout actually needs.
      const { patientId, counts } = await step.run('import-chart', async () =>
        withStepTimeout(`chart import ${drchronoPatientId}`, async () => {
          logger.info('importing chart', { drchronoPatientId, organizationId });
          await setPhase(medplum, taskId, 'importing chart');
          const res = await drchronoHandler(
          medplum,
          // The Task opened above is handed to the bot, which reports its phases,
          // its patient and its counts onto it instead of opening a second one.
          botEvent(requester, { action: 'import', drchronoPatientId, taskId })
        );

          if (!res.ok) {
            const message = 'error' in res ? String(res.error) : 'import failed';
            // A chart DrChrono will never return is not worth three attempts.
            // Anything else — a timeout, a 429, a blip — is, and a plain Error
            // lets Inngest retry the step with backoff.
            throw /not found|no patient|invalid/i.test(message) ? new NonRetriableError(message) : new Error(message);
          }

          const id = 'medplumPatientId' in res ? res.medplumPatientId : undefined;
          if (!id) {
            throw new NonRetriableError('Import reported success without a patient id');
          }
          return { patientId: id, counts: ('counts' in res ? res.counts : {}) as Record<string, number> };
        })
      );

      await step.run('complete-task', async () =>
        withStepTimeout('complete-task', async () => {
          await attachPatient(medplum, taskId, patientId);
          await completeTask(medplum, taskId, counts);
        })
      );

      // Sent as its own event rather than awaited inline, so a Zus failure
      // never marks a chart that imported perfectly well as failed, and either
      // half can be retried without the other.
      if (withZus) {
        await step.sendEvent('request-zus', {
          name: 'lyfe/zus.import.requested',
          data: { organizationId, requester, medplumPatientId: patientId, batchId },
        });
      }

      return { patientId, counts };
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
 * Turn a thrown error into the coded reason the Imports page shows.
 *
 * Kept next to the function that produces the failures rather than in the
 * shared task module, because the classification is about *these* imports.
 * @param err - Whatever was thrown.
 * @returns A coded reason.
 */
export function classify(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/429|rate.?limit/i.test(message)) {
    return 'rate-limited';
  }
  if (/401|403|token|unauthor/i.test(message)) {
    return 'auth-expired';
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return 'timeout';
  }
  if (/5\d\d|server error/i.test(message)) {
    return 'server-error';
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(message)) {
    return 'network-error';
  }
  if (/404|not found/i.test(message)) {
    return 'not-found';
  }
  return 'unknown';
}

export { failTask };
