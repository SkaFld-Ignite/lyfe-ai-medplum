// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { handler as summaryHandler } from '../../../../examples/medplum-provider/bots/patient-ai-summary.ts';
import { botEvent } from '../bot-event.ts';
import { inngest, PER_CLINIC_CONCURRENCY } from '../inngest.ts';
import { getMedplum } from '../medplum.ts';
import { withStepTimeout } from '../rate-limit.ts';

/**
 * Generate one patient's AI summary.
 *
 * The last link of the import chain: chart → documents indexed → summary. The
 * generator itself already existed as `bots/patient-ai-summary.ts` and is
 * unchanged; what was missing was anything that *calls* it. Until now it only
 * ever ran when a provider asked, or — on a Subscription delivery — marked the
 * stored `Composition` `preliminary` without regenerating it. So the normal
 * outcome of importing a patient was a chart with no summary and no prospect of
 * one until somebody clicked.
 *
 * ## Invoked in-process, not through Medplum
 *
 * `summaryHandler` is imported and handed a `BotEvent`, exactly as
 * `chart-import.ts` does with `drchronoHandler` and `zus-import.ts` with
 * `zusHandler`. The alternative — `medplum.executeBot(...)` against the
 * deployed `lyfe-patient-ai-summary` — would put this one call back under the
 * bot runtime's ceilings and give it a second, divergent deployment to keep in
 * step. Running it here means the summary shares this worker's step budget, its
 * 429 handling and its retries with everything else in the chain, and there is
 * exactly one copy of the code that matters.
 *
 * The deployed bot stays deployed, because it still serves the path this
 * function does not: the `Subscription` that marks a summary stale when the
 * chart changes underneath it.
 *
 * ## No Task
 *
 * Deliberately, and it is the one place in this worker that opens none.
 *
 * Three reasons. The summary's state is already a FHIR fact — the
 * `Composition` either exists or does not, and its `status` is `final` or
 * `preliminary` — so a Task would be a second, lossier record of something the
 * chart already answers. A Task per summary would also put a second row on the
 * Imports page for every patient imported, and a *failed* one of those rows
 * reads as a failed import, which is precisely the confusion this chain must
 * not create. And debouncing discards events: a Task opened by whichever
 * request lost the window would never be closed by anybody.
 *
 * So a summary that cannot be produced leaves the chart exactly as it was, with
 * no summary yet. That is the correct degradation, and it is visible where it
 * belongs — in Inngest for the operator, and as an absent `Composition` for the
 * provider.
 */

/**
 * How long to wait for a patient's indexing to settle before summarising.
 *
 * Ten minutes, and the number comes from the gap the chain actually has.
 *
 * A patient is indexed twice in the normal case. The chart import emits its
 * index request the moment the chart lands; the Zus import emits a second one
 * when the network record lands. For a patient **already enrolled** with Zus —
 * the common case, and the only one where the gap is short — that second
 * request is one `pull-record` step behind the first, so the two indexing runs
 * finish within a few minutes of each other. Re-indexing re-extracts and
 * re-embeds every document, so the second run is the slower of the two, which
 * stretches that gap rather than closing it; ten minutes covers it with room
 * for a patient carrying several large scans.
 *
 * Shorter and the common import spends two model calls where one would do, the
 * first of them obsolete before anyone could read it. Longer buys nothing: the
 * only thing still to come after the second index is a **fresh enrolment**,
 * whose network record arrives on the 30m/2h/6h ladder in `zus-import.ts` and
 * is therefore hours away, not minutes. That one deliberately falls outside the
 * window and produces a second summary when it lands — which is right, because
 * by then the chart genuinely has new content in it.
 *
 * Nobody is watching a progress bar for this. The summary is read when a
 * provider opens the chart, which is minutes-to-days after an import, so trading
 * ten minutes of latency for halving the model calls is the right way round.
 */
export const SUMMARY_DEBOUNCE_PERIOD = '10m';

/**
 * Ceiling on how long debouncing may keep deferring a summary.
 *
 * Each new request inside the window restarts it, so without a cap a patient
 * whose documents keep arriving in waves could have their summary pushed back
 * indefinitely — the classic debounce failure, and the one that turns "the
 * summary is coming" into "the summary never came". Thirty minutes is three
 * windows: long enough that a normal import never reaches it, short enough that
 * reaching it is still the same visit.
 */
export const SUMMARY_DEBOUNCE_TIMEOUT = '30m';

/**
 * Failures that mean "no summary yet" rather than "something is broken".
 *
 * The distinction decides whether a run ends green or red, so it is listed
 * rather than guessed at. Everything here is a *configuration or data* fact
 * that no number of retries changes: the project is not carrying the `ai`
 * feature, no model credentials are installed, the requester is not scoped to a
 * clinic, the patient has since been deleted. Each one is reported and the run
 * closes cleanly, because a thousand red runs saying "this project has no AI
 * enabled" is noise that buries the failures worth looking at.
 *
 * Anything *not* matched here — a 5xx from the model, a malformed completion, a
 * dropped connection — is thrown, so Inngest retries it with backoff. That is
 * the whole point of the split: the retryable set is whatever is left over.
 */
const UNAVAILABLE_PATTERNS = [
  /\bai\b.*feature|feature.*\bai\b/i,
  /api key|OPENAI_API_KEY|LLM_BASE_URL/i,
  /not configured|not enabled|not scoped to an organization/i,
  /\b404\b|not found/i,
];

/**
 * Is this failure one to report and move on from?
 * @param message - The reason the summary bot gave.
 * @returns True when retrying cannot help and the run should close cleanly.
 */
export function isSummaryUnavailable(message: string): boolean {
  return UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export const patientSummary = inngest.createFunction(
  {
    id: 'patient-ai-summary',
    name: 'Patient AI summary',
    concurrency: { key: 'event.data.organizationId', limit: PER_CLINIC_CONCURRENCY },
    // Keyed on the patient, so the chart-driven and network-driven index
    // completions of one patient collapse into a single run while two different
    // patients importing at the same moment do not wait on each other.
    //
    // Inngest's own debounce rather than a lock of our own. A hand-rolled one
    // would need somewhere durable to keep "when did this patient last get a
    // summary" — a Medplum resource, or a row — and would then have to get
    // expiry, crash recovery and the read-modify-write race right. Inngest
    // already holds that state for us and keeps the *last* event of the window,
    // which is also the one we want: the request that arrived after the most
    // recent indexing run is the one whose chart is most complete.
    debounce: { key: 'event.data.patientId', period: SUMMARY_DEBOUNCE_PERIOD, timeout: SUMMARY_DEBOUNCE_TIMEOUT },
    // Four, not the importers' six. One model call is a much narrower failure
    // surface than a multi-hour network pull, and a rate limit still costs no
    // attempt — `withStepTimeout` turns it into a `RetryAfterError`.
    retries: 4,
  },
  { event: 'lyfe/summary.generate.requested' },
  async ({ event, step, logger }) => {
    const { organizationId, requester, patientId, reason } = event.data;
    const medplum = await getMedplum();

    logger.info('generating patient summary', { patientId, organizationId, reason });

    // The ok/not-ok decision lives INSIDE the step, for the reason
    // `chart-import.ts` records at length: a throw in the function body retries
    // the whole function and Inngest replays this step from its memoised
    // result, so the same cached error would be rethrown without the model ever
    // being called again. Throwing in here retries the call.
    const outcome = await step.run('generate-summary', async () =>
      withStepTimeout(`ai summary ${patientId}`, async () => {
        // The bot returns its failures rather than throwing them, so there is
        // no try/catch to write here — `res.ok` is the error channel.
        const res = await summaryHandler(medplum, botEvent(requester, { patientId, mode: 'generate' as const }));
        if (res.ok) {
          return { ok: true as const, compositionId: res.compositionId, status: res.status };
        }
        const message = res.error ?? 'The summary bot reported failure without a reason';
        if (isSummaryUnavailable(message)) {
          return { ok: false as const, reason: message };
        }
        throw new Error(message);
      })
    );

    if (!outcome.ok) {
      // Not a throw. The import succeeded, the index succeeded, and the patient
      // simply has no summary yet — which is a sentence, not an incident.
      logger.warn('no summary generated', { patientId, reason: outcome.reason });
      return { patientId, skipped: true, reason: outcome.reason };
    }

    return { patientId, compositionId: outcome.compositionId, status: outcome.status };
  }
);
