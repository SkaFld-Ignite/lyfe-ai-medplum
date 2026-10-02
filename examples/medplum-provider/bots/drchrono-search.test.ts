// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test, vi } from 'vitest';
import { matchesReason, previewAppointments, searchPatients } from './drchrono-search.ts';

/**
 * What the onboarding search is allowed to say.
 *
 * This is about one distinction and nothing else: "DrChrono answered and had
 * nobody" versus "DrChrono would not answer". They used to be the same reply.
 * Under throttling every field query 429s, each was skipped, and the page said
 * "no matches" about a patient sitting right there — so somebody searching a
 * date of birth concludes the patient is not in the EHR and stops looking.
 *
 * It is not hypothetical: a 33-patient bulk import exhausted this practice's
 * DrChrono quota for about twenty minutes today, which is exactly the window in
 * which a person would be onboarding by hand. And it is the failure CLAUDE.md
 * already records for Algolia — a search that reports empty when it is broken
 * teaches people the data is not there.
 */

/** DrChrono's actual 429 body, which carries the wait hint worth surfacing. */
const THROTTLED_BODY = '{"detail":"Request was throttled. Expected available in 2710.0 seconds."}';

/**
 * A fake DrChrono that answers each field query however the test says.
 * @param byField - Response per queried field.
 * @returns The fetch helper and the paths it was asked for.
 */
function fakeDrChrono(byField: Record<string, { status: number; body: string }>): {
  get: (path: string) => Promise<Response>;
  paths: string[];
} {
  const paths: string[] = [];
  const get = vi.fn(async (path: string) => {
    paths.push(path);
    const field = /\/patients\?([a-z_]+)=/.exec(path)?.[1] ?? '';
    const reply = byField[field] ?? { status: 200, body: '{"results":[]}' };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => JSON.parse(reply.body),
      text: async () => reply.body,
    } as Response;
  });
  return { get, paths };
}

const PATIENT = '{"results":[{"id":12345,"first_name":"Ada","last_name":"Lovelace","chart_id":"AL0001"}]}';

describe('searchPatients', () => {
  test('a throttled search is an error, never an empty result', async () => {
    const { get } = fakeDrChrono({
      last_name: { status: 429, body: THROTTLED_BODY },
      first_name: { status: 429, body: THROTTLED_BODY },
      chart_id: { status: 429, body: THROTTLED_BODY },
    });

    await expect(searchPatients(get, 'lovelace')).rejects.toThrow(/429/);
  });

  test("the error carries DrChrono's own wait hint", async () => {
    // "Expected available in 2710.0 seconds" is the single most useful thing
    // anyone can be told here, so it must survive to the screen.
    const { get } = fakeDrChrono({ last_name: { status: 429, body: THROTTLED_BODY } });

    await expect(searchPatients(get, 'lovelace')).rejects.toThrow(/Expected available in 2710\.0 seconds/);
  });

  test('a partial failure is refused, not passed off as the whole answer', async () => {
    // last_name answered; chart_id did not. What survives is an unknown
    // fraction of the matches, and showing it as complete is the same lie in a
    // quieter form — the searcher cannot tell a short list from a full one.
    const { get } = fakeDrChrono({
      last_name: { status: 200, body: PATIENT },
      chart_id: { status: 429, body: THROTTLED_BODY },
    });

    await expect(searchPatients(get, 'lovelace')).rejects.toThrow(/chart_id/);
  });

  test('a real empty result is still empty, not an error', async () => {
    // The distinction only has value if the ordinary case stays ordinary.
    const { get } = fakeDrChrono({});

    await expect(searchPatients(get, 'nobody')).resolves.toStrictEqual([]);
  });

  test('matches are merged across fields and de-duplicated by patient id', async () => {
    const { get } = fakeDrChrono({
      last_name: { status: 200, body: PATIENT },
      first_name: { status: 200, body: PATIENT },
      chart_id: { status: 200, body: PATIENT },
    });

    const found = await searchPatients(get, 'lovelace');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 12345, firstName: 'Ada', lastName: 'Lovelace' });
  });

  test('a query too short to be meaningful asks DrChrono nothing', async () => {
    const { get, paths } = fakeDrChrono({});

    await expect(searchPatients(get, 'a')).resolves.toStrictEqual([]);
    expect(paths).toStrictEqual([]);
  });
});

/**
 * The filter the morning routine actually is.
 *
 * Somebody opens DrChrono's calendar, reads each appointment's free-text
 * Reason, keeps the ones that say "new patient" and skips the faded ones. Three
 * of those four steps were already here; the Reason was not, even though
 * `verbose=true` has been putting it on the wire all along.
 *
 * These are written as what a clinic would notice — "the follow-up was not
 * imported", "the cancelled one was not" — rather than as which branch ran.
 */

/** An appointment as DrChrono's verbose payload returns it. */
interface FakeAppointment {
  patient?: number;
  status?: string;
  office?: number;
  doctor?: number;
  reason?: string;
}

/**
 * A fake DrChrono holding one page of appointments and naming every patient.
 * @param appointments - What the calendar holds for the range.
 * @returns A fetch helper over them.
 */
function fakeCalendar(appointments: FakeAppointment[]): (path: string) => Promise<Response> {
  return async (path: string) => {
    const body = path.startsWith('/appointments')
      ? { results: appointments, next: null }
      : { id: Number(/\/patients\/(\d+)/.exec(path)?.[1] ?? 0), first_name: 'Ada', last_name: 'Lovelace' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  };
}

/** Nothing switched off. */
const NOTHING_DISABLED = { offices: new Set<string>(), doctors: new Set<string>() };

/** One new patient, one follow-up. */
const MIXED_DAY: FakeAppointment[] = [
  { patient: 1, status: 'Confirmed', office: 10, doctor: 20, reason: 'New Patient Consult' },
  { patient: 2, status: 'Confirmed', office: 10, doctor: 20, reason: 'follow up' },
];

const DAY = '2026-10-05';

describe('the reason filter', () => {
  test('an appointment whose reason does not match is not a candidate', async () => {
    // Undo the `matchesReason` guard and patient 2 comes back too, so the
    // follow-up has a chart imported for them overnight.
    const preview = await previewAppointments(fakeCalendar(MIXED_DAY), DAY, DAY, NOTHING_DISABLED, 'new patient');

    expect(preview.results.map((p) => p.id)).toStrictEqual([1]);
    expect(preview.excludedByReason).toBe(1);
  });

  test('the phrase belongs to the clinic, not to this file', async () => {
    // The practice that writes "NP" changes a setting, not the code.
    const day: FakeAppointment[] = [
      { patient: 1, status: 'Confirmed', reason: 'NP eval' },
      { patient: 2, status: 'Confirmed', reason: 'New Patient Consult' },
    ];

    const preview = await previewAppointments(fakeCalendar(day), DAY, DAY, NOTHING_DISABLED, 'np');

    expect(preview.results.map((p) => p.id)).toStrictEqual([1]);
  });

  test('no phrase means every appointment, which is what the manual preview wants', async () => {
    // The onboarding screen passes no phrase: a person reading the day's list
    // is doing the filtering themselves, and a hidden filter would make the
    // count on screen disagree with the calendar beside it.
    const preview = await previewAppointments(fakeCalendar(MIXED_DAY), DAY, DAY, NOTHING_DISABLED);

    expect(preview.results.map((p) => p.id)).toStrictEqual([1, 2]);
    expect(preview.excludedByReason).toBe(0);
  });

  test('an appointment with no reason at all does not pass a phrase that was set', async () => {
    // The front desk left the box empty, so it does not say "new patient".
    const day: FakeAppointment[] = [{ patient: 1, status: 'Confirmed' }];

    const preview = await previewAppointments(fakeCalendar(day), DAY, DAY, NOTHING_DISABLED, 'new patient');

    expect(preview.results).toStrictEqual([]);
    expect(preview.excludedByReason).toBe(1);
  });

  test('a cancelled new patient is still not imported, and is counted as cancelled', async () => {
    // The faded rows on the calendar. Counted under status rather than reason,
    // so the summary does not blame the phrase for a visit that never happened.
    const day: FakeAppointment[] = [{ patient: 1, status: 'Cancelled', reason: 'New Patient' }];

    const preview = await previewAppointments(fakeCalendar(day), DAY, DAY, NOTHING_DISABLED, 'new patient');

    expect(preview.results).toStrictEqual([]);
    expect(preview.excludedByStatus).toBe(1);
    expect(preview.excludedByReason).toBe(0);
  });

  test('a new patient at a switched-off office is not imported, and is counted as off-directory', async () => {
    const day: FakeAppointment[] = [{ patient: 1, status: 'Confirmed', office: 99, reason: 'New Patient' }];
    const disabled = { offices: new Set(['99']), doctors: new Set<string>() };

    const preview = await previewAppointments(fakeCalendar(day), DAY, DAY, disabled, 'new patient');

    expect(preview.results).toStrictEqual([]);
    expect(preview.skippedByDirectory).toBe(1);
    expect(preview.excludedByReason).toBe(0);
  });

  test('the counts add up, so a run can explain the gap it leaves', async () => {
    // The point of counting the exclusions separately: four scanned, one found,
    // the other three accounted for rather than left to the reader to guess.
    const day: FakeAppointment[] = [
      { patient: 1, status: 'Confirmed', reason: 'new patient' },
      { patient: 2, status: 'Cancelled', reason: 'new patient' },
      { patient: 3, status: 'Confirmed', office: 99, reason: 'new patient' },
      { patient: 4, status: 'Confirmed', reason: 'annual physical' },
      // Blocked time: no patient on it at all, so it is not an appointment and
      // never reaches the counters.
      { status: 'Confirmed', reason: 'lunch' },
    ];
    const disabled = { offices: new Set(['99']), doctors: new Set<string>() };

    const preview = await previewAppointments(fakeCalendar(day), DAY, DAY, disabled, 'new patient');

    expect(preview.scannedAppointments).toBe(4);
    expect(preview.results).toHaveLength(1);
    expect(
      preview.results.length + preview.excludedByStatus + preview.skippedByDirectory + preview.excludedByReason
    ).toBe(preview.scannedAppointments);
  });
});

describe('matchesReason', () => {
  test('is case-insensitive and tolerant of how a person types', () => {
    expect(matchesReason('NEW  Patient eval', 'new patient')).toBe(true);
    expect(matchesReason('new pt / New Patient', 'new patient')).toBe(true);
  });

  test('a blank phrase matches everything rather than nothing', () => {
    // The opposite reading would make a clinic that saved its settings without
    // touching the box import nobody, and report it as a quiet Tuesday.
    expect(matchesReason('anything', '')).toBe(true);
    expect(matchesReason(undefined, undefined)).toBe(true);
  });

  test('a missing reason never matches a phrase that was set', () => {
    expect(matchesReason(undefined, 'new patient')).toBe(false);
  });
});
