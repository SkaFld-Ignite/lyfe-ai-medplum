// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { describeNetworkPull, importDrChronoPatient, pullNetworkRecord } from './onboarding';

/**
 * Importing a chart must always pull the patient's network record too.
 *
 * The chaining used to live in exactly one place — the bulk import worker — so
 * a patient imported from the search screen got a complete DrChrono chart and
 * nothing from the network at all. Verified live: 220 resources in, no outside
 * record, and no error anywhere to suggest half of it was missing.
 *
 * Two things then have to be true at once, and they pull in opposite
 * directions. The pull must always be attempted, with no flag and nothing for
 * anyone to tick. And it must never be able to fail a chart import, because two
 * of its outcomes are entirely healthy: a patient whose office is not enrolled
 * has nothing to pull, and a freshly enrolled patient's record arrives over
 * hours rather than seconds.
 */

const IMPORT_BOT = 'https://lyfe.health/bots|lyfe-drchrono-import';
const ZUS_BOT = 'https://lyfe.health/bots|lyfe-zus-import';

/** The bot responses one stub client should serve, keyed by bot identifier. */
interface BotResponses {
  readonly [identifier: string]: unknown;
}

/**
 * A Medplum client that runs bots the way the real async `$execute` path does:
 * start a job, poll an AsyncJob, read the response body off it.
 * @param responses - What each bot responds with, keyed by its identifier.
 * @returns The stub, and the identifiers of the bots that were executed.
 */
function stubMedplum(responses: BotResponses): {
  medplum: MedplumClient;
  executed: string[];
} {
  const executed: string[] = [];
  const identifierByJob = new Map<string, string>();
  const polls = new Map<string, number>();
  let jobs = 0;

  // A bot's id encodes its identifier rather than being recorded in a map. The
  // service caches resolved bot ids for the lifetime of the module — one search
  // per session rather than one per patient in a bulk run — so a map built by
  // one test's stub is not there for the next one's.
  const medplum = {
    searchOne: async (_resourceType: string, query: { identifier: string }) => ({
      resourceType: 'Bot',
      id: `bot-${query.identifier.split('|')[1]}`,
    }),
    startAsyncRequest: async (path: string) => {
      const botId = /Bot\/([^/]+)\/\$execute/.exec(path)?.[1] as string;
      const identifier = `https://lyfe.health/bots|${botId.slice('bot-'.length)}`;
      executed.push(identifier);
      jobs++;
      const jobId = `00000000-0000-0000-0000-${String(jobs).padStart(12, '0')}`;
      identifierByJob.set(jobId, identifier);
      return { issue: [{ diagnostics: `https://medplum.example.com/fhir/R4/job/${jobId}/status` }] };
    },
    readResource: async (_resourceType: string, jobId: string) => {
      const identifier = identifierByJob.get(jobId) as string;
      // The first poll of each job reports it still running, because that is the
      // only time the service emits a progress message — a job that is finished
      // by the first read never reports one.
      const seen = (polls.get(jobId) ?? 0) + 1;
      polls.set(jobId, seen);
      if (seen === 1) {
        return { resourceType: 'AsyncJob', status: 'accepted' };
      }
      const body = responses[identifier];
      if (body === undefined) {
        // An unconfigured bot stands for one that broke, so the test can show
        // what a thrown network half does to a good chart import.
        throw new Error(`boom: ${identifier}`);
      }
      return {
        resourceType: 'AsyncJob',
        status: 'completed',
        output: { parameter: [{ name: 'responseBody', valueString: JSON.stringify(body) }] },
      };
    },
  } as unknown as MedplumClient;

  return { medplum, executed };
}

/**
 * Drive a pending import to completion through its 5-second poll waits.
 * @param pending - The import in flight.
 * @returns Whatever it resolved with.
 */
async function settle<T>(pending: Promise<T>): Promise<T> {
  // Generously more rounds than either leg needs; each one flushes microtasks
  // first, so a timer scheduled after the previous await is still picked up.
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(5000);
  }
  return pending;
}

const CHART_OK = { ok: true, medplumPatientId: 'patient-1', counts: { Encounter: 4, Observation: 216 } };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('importDrChronoPatient', () => {
  test('always pulls the network record after the chart, with nothing to ask for', async () => {
    const { medplum, executed } = stubMedplum({
      [IMPORT_BOT]: CHART_OK,
      [ZUS_BOT]: { ok: true, counts: { Condition: 7 } },
    });

    const result = await settle(importDrChronoPatient(medplum, 120118105));

    // Both halves ran, in order, off one call. This is the defect: the second
    // entry was simply absent on every path except the bulk worker.
    expect(executed).toStrictEqual([IMPORT_BOT, ZUS_BOT]);
    expect(result.ok).toBe(true);
    expect(result.medplumPatientId).toBe('patient-1');
    expect(describeNetworkPull(result.zus)).toStrictEqual({ state: 'pulled', detail: '7 records pulled' });
  });

  test('an ineligible patient is a clean outcome, not a failed import', async () => {
    // What the importer returns when no office of the clinic has enrolment
    // switched on. A configuration choice; nothing to triage.
    const reason =
      'Patient/patient-1 has no encounter at an office with Zus enrolment switched on ' +
      '(4 encounter(s) checked against 2 enabled office(s)).';
    const { medplum } = stubMedplum({ [IMPORT_BOT]: CHART_OK, [ZUS_BOT]: { ok: false, error: reason } });

    const result = await settle(importDrChronoPatient(medplum, '120118105'));

    // The chart imported. That is what `ok` reports, and the refusal below must
    // not touch it.
    expect(result.ok).toBe(true);
    expect(result.counts).toStrictEqual({ Encounter: 4, Observation: 216 });
    expect(result.error).toBeUndefined();
    expect(result.zus?.ok).toBe(false);
    expect(describeNetworkPull(result.zus)).toStrictEqual({ state: 'skipped', detail: reason });
  });

  test('a pending, empty record pull does not fail the chart import', async () => {
    // A fresh enrolment answers successfully and empty: enrolling starts queries
    // out to the networks that come back over hours. "Empty" is pending.
    const { medplum } = stubMedplum({ [IMPORT_BOT]: CHART_OK, [ZUS_BOT]: { ok: true, counts: {} } });

    const result = await settle(importDrChronoPatient(medplum, '120118105'));

    expect(result.ok).toBe(true);
    expect(describeNetworkPull(result.zus).state).toBe('pending');
    // Specifically not 'skipped': nothing was refused and nothing is missing.
    expect(describeNetworkPull(result.zus).state).not.toBe('skipped');
  });

  test('a network half that throws does not fail the chart import', async () => {
    const { medplum } = stubMedplum({ [IMPORT_BOT]: CHART_OK });

    const result = await settle(importDrChronoPatient(medplum, '120118105'));

    expect(result.ok).toBe(true);
    expect(result.medplumPatientId).toBe('patient-1');
    expect(result.zus?.ok).toBe(false);
    expect(result.zus?.error).toContain('boom');
  });

  test('does not attempt a record pull when the chart import failed', async () => {
    // There is no patient to pull onto, so asking would be a guaranteed error
    // report on top of the one that matters.
    const { medplum, executed } = stubMedplum({
      [IMPORT_BOT]: { ok: false, error: 'DrChrono patient not found' },
      [ZUS_BOT]: { ok: true, counts: { Condition: 7 } },
    });

    const result = await settle(importDrChronoPatient(medplum, '999'));

    expect(executed).toStrictEqual([IMPORT_BOT]);
    expect(result.ok).toBe(false);
    expect(result.zus).toBeUndefined();
  });

  test('reports which half each progress message is about', async () => {
    const { medplum } = stubMedplum({ [IMPORT_BOT]: CHART_OK, [ZUS_BOT]: { ok: true, counts: { Condition: 1 } } });
    const stages: string[] = [];

    await settle(importDrChronoPatient(medplum, '1', (_status, stage) => stages.push(stage)));

    // The two halves are minutes apart and fail for unrelated reasons, so a
    // screen has to be able to tell them apart without matching on the text.
    expect(new Set(stages)).toStrictEqual(new Set(['chart', 'network']));
  });
});

describe('pullNetworkRecord', () => {
  test('turns a thrown failure into a reported one', async () => {
    const { medplum } = stubMedplum({});
    await expect(settle(pullNetworkRecord(medplum, 'patient-1'))).resolves.toMatchObject({ ok: false });
  });
});

describe('describeNetworkPull', () => {
  test('classifies the three outcomes that are not failures', () => {
    expect(describeNetworkPull({ ok: true, counts: { Condition: 2, Observation: 3 } })).toStrictEqual({
      state: 'pulled',
      detail: '5 records pulled',
    });
    expect(describeNetworkPull({ ok: true }).state).toBe('pending');
    expect(describeNetworkPull({ ok: true, counts: {} }).state).toBe('pending');
    expect(describeNetworkPull({ ok: false, error: 'not enrolled' })).toStrictEqual({
      state: 'skipped',
      detail: 'not enrolled',
    });
  });

  test('says so when nothing was attempted', () => {
    expect(describeNetworkPull(undefined).state).toBe('skipped');
  });
});
