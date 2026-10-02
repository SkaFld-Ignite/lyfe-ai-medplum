// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { ProviderBrake } from '../../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';
import {
  getProviderBreakerStore,
  openBrakes,
} from '../../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';

/**
 * Wait out a provider's throttle without spending a retry on it.
 *
 * ## Why this exists when `RetryAfterError` already works
 *
 * It does work. A 429 that escapes a step becomes a `RetryAfterError` carrying
 * the provider's own instant, and Inngest reschedules the run for then. That
 * alone fixes the headline failure, because the budget stops being the thing
 * that decides whether a chart imports.
 *
 * But it is a *retry*, and retries are finite. `retries: 6` means six throttles
 * and the run is over, and the work is lost in exactly the way this whole issue
 * is about. More to the point, it is a retry spent learning something already
 * known: the first run through found the brake, every other run for that clinic
 * can read it, and making the call anyway to be told so is both a wasted
 * attempt and another request into a provider that is refusing them.
 *
 * So this is the cheap path and `RetryAfterError` is the net. A run that finds
 * the brake already on sleeps until it lifts, costing no attempt and holding no
 * process open. A run that *discovers* the throttle — somebody has to be first
 * — takes the `RetryAfterError` route. Between them, work is held rather than
 * dropped.
 *
 * ## The replay subtlety, and why the loop is written this way
 *
 * Inngest memoises steps by id. A single `step.run('check-brake', …)` would be
 * answered from the memo on every replay, so a run that held once and woke to
 * find the provider still throttled would never look again. Hence a bounded
 * loop with an **indexed step id** per iteration: each pass is a genuinely new
 * step and a genuinely fresh read. It is the same shape `zus-import.ts` already
 * uses for its 30m/2h/6h network ladder, for the same reason.
 *
 * The bound matters too. {@link MAX_HOLDS} passes of up to twelve hours each is
 * a long time to be patient, and it is still finite — a provider that never
 * recovers must eventually surface as a failure somebody looks at, not as a run
 * that waits forever and reports nothing.
 */

/** How many times a run will re-check and keep waiting before giving up on patience. */
export const MAX_HOLDS = 8;

/**
 * Spread on each wake.
 *
 * Every run held against one clinic is holding against the *same* instant, so
 * without this they all wake together and the first thing the provider sees
 * after its window is the same burst that closed it. Inngest's per-clinic
 * concurrency of five already blunts that; a few seconds of spread finishes the
 * job. Random rather than derived: Inngest records the wake time when the sleep
 * is planned, so a replay reuses the recorded instant and the non-determinism
 * never reaches the memo.
 */
const WAKE_JITTER_MS = 15_000;

/**
 * The slice of Inngest's step tooling this needs, so a test can hand in a fake.
 *
 * Narrowed to `string | null` rather than generic on purpose. Inngest's real
 * `step.run` returns `Jsonify<T>`, because a step's output is serialised into
 * the run's state and comes back parsed — so a generic signature here is not
 * merely less convenient, it is a lie about what survives a replay. Saying
 * `string | null` out loud keeps the two in agreement and is the reason the
 * brake instant travels as an ISO string and not a `Date`: a `Date` put into a
 * step comes back as a string, and the code that looked fine in a unit test
 * fails on the first replay in production.
 */
export interface HoldSteps {
  run(id: string, body: () => Promise<string | null>): Promise<string | null>;
  sleepUntil(id: string, time: Date): Promise<void>;
}

export interface HoldProps {
  /** Integration key — `drchrono`, `zus`, or whatever the next one is called. */
  provider: string;
  /** The clinic whose quota is at stake. */
  organizationId: string;
  /** Inngest's step tooling. */
  step: HoldSteps;
  /**
   * Called once per hold, with the instant calls may resume.
   *
   * This is how a held run stops looking like a stuck one. The importers pass a
   * `setPhase` on the run's Task, so the Imports page says "held until 14:05"
   * instead of sitting on "importing chart" for forty-five minutes — which is
   * indistinguishable from broken, and was being read as broken.
   */
  onHold?: (until: Date) => Promise<void>;
  /** Logged to, when there is one. */
  logger?: { info: (msg: string, meta?: unknown) => void };
}

/**
 * Hold this run while the provider is refusing this clinic.
 *
 * Returns immediately — and in the overwhelmingly common case, after one cheap
 * read — when there is no brake on.
 * @param props - The hold.
 * @returns How many times the run waited. Zero is the normal answer.
 */
export async function holdWhileRateLimited(props: HoldProps): Promise<number> {
  const { provider, organizationId, step } = props;
  let holds = 0;

  for (let attempt = 0; attempt < MAX_HOLDS; attempt++) {
    // Indexed, so each pass is a fresh step rather than a memoised answer.
    const untilIso = await step.run(`check-rate-limit-${attempt}`, async () => {
      try {
        const until = await getProviderBreakerStore().openUntil(provider, organizationId);
        return until && until.getTime() > Date.now() ? until.toISOString() : null;
      } catch {
        // Fail open, exactly as the HTTP guard does. The brake is protection on
        // top of a call that would otherwise just be made; a database that
        // cannot be read is not a reason to refuse to import a patient.
        return null;
      }
    });

    if (!untilIso) {
      return holds;
    }

    const wakeAt = new Date(Date.parse(untilIso) + Math.floor(Math.random() * WAKE_JITTER_MS));
    props.logger?.info('provider rate limited — holding', {
      provider,
      organizationId,
      until: untilIso,
      hold: attempt + 1,
    });
    if (props.onHold) {
      await step.run(`report-hold-${attempt}`, async () => {
        await props.onHold?.(new Date(untilIso));
        return null;
      });
    }
    await step.sleepUntil(`hold-${attempt}`, wakeAt);
    holds++;
  }

  // Patience spent. Nothing is thrown: the import runs, and if the provider is
  // still refusing it takes the `RetryAfterError` route and its six attempts.
  // Giving up on waiting is not the same as giving up.
  props.logger?.info('still rate limited after the hold budget — attempting anyway', { provider, organizationId });
  return holds;
}

/**
 * A phase string for a held run, as the Imports page shows it.
 *
 * Says the provider and the time, because "held" on its own prompts the exact
 * question it should have answered. Local time, because the person reading it
 * is deciding whether to wait or go to lunch.
 * @param provider - Integration key.
 * @param until - When calls resume.
 * @returns The phase text.
 */
export function heldPhase(provider: string, until: Date): string {
  return `held — ${provider} is rate limiting this clinic until ${until.toISOString()}`;
}

/**
 * Every brake currently open, for `/health`.
 *
 * Re-exported here rather than imported from the bots at the call site so the
 * worker has one place that knows about provider brakes.
 * @returns The open brakes.
 */
export async function openProviderBrakes(): Promise<ProviderBrake[]> {
  return openBrakes();
}
