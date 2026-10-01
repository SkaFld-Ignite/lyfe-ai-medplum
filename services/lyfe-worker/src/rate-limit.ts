// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { RetryAfterError } from 'inngest';
import { isRateLimitError } from '../../../examples/medplum-provider/bots/shared/batch.ts';

/**
 * Two ceilings every step in this worker runs against, and what to do at each.
 *
 * **Medplum's FHIR quota.** 50,000 units per minute, per user. The importers
 * already respect it where the volume is — writes go through `upsertBatch`,
 * which sends 200-entry transaction bundles and backs off per entry. What was
 * not respected is everything *around* that work: this worker's own Task
 * bookkeeping called `createResource` and `updateResource` bare, with no retry
 * at all. A quota exhausted by the import would then kill the run on the Task
 * write, which is a run failing on its own progress report.
 *
 * Two layers fix it. Short waits are slept in-process by `withMedplum429Retry`,
 * reusing the bots' own helper rather than growing a second one. A 429 that
 * still escapes a step becomes a {@link RetryAfterError}, which hands the wait
 * to Inngest: the run is suspended and rescheduled after the limiter's own
 * reset window, costing nothing and burning no attempt. A rate limit should
 * never be the reason a run ends.
 *
 * **Railway's HTTP ceiling.** Inngest drives each step by calling this server,
 * and Railway's proxy caps any one request at 15 minutes. A step that runs
 * longer is killed mid-flight and surfaces as `HTTP 502 ... no step output was
 * produced`, which tells you nothing about the import. This is the same
 * 15-minute ceiling the AWS Lambda bot runtime had, re-entering through the
 * front door. {@link withStepTimeout} keeps steps under it and fails as a
 * normal retryable error, which Inngest can actually act on.
 */

/** Railway's platform maximum for a single HTTP request. */
export const PLATFORM_REQUEST_CEILING_MS = 15 * 60_000;

/**
 * Longest a single step may run.
 *
 * Three minutes under the platform ceiling, so the failure is ours and legible
 * rather than a 502 from the proxy with no step output attached.
 */
export const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 12 * 60_000);

/** Never reschedule sooner than this, even if the payload asks for it. */
const MIN_RETRY_AFTER_MS = 10_000;

/** Pad past the reset boundary; waking exactly on it tends to draw a second 429. */
const RESET_PAD_MS = 5_000;

/**
 * When the limiter says the quota resets.
 *
 * Medplum reports the window in the error body as
 * `{"_remainingPoints":0,"_msBeforeNext":11240,…}`. Unlike the in-process
 * helper this does not clamp the wait down: a bot sleeping is a bot holding its
 * execution budget open, but a suspended Inngest run costs nothing, so the
 * honest window is better than a short guess that draws another 429.
 * @param err - The rejected operation's error.
 * @returns When to retry, or undefined if the error is not a rate limit.
 */
export function retryAfter(err: unknown): Date | undefined {
  if (!isRateLimitError(err)) {
    return undefined;
  }
  const message = err instanceof Error ? err.message : String(err);
  const match = /_msBeforeNext"?\s*:\s*(\d+)/.exec(message);
  const parsed = match ? Number(match[1]) + RESET_PAD_MS : Number.NaN;
  const waitMs = Number.isFinite(parsed) && parsed > 0 ? parsed : MIN_RETRY_AFTER_MS;
  return new Date(Date.now() + Math.max(MIN_RETRY_AFTER_MS, waitMs));
}

/**
 * Run a step body, turning the two ceilings into outcomes Inngest can act on.
 *
 * A rate limit becomes a `RetryAfterError` carrying the limiter's own reset
 * time. A step that overruns becomes a plain `Error`, so Inngest retries it
 * with backoff instead of the request dying at the proxy.
 * @param label - What the step is doing, for the timeout message.
 * @param op - The step body.
 * @param timeoutMs - Override the default step ceiling.
 * @returns Whatever `op` resolves to.
 */
export async function withStepTimeout<T>(
  label: string,
  op: () => Promise<T>,
  timeoutMs: number = STEP_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${Math.round(timeoutMs / 60_000)}m and was abandoned`)),
          timeoutMs
        );
      }),
    ]);
  } catch (err) {
    const when = retryAfter(err);
    if (when) {
      throw new RetryAfterError(err instanceof Error ? err.message : String(err), when);
    }
    throw err;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
