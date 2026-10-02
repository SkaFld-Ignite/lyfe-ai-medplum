// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { RetryAfterError } from 'inngest';
import { describe, expect, test, vi } from 'vitest';
import { ProviderRateLimitError } from '../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';
import { retryAfter, withStepTimeout } from './rate-limit.ts';

/**
 * The real payload, copied verbatim off a failed production run. Keeping the
 * actual shape rather than a tidied-up one is the point: the wait is parsed out
 * of an error *message*, so the thing under test is whether this exact string
 * is still understood.
 */
const RATE_LIMITED = new Error(
  'Too Many Requests ({"_remainingPoints":0,"_msBeforeNext":11240,"_consumedPoints":50172,' +
    '"_isFirstInDuration":false,"limit":50000})'
);

describe('retryAfter', () => {
  test('reads the limiter’s own reset window, padded past the boundary', () => {
    const when = retryAfter(RATE_LIMITED);
    const waitMs = (when as Date).getTime() - Date.now();
    // 11240 from the payload, plus the 5s pad.
    expect(waitMs).toBeGreaterThan(15_500);
    expect(waitMs).toBeLessThanOrEqual(16_300);
  });

  test('falls back to a floor when the payload carries no window', () => {
    const when = retryAfter(new Error('Too Many Requests'));
    expect((when as Date).getTime() - Date.now()).toBeGreaterThan(9_000);
  });

  test('leaves errors that are not rate limits alone', () => {
    expect(retryAfter(new Error('ECONNRESET'))).toBeUndefined();
  });

  test("waits the provider's own forty-five minutes, not a retry budget's twenty", () => {
    // The number DrChrono actually sent on 2026-10-02. The ladder it met was
    // thirty-seven seconds across four attempts, so thirteen charts spent their
    // whole budget on a window that had not begun to close, were marked failed,
    // and were dropped. Nothing about retry counts could have fixed that; only
    // listening to the 2710 could.
    const when = retryAfter(
      new ProviderRateLimitError({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        retryAt: new Date(Date.now() + 2_710_000),
      })
    );
    expect((when as Date).getTime() - Date.now()).toBeGreaterThan(2_700_000);
  });

  test('a brake that has already lifted still reschedules at the floor, never into the past', () => {
    // Inngest is handed an absolute instant. One in the past is either ignored
    // or an immediate re-run, and an immediate re-run of a throttled call is
    // the behaviour being removed.
    const when = retryAfter(
      new ProviderRateLimitError({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        retryAt: new Date(Date.now() - 60_000),
      })
    );
    expect((when as Date).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('withStepTimeout', () => {
  test('turns a rate limit into a RetryAfterError, so Inngest reschedules it', async () => {
    // The distinction that matters: a RetryAfterError suspends the run until
    // the quota resets. A plain Error burns an attempt immediately, which is
    // how a rate limit used to end a run outright.
    await expect(
      withStepTimeout('import', async () => {
        throw RATE_LIMITED;
      })
    ).rejects.toBeInstanceOf(RetryAfterError);
  });

  test('a provider brake reaches Inngest as a RetryAfterError too', async () => {
    // The seam that makes the whole thing work end to end: the bots' HTTP guard
    // throws this, and Inngest suspends the run until the instant on it. Without
    // this line a provider 429 is an ordinary error and gets exponential
    // backoff — which is exactly the twenty minutes that lost the work.
    const thrown = await withStepTimeout('import', async () => {
      throw new ProviderRateLimitError({
        provider: 'drchrono',
        organizationId: 'clinic-a',
        retryAt: new Date(Date.now() + 2_710_000),
      });
    }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(RetryAfterError);
  });

  test('leaves an ordinary failure retryable', async () => {
    const thrown = await withStepTimeout('import', async () => {
      throw new Error('upstream 500');
    }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RetryAfterError);
  });

  test('abandons a step that would outlive the platform request ceiling', async () => {
    vi.useFakeTimers();
    try {
      const pending = withStepTimeout('zus pull', () => new Promise(() => {}), 12 * 60_000);
      const settled = expect(pending).rejects.toThrow(/exceeded 12m/);
      await vi.advanceTimersByTimeAsync(12 * 60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  test('passes a successful result straight through', async () => {
    await expect(withStepTimeout('ok', async () => 42)).resolves.toBe(42);
  });
});
