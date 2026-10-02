// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One clinic, one provider, one brake.
 *
 * ## The failure this exists for
 *
 * A 33-patient bulk import ran on 2026-10-02. Thirteen of the thirty-three
 * failed on DrChrono 429s. Each one retried for about twenty minutes on its
 * own private ladder, gave up, and was written to the Imports page as failed —
 * thirteen patients dropped. Earlier the same morning, repeated `preview`
 * calls had already put the practice into a forty-five minute throttle, which
 * DrChrono said out loud: `Expected available in 2710.0 seconds`.
 *
 * Two things were wrong, and they compound.
 *
 * **Nobody listened to the provider.** 2710 seconds is forty-five minutes. The
 * entire retry budget was twenty. No arrangement of retries could have
 * succeeded, and the one number that would have told us so was discarded —
 * `drchrono-import.ts` drained the 429 body to free the socket and never read
 * it.
 *
 * **Nobody told anybody else.** Thirty-three runs each discovered the throttle
 * independently, and each discovered it by making the call that deepens it. A
 * rate limit is the one failure where retrying is not merely wasteful, it is
 * the cause.
 *
 * ## What this does instead
 *
 * The first 429 for a clinic **opens a brake** on that `(provider, clinic)`
 * pair, holding the provider's own stated reset time. Every other call for that
 * pair then fails *without touching the network* until the window passes. The
 * work is not dropped: the caller gets a {@link ProviderRateLimitError} with
 * `retryAt` on it, and the layer that owns durability — Inngest, in this
 * repo — suspends the run until then and resumes it.
 *
 * So: stop calling, hold the work, resume together when the provider says the
 * window has cleared. Which is what was asked for.
 *
 * ## Three things it deliberately is not
 *
 * **It is not per-process.** An in-process `Map` would brake the thirty-three
 * runs sharing one worker, and nothing else. {@link setProviderBreakerStore}
 * is where a durable, shared implementation is installed — the worker installs
 * a Postgres-backed one — and the in-process map below is only the fallback
 * for when there is no shared store, which is better than no brake at all.
 *
 * **It is not global across clinics.** The key is `(provider, organizationId)`.
 * A clinic's DrChrono quota is its own; clinic A exhausting theirs must not
 * stop clinic B importing, and a global brake is the easy wrong version of
 * this.
 *
 * **It is not DrChrono.** There is no provider name anywhere in this file
 * except as a string a caller passes. {@link parseRateLimitHint} reads
 * `Retry-After`, the `RateLimit-*` family and a plain-English "available in N
 * seconds" — all of which are conventions, not vendors. A third EHR gets this
 * behaviour by routing its calls through {@link guardProviderCall}, and that is
 * the whole integration.
 */

/** Never hold for less than this, even if the provider asks for less. */
const MIN_HOLD_MS = 1_000;

/**
 * Longest a provider may be believed.
 *
 * A malformed header or a provider having a bad day must not be able to pause
 * a clinic's imports for a week. Twelve hours is far past any real throttle
 * window and still bounded.
 */
const MAX_HOLD_MS = 12 * 60 * 60_000;

/**
 * How long to hold when the provider refuses without saying for how long.
 *
 * A 429 with no hint at all is the uninformative case, and the cost of the two
 * guesses is asymmetric: too short and we go straight back to hammering, which
 * is the bug; too long and a run waits a few minutes it did not have to. Sixty
 * seconds errs toward the cheap mistake.
 */
export const DEFAULT_HOLD_MS = 60_000;

/**
 * Pad past the stated boundary.
 *
 * Waking exactly on a limiter's reset tends to draw a second 429 — the same
 * five seconds `rate-limit.ts` already pads Medplum's window by, for the same
 * reason.
 */
const HOLD_PAD_MS = 5_000;

/**
 * Below this, wait in-process rather than unwinding the whole run.
 *
 * This mirrors the two-layer split `rate-limit.ts` already describes for
 * Medplum: short waits are slept where they happen, because tearing a run down
 * and rebuilding it costs more than the wait; long waits are handed upward,
 * because a process sleeping is a process held open and a suspended Inngest run
 * is free.
 *
 * The brake is opened either way. A caller sleeping thirty seconds in-process
 * must still stop every *other* run for that clinic from calling during those
 * thirty seconds, which is the entire point.
 */
export const INLINE_WAIT_CEILING_MS = 30_000;

/** Attempts a guarded call makes before giving up and handing the wait upward. */
const MAX_INLINE_ATTEMPTS = 2;

/**
 * A provider refused, and said when to come back.
 *
 * Carries `retryAt` rather than a duration because the value travels: it is
 * read by `rate-limit.ts` and turned into an Inngest `RetryAfterError`, and an
 * absolute instant survives that trip without anybody having to remember when
 * the clock started.
 */
export class ProviderRateLimitError extends Error {
  /** Integration key, e.g. `drchrono`, `zus`. */
  readonly provider: string;
  /** The clinic whose quota is exhausted — bare id, not a reference. */
  readonly organizationId: string;
  /** When the provider said it would be available again. */
  readonly retryAt: Date;

  constructor(props: { provider: string; organizationId: string; retryAt: Date; detail?: string }) {
    const seconds = Math.max(0, Math.round((props.retryAt.getTime() - Date.now()) / 1000));
    super(
      `${props.provider} is rate limiting this clinic for another ${seconds}s ` +
        `(until ${props.retryAt.toISOString()})${props.detail ? ` — ${props.detail}` : ''}`
    );
    this.name = 'ProviderRateLimitError';
    this.provider = props.provider;
    this.organizationId = props.organizationId;
    this.retryAt = props.retryAt;
  }
}

/**
 * Whether an error is a provider brake, across module instances.
 *
 * `instanceof` is not reliable here. The bots are loaded by the worker through
 * a relative path and by Medplum's bot runtime as a bundle, and a duplicated
 * module means a duplicated class identity — a check that silently returns
 * false for the exact error it was written for. The name is stable in a way the
 * prototype chain is not.
 * @param err - Whatever was thrown.
 * @returns True when it is a {@link ProviderRateLimitError}.
 */
export function isProviderRateLimitError(err: unknown): err is ProviderRateLimitError {
  return (
    err instanceof Error &&
    err.name === 'ProviderRateLimitError' &&
    (err as ProviderRateLimitError).retryAt instanceof Date
  );
}

/** One open brake, as `/health` reports it. */
export interface ProviderBrake {
  provider: string;
  organizationId: string;
  /** When calls may resume. */
  openUntil: Date;
  /** Why, in a form safe to show an operator. Never carries a response body. */
  reason: string;
}

/**
 * Where brakes are kept.
 *
 * Deliberately three methods and no more. Anything richer — counters, windows,
 * token buckets — would be this module deciding a rate, and this module does
 * not decide rates. The provider does. All that is stored is "refused until
 * when, and why".
 */
export interface ProviderBreakerStore {
  /**
   * When this pair may be called again.
   * @param provider - Integration key.
   * @param organizationId - The clinic.
   * @returns The instant, or undefined when there is no brake.
   */
  openUntil(provider: string, organizationId: string): Promise<Date | undefined>;
  /**
   * Record a refusal.
   *
   * Implementations must keep the **later** of the stored and incoming
   * instants. Two runs reporting the same throttle should not let the second,
   * computed a moment earlier, shorten the hold.
   * @param brake - The refusal.
   */
  open(brake: ProviderBrake): Promise<void>;
  /**
   * Every brake currently open.
   * @returns The open brakes, for operator-facing surfaces.
   */
  list(): Promise<ProviderBrake[]>;
}

/**
 * The fallback store: one process, no durability.
 *
 * Useful on its own — it still collapses the thirty-three concurrent runs
 * sharing a worker down to one discovery of the throttle, which is most of the
 * benefit. It is a fallback rather than the design because a restart forgets
 * every brake, and a second worker instance never learns of them.
 */
export class InProcessBreakerStore implements ProviderBreakerStore {
  private readonly brakes = new Map<string, ProviderBrake>();

  async openUntil(provider: string, organizationId: string): Promise<Date | undefined> {
    const brake = this.brakes.get(`${provider}\u0000${organizationId}`);
    if (!brake) {
      return undefined;
    }
    if (brake.openUntil.getTime() <= Date.now()) {
      this.brakes.delete(`${provider}\u0000${organizationId}`);
      return undefined;
    }
    return brake.openUntil;
  }

  async open(brake: ProviderBrake): Promise<void> {
    const key = `${brake.provider}\u0000${brake.organizationId}`;
    const existing = this.brakes.get(key);
    // Later wins. A run that computed its window a moment earlier must not be
    // able to shorten a hold another run has already recorded.
    if (existing && existing.openUntil.getTime() >= brake.openUntil.getTime()) {
      return;
    }
    this.brakes.set(key, brake);
  }

  async list(): Promise<ProviderBrake[]> {
    const now = Date.now();
    return [...this.brakes.values()].filter((b) => b.openUntil.getTime() > now);
  }
}

let store: ProviderBreakerStore = new InProcessBreakerStore();

/**
 * Install the shared store.
 *
 * Called once, by whatever process owns durable state — in this repo the
 * worker, at startup, with a Postgres-backed implementation. The bots cannot
 * reach for that themselves: they are imported *by* the worker and also run
 * inside Medplum's bot runtime, where no such database exists, so the
 * dependency can only point this way.
 * @param next - The store to use.
 */
export function setProviderBreakerStore(next: ProviderBreakerStore): void {
  store = next;
}

/**
 * The store in use.
 * @returns The installed store.
 */
export function getProviderBreakerStore(): ProviderBreakerStore {
  return store;
}

/** Reset to a fresh in-process store. For tests. */
export function resetProviderBreakerStore(): void {
  store = new InProcessBreakerStore();
}

/**
 * How long a provider asked us to wait, from whatever it was willing to say.
 *
 * Four conventions, tried in order of how much the provider committed to. None
 * of them is vendor-specific — they are the ways HTTP services say "later",
 * and a new EHR that uses any of them is already handled.
 *
 * 1. `Retry-After` as delta-seconds. The standard answer.
 * 2. `Retry-After` as an HTTP date. RFC 9110 allows it and the existing
 *    DrChrono ladder did not: it did `Number(raw) * 1000`, which is `NaN` for a
 *    date, so a dated `Retry-After` silently fell through to a fixed guess.
 * 3. The `RateLimit-Reset` family, as either a delta or an epoch. Epoch is
 *    distinguished by magnitude rather than by configuration — a value past
 *    2001 in seconds cannot be a sane delta.
 * 4. The body, for providers that answer in prose. DrChrono's throttle says
 *    `Expected available in 2710.0 seconds`, and that sentence was the single
 *    most useful thing available on the day this broke. Matched on the shape of
 *    the phrase, not on DrChrono.
 * @param headers - The refusal's headers.
 * @param body - Its body, if it has been read. Pass `''` when it has not.
 * @param now - Clock injection point, for tests.
 * @returns Milliseconds to wait, or undefined when the provider said nothing.
 */
export function parseRateLimitHint(headers: Headers, body = '', now: number = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampHold(seconds * 1000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return clampHold(at - now);
    }
  }

  for (const name of ['ratelimit-reset', 'x-ratelimit-reset']) {
    const raw = headers.get(name);
    if (!raw) {
      continue;
    }
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    // Anything past 2001 in seconds is an epoch, not a delta. Nobody asks for a
    // billion-second wait, and nobody publishes a reset epoch as a delta.
    const EPOCH_THRESHOLD_SECONDS = 1_000_000_000;
    return clampHold(value > EPOCH_THRESHOLD_SECONDS ? value * 1000 - now : value * 1000);
  }

  // "Expected available in 2710.0 seconds", and anything shaped like it.
  const prose = /available in\s+([\d.]+)\s*second/i.exec(body);
  if (prose) {
    const seconds = Number(prose[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampHold(seconds * 1000);
    }
  }

  return undefined;
}

/**
 * Keep a hold inside the believable range.
 * @param ms - The provider's stated wait.
 * @returns The same wait, bounded.
 */
function clampHold(ms: number): number {
  if (!Number.isFinite(ms)) {
    return DEFAULT_HOLD_MS;
  }
  return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, ms));
}

/**
 * Sleep.
 * @param ms - How long to wait.
 * @returns Resolves once the time has passed.
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ask the store, and never let the store's own failure become the caller's.
 *
 * A brake is an optimisation on top of a call that would otherwise just be
 * made. If the database holding the brakes is unreachable, the correct
 * behaviour is to make the call — degraded, hammering again, but working —
 * rather than to fail an import because the thing that was supposed to protect
 * it is down.
 * @param provider - Integration key.
 * @param organizationId - The clinic.
 * @returns The open-until instant, or undefined.
 */
async function currentBrake(provider: string, organizationId: string): Promise<Date | undefined> {
  try {
    const until = await store.openUntil(provider, organizationId);
    return until && until.getTime() > Date.now() ? until : undefined;
  } catch (err) {
    console.warn(`[rate-limit] could not read the brake for ${provider}: ${message(err)}`);
    return undefined;
  }
}

/**
 * Record a refusal, and never let the store's own failure become the caller's.
 * @param brake - The refusal.
 */
async function recordBrake(brake: ProviderBrake): Promise<void> {
  try {
    await store.open(brake);
  } catch (err) {
    console.warn(`[rate-limit] could not record the brake for ${brake.provider}: ${message(err)}`);
  }
}

/**
 * Every brake currently open, for operator-facing surfaces.
 * @returns The open brakes, or an empty list when the store cannot be read.
 */
export async function openBrakes(): Promise<ProviderBrake[]> {
  try {
    return await store.list();
  } catch {
    return [];
  }
}

export interface GuardedCall {
  /** Integration key — `drchrono`, `zus`, or whatever the next one is called. */
  provider: string;
  /** The clinic. Bare id; use {@link organizationIdOf} for a reference. */
  organizationId: string;
  /** What is being called, for the message an operator reads. Never a URL with a token in it. */
  label: string;
  /** The request. Called zero times when the brake is already on. */
  call: () => Promise<Response>;
}

/**
 * Make a provider call, unless the provider has already said not to.
 *
 * The whole mechanism, in the order it happens:
 *
 * 1. **Check the brake first.** If this clinic is held, the request is not
 *    made. This is the half that matters — the thirteen failures came from
 *    thirty-three runs each insisting on finding out for themselves.
 * 2. **Make the call.** Anything that is not a 429 is returned untouched, so
 *    every existing caller's handling of 404s, 500s and bodies is unchanged.
 * 3. **On a 429, read the body before deciding.** The hint is often only in
 *    there. The body is consumed either way to free the socket, so reading it
 *    costs nothing — it was already being thrown away.
 * 4. **Open the brake, then decide who waits.** A short window is slept here,
 *    because unwinding a run costs more than the wait. A long one is thrown
 *    upward as a {@link ProviderRateLimitError}, because holding a process open
 *    for forty-five minutes is not a thing to do and a suspended Inngest run
 *    is free.
 *
 * Note the ordering in (4): the brake is opened whichever branch is taken. A
 * caller sleeping twenty seconds in-process must still stop every other run for
 * that clinic from calling during those twenty seconds.
 * @param props - The call.
 * @returns The response, for any outcome that is not a rate limit.
 * @throws {ProviderRateLimitError} When the provider is holding this clinic off.
 */
export async function guardProviderCall(props: GuardedCall): Promise<Response> {
  const { provider, organizationId, label } = props;

  for (let attempt = 0; attempt < MAX_INLINE_ATTEMPTS; attempt++) {
    const held = await currentBrake(provider, organizationId);
    if (held) {
      const waitMs = held.getTime() - Date.now();
      if (waitMs > INLINE_WAIT_CEILING_MS || attempt + 1 >= MAX_INLINE_ATTEMPTS) {
        throw new ProviderRateLimitError({ provider, organizationId, retryAt: held, detail: label });
      }
      await sleep(Math.max(0, waitMs));
      continue;
    }

    const res = await props.call();
    if (res.status !== 429) {
      return res;
    }

    // Drained regardless — an unread body holds the socket open. Reading it is
    // the same operation, minus throwing the answer away.
    const body = await res.text().catch(() => '');
    const hintMs = parseRateLimitHint(res.headers, body);
    const holdMs = clampHold((hintMs ?? DEFAULT_HOLD_MS) + HOLD_PAD_MS);
    const retryAt = new Date(Date.now() + holdMs);

    await recordBrake({
      provider,
      organizationId,
      openUntil: retryAt,
      // The provider's own words when it gave them, and never the body, which
      // can carry patient identifiers in an error echo.
      reason: hintMs === undefined ? `429 on ${label}, no wait hint given` : `429 on ${label}`,
    });

    if (holdMs > INLINE_WAIT_CEILING_MS || attempt + 1 >= MAX_INLINE_ATTEMPTS) {
      throw new ProviderRateLimitError({ provider, organizationId, retryAt, detail: label });
    }
    await sleep(holdMs);
  }

  // Unreachable: every path above either returns or throws. Present so the
  // function is total rather than relying on the loop bound.
  throw new ProviderRateLimitError({
    provider,
    organizationId,
    retryAt: new Date(Date.now() + DEFAULT_HOLD_MS),
    detail: label,
  });
}

/**
 * The bare id from a FHIR reference.
 *
 * The brake is keyed on the id rather than on `Organization/abc` so that a
 * caller holding either form keys the same brake. Two spellings of one clinic
 * is two brakes, which is one brake too few.
 * @param reference - e.g. `{ reference: 'Organization/abc' }` or the string.
 * @returns The id, or `'unknown'` when there is nothing to key on.
 */
export function organizationIdOf(reference: { reference?: string } | string | undefined): string {
  const raw = typeof reference === 'string' ? reference : reference?.reference;
  if (!raw) {
    return 'unknown';
  }
  return raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
}

/**
 * An error's message.
 * @param err - Whatever was thrown.
 * @returns Its message.
 */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
