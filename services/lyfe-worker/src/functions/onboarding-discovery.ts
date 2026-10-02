// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { NonRetriableError } from 'inngest';
import { handler as drchronoSearchHandler } from '../../../../examples/medplum-provider/bots/drchrono-search.ts';
import { readCredentialRecord } from '../../../../examples/medplum-provider/bots/shared/credentials.ts';
import { DRCHRONO_PROVIDER } from '../../../../examples/medplum-provider/bots/shared/drchrono.ts';
import { botEvent } from '../bot-event.ts';
import type { DiscoveryConfig } from '../discovery/config.ts';
import { discoveryWindow, listDiscoveryConfigs, readDiscoveryConfig } from '../discovery/config.ts';
import {
  discoveryBatchId,
  findImportedPatientIds,
  findQueuedSourceIds,
  recordQueuedSourceIds,
} from '../discovery/existing.ts';
import { inngest } from '../inngest.ts';
import { getMedplum } from '../medplum.ts';
import { heldPhase, holdWhileRateLimited } from '../providers/hold.ts';
import { withStepTimeout } from '../rate-limit.ts';
import { completeTask, failTask, setPhase, startTask } from '../task.ts';
import { requesterOrganizationProblem } from '../webhooks/tenant-config.ts';
import { classify } from './chart-import.ts';

/**
 * The person opening DrChrono's calendar every morning, as a scheduled job.
 *
 * The routine being replaced, in full: open the calendar, read every
 * appointment's free-text Reason, keep the ones that say "new patient", skip
 * the faded (cancelled or rescheduled) ones, then search that patient's date of
 * birth in LyfeAI and click Import.
 *
 * Almost all of that selection already existed in `bots/drchrono-search.ts` —
 * blocked time dropped, cancelled statuses excluded, switched-off offices and
 * providers filtered out of the clinic's Directory. Two things were missing:
 * the reason filter, which is now `matchesReason` in that same bot, and
 * somebody to press the button. This is the somebody.
 *
 * ## It builds no pipeline of its own
 *
 * The only thing this emits is `lyfe/chart.import.requested`, the same event the
 * onboarding screen's Import button produces. Everything after that — the chart
 * import, the Zus pull, the document index, the AI summary — happens because
 * that chain already exists. A parallel "automated onboarding" path would be a
 * second place for the idempotency rules, the retry budget and the per-clinic
 * concurrency to drift, and a chart imported by the schedule would slowly stop
 * resembling one imported by hand.
 *
 * ## It never removes anything
 *
 * A cancelled appointment is a reason not to import a patient. It is not a
 * reason to delete one, deactivate one, or touch a chart that already exists.
 * Scheduling rows change constantly and clinical data does not get to follow
 * them; the pass reports what it skipped and acts on none of it. There is no
 * code path here that deletes or deactivates a resource, and that is deliberate
 * rather than incidental.
 *
 * ## Two functions, not one
 *
 * The cron finds the clinics; a separate event-triggered function does one
 * clinic's work. That is what keeps one clinic's expired DrChrono token, or one
 * clinic's forty-five-minute throttle, from being the reason four other clinics
 * got no onboarding that morning — and it makes a single clinic's pass
 * replayable without re-running everybody's.
 */

/**
 * When the pass runs.
 *
 * Configurable because the right hour is a clinic-operations question and this
 * repo should not need a release to answer it. The default is 05:00 Pacific:
 * before the first appointment of the day, late enough that overnight
 * scheduling changes are in, and in the clinic's own zone rather than UTC so it
 * does not wander by an hour twice a year. Inngest's own `TZ=` prefix does that
 * arithmetic.
 *
 * Note this is a *schedule*, not a window. How far ahead a clinic looks is
 * `discoveryLookaheadDays` on its own record, so two clinics can share this
 * cron and still cover different horizons.
 */
const DISCOVERY_CRON = process.env.ONBOARDING_DISCOVERY_CRON ?? 'TZ=America/Los_Angeles 0 5 * * *';

/**
 * One pass per clinic at a time, and never more than one clinic's worth of
 * scheduling work at once.
 *
 * Deliberately far below the plan ceiling. Inngest refused a registration at
 * `limit: 20` against a plan limit of 5 (see `inngest.ts`), and there is no
 * reason to go near it here: a discovery pass is one DrChrono scan and a
 * handful of event sends, and running two of them for the same clinic
 * concurrently would only mean both discovering the same patients.
 */
const DISCOVERY_CONCURRENCY = 1;

/** What one pass counted, for the Task and for the run's return value. */
interface DiscoveryOutcome {
  scannedAppointments: number;
  excludedByStatus: number;
  excludedByReason: number;
  skippedByDirectory: number;
  alreadyImported: number;
  alreadyQueued: number;
  deferredByCap: number;
  queued: number;
}

/**
 * Find every clinic that has switched the pass on, and ask for its pass.
 *
 * Reads only the plaintext config bucket of the DrChrono credential records, so
 * the daily cost of having this deployed with nobody enabled is one Medplum
 * search and nothing else. With nobody enabled it sends no events at all, which
 * is the state this ships in.
 */
export const onboardingDiscoverySchedule = inngest.createFunction(
  {
    id: 'onboarding-discovery-schedule',
    name: 'New-patient discovery schedule',
    concurrency: { limit: DISCOVERY_CONCURRENCY },
    retries: 2,
  },
  { cron: DISCOVERY_CRON },
  async ({ step, logger }) => {
    const medplum = await getMedplum();

    const organizationIds = await step.run('list-enabled-clinics', async () =>
      withStepTimeout('list-enabled-clinics', async () => {
        const configs = await listDiscoveryConfigs(medplum);
        return configs.map((config) => config.organizationId);
      })
    );

    // Returned rather than sent as an empty batch: `inngest.send([])` is an
    // error, and more to the point "no clinic has this switched on" is the
    // normal state and should read as a completed run with zero clinics, not as
    // a failed one.
    if (organizationIds.length === 0) {
      logger.info('no clinic has new-patient discovery enabled');
      return { clinics: 0 };
    }

    await step.sendEvent(
      'request-discovery',
      organizationIds.map((organizationId) => ({
        name: 'lyfe/onboarding.discovery.requested' as const,
        data: { organizationId, reason: 'scheduled' },
      }))
    );
    return { clinics: organizationIds.length };
  }
);

/**
 * One clinic's pass.
 *
 * Also the unit an operator replays: sending `lyfe/onboarding.discovery.requested`
 * for one organization re-runs exactly this, and because the batch id is derived
 * from the clinic and the window rather than from the clock, a replay converges
 * on the same set rather than queueing everything twice.
 */
export const onboardingDiscovery = inngest.createFunction(
  {
    id: 'onboarding-discovery',
    name: 'New-patient discovery',
    concurrency: { key: 'event.data.organizationId', limit: DISCOVERY_CONCURRENCY },
    retries: 3,
  },
  { event: 'lyfe/onboarding.discovery.requested' },
  async ({ event, step, runId, logger }) => {
    const { organizationId } = event.data;
    const medplum = await getMedplum();
    const organization = { reference: `Organization/${organizationId}` } as const;

    // The enable check is re-done here, not inherited from the cron.
    //
    // The cron filtered on it, but this function is also reachable by anyone
    // who can send an event, and "a disabled clinic is not touched at all" has
    // to be true of the function that does the touching. Checked before the
    // Task is opened, too: a clinic that has not switched this on should not
    // find rows about it on its Imports page.
    const config = await step.run('read-config', async () =>
      withStepTimeout('read-config', async () => {
        const record = await readCredentialRecord({ medplum, organization, integration: DRCHRONO_PROVIDER });
        return readDiscoveryConfig({ organizationId, record });
      })
    );

    if (!config.enabled) {
      logger.info('new-patient discovery is not enabled for this clinic', { organizationId });
      return { skipped: 'disabled' as const, organizationId };
    }

    const window = discoveryWindow({
      now: new Date(await step.run('now', async () => new Date().toISOString())),
      timeZone: config.timeZone,
      lookaheadDays: config.lookaheadDays,
    });
    const batchId = discoveryBatchId({ organizationId, start: window.start });

    // A profile that cannot act for this clinic is a configuration error, not a
    // transient one, so it is checked before any Task is opened and refused
    // without retries. The same check the inbound webhook receiver makes, from
    // the same function, because two implementations of "may this profile act
    // for this clinic" is how one of them ends up more permissive.
    const requester = config.requester;
    if (!requester) {
      throw new NonRetriableError(
        `${organization.reference} has new-patient discovery enabled but no discoveryRequester ` +
          '(or webhookRequester) saved; an unattended run needs a profile to act as'
      );
    }
    const problem = await step.run('check-requester', async () =>
      withStepTimeout(
        'check-requester',
        async () =>
          (await requesterOrganizationProblem({
            medplum,
            requester,
            organizationId,
            field: 'discoveryRequester',
          })) ?? null
      )
    );
    if (problem) {
      throw new NonRetriableError(problem);
    }

    const taskId = await step.run('open-task', async () =>
      withStepTimeout('open-task', async () => {
        const task = await startTask({
          medplum,
          organization,
          code: 'onboarding-discovery',
          // No `sourceId`: a discovery pass has no patient of its own, it is
          // the thing that decides who the patients are. The window it covered
          // is in the summary this Task completes with, and the ids it queues
          // are stamped on afterwards by `recordQueuedSourceIds`.
          runId,
          batchId,
        });
        return task.id as string;
      })
    );

    try {
      // Before the first DrChrono call, not after the first refusal. A pass
      // that walks into an open throttle both fails itself and deepens the
      // throttle for the imports queued behind it.
      await holdWhileRateLimited({
        provider: DRCHRONO_PROVIDER,
        organizationId,
        step,
        logger,
        onHold: async (until) => setPhase(medplum, taskId, heldPhase(DRCHRONO_PROVIDER, until)),
      });

      const preview = await step.run('scan-appointments', async () =>
        withStepTimeout(`discovery scan ${window.start}..${window.end}`, async () => {
          await setPhase(medplum, taskId, `scanning ${window.start} to ${window.end}`);
          // The search bot's own handler, in process — not a reimplementation
          // of DrChrono access. It resolves the clinic from the requester,
          // decrypts that clinic's credentials, refreshes a rotated token and
          // routes every call through the provider brake, none of which should
          // exist twice.
          const res = (await drchronoSearchHandler(
            medplum,
            botEvent(requester, {
              action: 'preview',
              start: window.start,
              end: window.end,
              reason: config.reasonPhrase,
            })
          )) as PreviewResponse;

          // The bot reports failures in-band so a configuration message
          // survives instead of becoming a bare 500. Out here that has to
          // become a throw, or a clinic whose DrChrono token expired would get
          // a cheerful "scanned 0 appointments" every morning.
          if ('ok' in res && res.ok === false) {
            throw new Error(res.error ?? 'DrChrono preview failed');
          }
          return res;
        })
      );

      const candidates = (preview.results ?? []).map((patient) => String(patient.id));

      const { toQueue, alreadyImported, alreadyQueued, deferredByCap } = await step.run('drop-known', async () =>
        withStepTimeout('drop-known', async () => {
          const imported = await findImportedPatientIds({ medplum, organizationId, drchronoPatientIds: candidates });
          const queued = await findQueuedSourceIds({ medplum, batchId });
          const fresh = candidates.filter((id) => !imported.has(id) && !queued.has(id));
          return {
            // The cap is applied after the known patients are dropped, so a
            // clinic with forty returning patients and three new ones queues
            // the three rather than spending its budget deciding to skip forty.
            toQueue: fresh.slice(0, config.maxPatients),
            alreadyImported: candidates.filter((id) => imported.has(id)).length,
            alreadyQueued: candidates.filter((id) => !imported.has(id) && queued.has(id)).length,
            deferredByCap: Math.max(0, fresh.length - config.maxPatients),
          };
        })
      );

      if (toQueue.length > 0) {
        // One send, and then nothing: the imports are Inngest's from here.
        //
        // This is not a burst at DrChrono even when it is a burst of events.
        // `chartImport` is capped at five concurrent runs per clinic and every
        // one of them reads the provider brake before its first call, so a
        // window's worth of work arrives at DrChrono as a queue rather than as
        // a stampede — which is exactly what `maxPatients` is a second, blunter
        // bound on for the day somebody opens a thirty-day window.
        await step.sendEvent(
          'request-imports',
          toQueue.map((drchronoPatientId) => ({
            name: 'lyfe/chart.import.requested' as const,
            data: { organizationId, requester, drchronoPatientId, batchId },
          }))
        );

        // Written immediately after the hand-off, and this is what makes a
        // re-run safe in the minutes before the imports start. The Tasks that
        // would otherwise answer "has this patient been queued" are opened by
        // the import function, which Inngest may not reach for minutes; until
        // then the only record that these patients were asked for is this one.
        await step.run('record-queued', async () =>
          withStepTimeout('record-queued', async () =>
            recordQueuedSourceIds({ medplum, taskId, drchronoPatientIds: toQueue })
          )
        );
      }

      const outcome: DiscoveryOutcome = {
        scannedAppointments: preview.scannedAppointments ?? 0,
        excludedByStatus: preview.excludedByStatus ?? 0,
        excludedByReason: preview.excludedByReason ?? 0,
        skippedByDirectory: preview.skippedByDirectory ?? 0,
        alreadyImported,
        alreadyQueued,
        deferredByCap,
        queued: toQueue.length,
      };

      await step.run('complete-task', async () =>
        withStepTimeout('complete-task', async () =>
          completeTask(medplum, taskId, { ...outcome }, summarise(config, window, outcome))
        )
      );

      return { organizationId, batchId, ...outcome };
    } catch (err) {
      await step
        .run('record-failure', () =>
          failTask(medplum, taskId, classify(err), err instanceof Error ? err.message : String(err))
        )
        .catch(() => undefined);
      throw err;
    }
  }
);

/** What the search bot answers a `preview` with, or why it would not. */
interface PreviewResponse {
  ok?: boolean;
  error?: string;
  scannedAppointments?: number;
  results?: { id: number | string }[];
  skippedByDirectory?: number;
  excludedByStatus?: number;
  excludedByReason?: number;
}

/**
 * One sentence a person can read on the Imports page.
 *
 * Every number the pass acted on, including the zeros. `countsToOutput` drops
 * zeros from the Task's outputs, which is right for an import's resource counts
 * and wrong here: "queued 0" is the single most important thing a morning's
 * discovery run can say, and a Task that merely says "complete" is
 * indistinguishable from one that never looked. The phrase is included because
 * the first question anybody asks about a run that found nobody is whether it
 * was looking for the right words.
 * @param config - The clinic's settings.
 * @param window - The dates scanned.
 * @param window.start - First date scanned.
 * @param window.end - Last date scanned.
 * @param outcome - What the pass counted.
 * @returns The business status text.
 */
export function summarise(
  config: Pick<DiscoveryConfig, 'reasonPhrase' | 'maxPatients'>,
  window: { start: string; end: string },
  outcome: DiscoveryOutcome
): string {
  const parts = [
    `${window.start}..${window.end}`,
    `scanned ${outcome.scannedAppointments}`,
    `queued ${outcome.queued}`,
    `reason "${config.reasonPhrase}" excluded ${outcome.excludedByReason}`,
    `cancelled ${outcome.excludedByStatus}`,
    `off-directory ${outcome.skippedByDirectory}`,
    `already imported ${outcome.alreadyImported}`,
    `already queued ${outcome.alreadyQueued}`,
  ];
  if (outcome.deferredByCap > 0) {
    parts.push(`${outcome.deferredByCap} left for the next pass (cap ${config.maxPatients})`);
  }
  return parts.join(' · ');
}
