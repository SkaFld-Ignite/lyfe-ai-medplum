// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProviderBrake, ProviderBreakerStore } from './provider-rate-limit.ts';
import {
  DEFAULT_HOLD_MS,
  InProcessBreakerStore,
  ProviderRateLimitError,
  getProviderBreakerStore,
  guardProviderCall,
  isProviderRateLimitError,
  organizationIdOf,
  parseRateLimitHint,
  resetProviderBreakerStore,
  setProviderBreakerStore,
} from './provider-rate-limit.ts';

/**
 * What a rate-limit brake is for, stated as things that must be true.
 *
 * Every test here is phrased as an outcome somebody cared about on 2026-10-02 —
 * "the second patient does not call a provider that just refused the first",
 * "the other clinic still imports", "the forty-five minutes DrChrono asked for
 * is the forty-five minutes we wait". None of them asserts which function
 * called which, because the point was never the mechanism.
 *
 * Nothing here touches a real provider. Burning a clinic's live DrChrono quota
 * to prove that we handle a burnt quota would be a notably bad trade, so every
 * provider in this file is a counter and a canned `Response`.
 */

/**
 * A 429 that says how long to wait, the way DrChrono does.
 * @param options - Which of the conventions this refusal uses.
 * @param options.retryAfter - A `Retry-After` header value.
 * @param options.body - The refusal body, where the prose hint lives.
 * @param options.reset - A `RateLimit-Reset` header value.
 * @returns The canned refusal.
 */
function throttled(options: { retryAfter?: string; body?: string; reset?: string } = {}): Response {
  const headers = new Headers();
  if (options.retryAfter) {
    headers.set('retry-after', options.retryAfter);
  }
  if (options.reset) {
    headers.set('ratelimit-reset', options.reset);
  }
  return new Response(options.body ?? '', { status: 429, headers });
}

/**
 * A provider that answers, counting how many times it was actually asked.
 *
 * The count is the assertion in most of these tests: "stop calling it" is only
 * demonstrable as a call that did not happen.
 * @param responses - What to answer, in order. Exhausted means 200.
 * @returns The fake, and its call counter.
 */
function provider(responses: Response[] = []): { call: () => Promise<Response>; calls: () => number } {
  let calls = 0;
  return {
    call: async () => {
      calls++;
      return responses.shift() ?? new Response('{}', { status: 200 });
    },
    calls: () => calls,
  };
}

beforeEach(() => {
  resetProviderBreakerStore();
  vi.restoreAllMocks();
  // The guard logs a warning when the store is unreachable, which one test
  // provokes deliberately. Silenced so a passing run is quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a refusal stops the calls that would deepen it', () => {
  test('the second call for the same clinic never reaches the provider', async () => {
    const drchrono = provider([throttled({ retryAfter: '2710' })]);

    // The first patient discovers the throttle. Somebody has to.
    await expect(
      guardProviderCall({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        label: 'GET /patients',
        call: drchrono.call,
      })
    ).rejects.toThrow(ProviderRateLimitError);
    expect(drchrono.calls()).toBe(1);

    // The twelve patients behind them do not. This is the whole issue: on
    // 2026-10-02 all thirty-three insisted on finding out for themselves, and
    // every one of those requests made the throttle worse.
    for (let i = 0; i < 12; i++) {
      await expect(
        guardProviderCall({
          provider: 'drchrono',
          organizationId: 'clinic-a',
          label: `GET /patients/${i}`,
          call: drchrono.call,
        })
      ).rejects.toThrow(ProviderRateLimitError);
    }
    expect(drchrono.calls()).toBe(1);
  });

  test('a brake is per clinic, so the other practice still imports', async () => {
    const drchrono = provider([throttled({ retryAfter: '2710' })]);

    await expect(
      guardProviderCall({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        label: 'GET /patients',
        call: drchrono.call,
      })
    ).rejects.toThrow(ProviderRateLimitError);

    // Clinic B's DrChrono quota is clinic B's. A global brake would be the easy
    // wrong version of this and would have stopped an unrelated practice's
    // imports for forty-five minutes.
    const res = await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-b',
      label: 'GET /patients',
      call: drchrono.call,
    });
    expect(res.status).toBe(200);
    expect(drchrono.calls()).toBe(2);
  });

  test('a brake is per provider, so a DrChrono throttle does not stop the Zus pull', async () => {
    const drchrono = provider([throttled({ retryAfter: '2710' })]);
    const zus = provider();

    await expect(
      guardProviderCall({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        label: 'GET /patients',
        call: drchrono.call,
      })
    ).rejects.toThrow(ProviderRateLimitError);

    const res = await guardProviderCall({
      provider: 'zus',
      organizationId: 'clinic-a',
      label: 'GET /Patient',
      call: zus.call,
    });
    expect(res.status).toBe(200);
    expect(zus.calls()).toBe(1);
  });

  test('the brake lifts on its own, and the work goes through', async () => {
    vi.useFakeTimers();
    const drchrono = provider([throttled({ retryAfter: '60' })]);

    await expect(
      guardProviderCall({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        label: 'GET /patients',
        call: drchrono.call,
      })
    ).rejects.toThrow(ProviderRateLimitError);

    vi.advanceTimersByTime(66_000);

    // Held, not lost. The patient imports, a minute later, with nobody retrying
    // anything by hand.
    const res = await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    });
    expect(res.status).toBe(200);
  });

  test('anything that is not a 429 is handed back untouched', async () => {
    const drchrono = provider([new Response('nope', { status: 404 })]);
    const res = await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients/1',
      call: drchrono.call,
    });
    expect(res.status).toBe(404);
    // A 404 is not a throttle. Nothing is braked, and the next call goes.
    expect(await getProviderBreakerStore().openUntil('drchrono', 'clinic-a')).toBeUndefined();
  });
});

describe("the provider's own number is the one we wait", () => {
  test('a Retry-After in seconds is honoured, not rounded down to a retry budget', async () => {
    const started = Date.now();
    const drchrono = provider([throttled({ retryAfter: '2710' })]);

    const err = await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    }).catch((e: unknown) => e);

    expect(isProviderRateLimitError(err)).toBe(true);
    // 2710 seconds is forty-five minutes. The retry ladder it replaced was
    // thirty-seven seconds, which is why thirteen charts could not have
    // succeeded no matter how many times they tried.
    const waitedMs = (err as ProviderRateLimitError).retryAt.getTime() - started;
    expect(waitedMs).toBeGreaterThanOrEqual(2_710_000);
    expect(waitedMs).toBeLessThan(2_730_000);
  });

  test("DrChrono's prose is read, because that is where it says it", async () => {
    const started = Date.now();
    // The exact shape seen live: no Retry-After header at all, the number only
    // in the body, and the body was being drained and discarded.
    const drchrono = provider([
      throttled({ body: '{"detail":"Request was throttled. Expected available in 2710.0 seconds."}' }),
    ]);

    const err = (await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    }).catch((e: unknown) => e)) as ProviderRateLimitError;

    expect(err.retryAt.getTime() - started).toBeGreaterThanOrEqual(2_710_000);
  });

  test('a refusal with no hint at all still brakes, for a sane default', async () => {
    const started = Date.now();
    const drchrono = provider([throttled()]);

    const err = (await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    }).catch((e: unknown) => e)) as ProviderRateLimitError;

    expect(err.retryAt.getTime() - started).toBeGreaterThanOrEqual(DEFAULT_HOLD_MS);
  });

  test('a short window is waited out in place rather than unwinding the run', async () => {
    vi.useFakeTimers();
    const drchrono = provider([throttled({ retryAfter: '1' }), new Response('{}', { status: 200 })]);

    const pending = guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    // One second is not worth tearing a run down for. It is still worth telling
    // the other runs about, which the brake above this assertion did.
    expect(res.status).toBe(200);
    expect(drchrono.calls()).toBe(2);
  });

  test('a short window still brakes the clinic while it is being waited out', async () => {
    vi.useFakeTimers();
    const drchrono = provider([throttled({ retryAfter: '1' }), new Response('{}', { status: 200 })]);

    const pending = guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    });
    // Mid-sleep: a second run arriving now must find the brake on, otherwise
    // "wait a second in-process" is just one run being polite while thirty-two
    // others hammer.
    await vi.advanceTimersByTimeAsync(10);
    expect(await getProviderBreakerStore().openUntil('drchrono', 'clinic-a')).toBeDefined();

    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });
});

describe('reading a wait hint out of whatever the provider was willing to say', () => {
  test('Retry-After in delta-seconds', () => {
    expect(parseRateLimitHint(new Headers({ 'retry-after': '120' }))).toBe(120_000);
  });

  test('Retry-After as an HTTP date, which the old ladder silently dropped', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const hint = parseRateLimitHint(new Headers({ 'retry-after': 'Fri, 02 Oct 2026 12:05:00 GMT' }), '', now);
    // The code this replaces did `Number(raw) * 1000`, which is NaN for a date,
    // so a dated Retry-After fell through to a fixed guess with no sign that
    // the provider had answered precisely.
    expect(hint).toBe(300_000);
  });

  test('RateLimit-Reset as an epoch', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(parseRateLimitHint(new Headers({ 'ratelimit-reset': String(now / 1000 + 90) }), '', now)).toBe(90_000);
  });

  test('RateLimit-Reset as a delta', () => {
    expect(parseRateLimitHint(new Headers({ 'ratelimit-reset': '45' }))).toBe(45_000);
  });

  test('prose, matched on the shape of the sentence rather than on DrChrono', () => {
    expect(parseRateLimitHint(new Headers(), 'Request was throttled. Expected available in 30.0 seconds.')).toBe(
      30_000
    );
  });

  test('nothing at all is reported as nothing, not as zero', () => {
    expect(parseRateLimitHint(new Headers(), 'go away')).toBeUndefined();
  });

  test('an absurd window is clamped rather than believed', () => {
    // A week is not a throttle, it is a bug or a hostile header. Believing it
    // would pause a clinic's imports until somebody noticed.
    expect(parseRateLimitHint(new Headers({ 'retry-after': String(7 * 24 * 3600) }))).toBe(12 * 60 * 60_000);
  });
});

describe('the brake fails open, because it is protection and not a gate', () => {
  test('a store that cannot be read does not stop an import', async () => {
    setProviderBreakerStore({
      openUntil: async () => {
        throw new Error('connection refused');
      },
      open: async () => {
        throw new Error('connection refused');
      },
      list: async () => {
        throw new Error('connection refused');
      },
    });

    const drchrono = provider();
    const res = await guardProviderCall({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      label: 'GET /patients',
      call: drchrono.call,
    });

    // Degraded — back to hammering — but working. A database outage must not
    // be the reason a patient's chart does not import.
    expect(res.status).toBe(200);
  });
});

describe('the store keeps the longer hold', () => {
  test('a later-arriving shorter window does not shorten an existing brake', async () => {
    const store: ProviderBreakerStore = new InProcessBreakerStore();
    const long: ProviderBrake = {
      provider: 'drchrono',
      organizationId: 'clinic-a',
      openUntil: new Date(Date.now() + 2_710_000),
      reason: 'long',
    };
    const short: ProviderBrake = { ...long, openUntil: new Date(Date.now() + 60_000), reason: 'short' };

    await store.open(long);
    await store.open(short);

    // Two runs compute their windows from their own clocks a few seconds apart,
    // and the one that arrives second is often the shorter. Letting it win
    // would quietly undo a hold another run had correctly recorded.
    expect((await store.openUntil('drchrono', 'clinic-a'))?.getTime()).toBe(long.openUntil.getTime());
  });

  test('an expired brake is not reported as open', async () => {
    vi.useFakeTimers();
    const store = new InProcessBreakerStore();
    await store.open({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      openUntil: new Date(Date.now() + 1_000),
      reason: 'short',
    });
    vi.advanceTimersByTime(2_000);
    expect(await store.openUntil('drchrono', 'clinic-a')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

describe('one clinic is one brake however it is spelled', () => {
  test('a reference and a bare id key the same clinic', () => {
    expect(organizationIdOf({ reference: 'Organization/abc' })).toBe('abc');
    expect(organizationIdOf('Organization/abc')).toBe('abc');
    expect(organizationIdOf('abc')).toBe('abc');
  });

  test('nothing to key on is still a key, not a crash', () => {
    expect(organizationIdOf(undefined)).toBe('unknown');
    expect(organizationIdOf({})).toBe('unknown');
  });
});
