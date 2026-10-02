// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test } from 'vitest';
import {
  getProviderBreakerStore,
  resetProviderBreakerStore,
  setProviderBreakerStore,
} from '../../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';
import { MAX_HOLDS, heldPhase, holdWhileRateLimited } from './hold.ts';

/**
 * Holding work instead of dropping it.
 *
 * The measured failure was not that imports were slow — it was that thirteen
 * patients were *reported as failed* and the work was gone. So what is asserted
 * here is that a run which meets a throttle waits and then proceeds, that the
 * waiting is visible while it happens, and that running out of patience is
 * still not the same as giving up.
 */

/**
 * Inngest's step tooling, as far as this needs it.
 *
 * `step.run` calls its body — memoisation is Inngest's and replaying it here
 * would be testing the stub. `sleepUntil` records the wake and, by default,
 * lets the brake expire, which is what the passage of time does.
 * @param options - Harness options.
 * @param options.brakeOutlastsSleep - Leave the brake on after the sleep, as a
 *   provider that has not recovered would.
 * @returns The fake step, what it slept, and which steps it ran.
 */
function fakeStep(options: { brakeOutlastsSleep?: boolean } = {}): {
  step: {
    run: (id: string, body: () => Promise<string | null>) => Promise<string | null>;
    sleepUntil: (id: string, time: Date) => Promise<void>;
  };
  slept: { id: string; at: Date }[];
  ran: string[];
} {
  const slept: { id: string; at: Date }[] = [];
  const ran: string[] = [];
  return {
    slept,
    ran,
    step: {
      run: async (id, body) => {
        ran.push(id);
        return body();
      },
      sleepUntil: async (id, time) => {
        slept.push({ id, at: time });
        if (!options.brakeOutlastsSleep) {
          // Time passed and the window cleared, which is the normal case.
          resetProviderBreakerStore();
        }
      },
    },
  };
}

/**
 * Put a brake on.
 * @param provider - Integration key.
 * @param organizationId - The clinic.
 * @param ms - How far ahead the window closes.
 * @returns The instant the brake lifts.
 */
async function brake(provider: string, organizationId: string, ms: number): Promise<Date> {
  const openUntil = new Date(Date.now() + ms);
  await getProviderBreakerStore().open({ provider, organizationId, openUntil, reason: '429' });
  return openUntil;
}

beforeEach(() => {
  resetProviderBreakerStore();
});

describe('held work waits and then runs', () => {
  test('no brake means no wait, and one cheap read', async () => {
    const { step, slept, ran } = fakeStep();
    expect(await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-a', step })).toBe(0);
    expect(slept).toEqual([]);
    // One read, not a loop. This runs on the happy path of every import.
    expect(ran).toEqual(['check-rate-limit-0']);
  });

  test('a run that meets a brake sleeps until the provider said, then proceeds', async () => {
    const until = await brake('drchrono', 'clinic-a', 2_710_000);
    const { step, slept } = fakeStep();

    const holds = await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-a', step });

    expect(holds).toBe(1);
    expect(slept).toHaveLength(1);
    // Woken at DrChrono's own instant, plus a few seconds of spread so thirty-
    // three runs do not all wake into the same burst that closed the window.
    expect(slept[0].at.getTime()).toBeGreaterThanOrEqual(until.getTime());
    expect(slept[0].at.getTime()).toBeLessThan(until.getTime() + 20_000);
    // And it returned — the run carries on and imports the patient, which is
    // the difference between held and lost.
  });

  test('the wait is reported while it is happening, not after', async () => {
    const until = await brake('drchrono', 'clinic-a', 2_710_000);
    const { step } = fakeStep();
    const phases: string[] = [];

    await holdWhileRateLimited({
      provider: 'drchrono',
      organizationId: 'clinic-a',
      step,
      onHold: async (at) => {
        phases.push(heldPhase('drchrono', at));
      },
    });

    // A held run that says nothing is indistinguishable from a stuck one, and
    // on the day this broke it was read as stuck.
    expect(phases).toHaveLength(1);
    expect(phases[0]).toContain('drchrono');
    expect(phases[0]).toContain(until.toISOString());
  });

  test('a clinic with no brake is not held by another clinic having one', async () => {
    await brake('drchrono', 'clinic-a', 2_710_000);
    const { step, slept } = fakeStep();

    expect(await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-b', step })).toBe(0);
    expect(slept).toEqual([]);
  });

  test('a provider with no brake is not held by another provider having one', async () => {
    await brake('drchrono', 'clinic-a', 2_710_000);
    const { step, slept } = fakeStep();

    expect(await holdWhileRateLimited({ provider: 'zus', organizationId: 'clinic-a', step })).toBe(0);
    expect(slept).toEqual([]);
  });

  test('each pass re-reads rather than replaying the first answer', async () => {
    // Inngest memoises steps by id, so a single `check-rate-limit` step would
    // be answered from the memo forever and a run that woke to find the
    // provider still throttled would never look again. The indexed ids are what
    // make the second look a genuine one.
    await brake('drchrono', 'clinic-a', 2_710_000);
    const { step, ran } = fakeStep({ brakeOutlastsSleep: true });

    await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-a', step });

    const checks = ran.filter((id) => id.startsWith('check-rate-limit-'));
    expect(new Set(checks).size).toBe(checks.length);
    expect(checks).toContain('check-rate-limit-1');
  });
});

describe('patience is bounded, and running out of it is not giving up', () => {
  test('a provider that never recovers stops the waiting but not the run', async () => {
    await brake('drchrono', 'clinic-a', 2_710_000);
    const { step, slept } = fakeStep({ brakeOutlastsSleep: true });

    const holds = await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-a', step });

    expect(holds).toBe(MAX_HOLDS);
    expect(slept).toHaveLength(MAX_HOLDS);
    // It returns rather than throwing. The import is attempted, and if the
    // provider is still refusing it takes the RetryAfterError route with its
    // own six attempts behind it. A run that waited forever and reported
    // nothing would be a worse outcome than a failure somebody can see.
  });
});

describe('the hold fails open', () => {
  test('a store that cannot be read does not hold a run hostage', async () => {
    setProviderBreakerStore({
      openUntil: async () => {
        throw new Error('connection refused');
      },
      open: async () => undefined,
      list: async () => [],
    });
    const { step, slept } = fakeStep();

    expect(await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-a', step })).toBe(0);
    expect(slept).toEqual([]);
  });
});

describe('what survives a replay', () => {
  test('the brake instant crosses a step boundary as a string', async () => {
    // Inngest serialises a step's output, so a `Date` returned from one comes
    // back as a string and `.getTime()` on it is a TypeError at the first
    // replay in production — a failure no unit test with an in-memory step
    // would ever see. The ISO round trip is the protection, so it is asserted
    // at the boundary rather than trusted.
    await brake('drchrono', 'clinic-a', 2_710_000);
    const outputs: unknown[] = [];
    const slept: Date[] = [];
    const step = {
      run: async (_id: string, body: () => Promise<string | null>) => {
        const out = await body();
        outputs.push(out);
        // What Inngest actually hands back on a replay: the parsed JSON.
        return JSON.parse(JSON.stringify(out)) as string | null;
      },
      sleepUntil: async (_id: string, time: Date) => {
        slept.push(time);
        resetProviderBreakerStore();
      },
    };

    await holdWhileRateLimited({ provider: 'drchrono', organizationId: 'clinic-a', step });

    expect(typeof outputs[0]).toBe('string');
    expect(slept[0].getTime()).not.toBeNaN();
  });
});

describe('the phase an operator reads', () => {
  test('names the provider and the time, because "held" alone prompts the question it should answer', () => {
    const until = new Date('2026-10-02T14:05:00.000Z');
    const phase = heldPhase('drchrono', until);
    expect(phase).toContain('drchrono');
    expect(phase).toContain('2026-10-02T14:05:00.000Z');
    expect(phase.startsWith('held')).toBe(true);
  });
});
