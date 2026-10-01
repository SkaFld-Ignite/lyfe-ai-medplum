// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Encounter, Reference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { INFERRED_LINK_EXTENSION, resolveEncounter } from './drchrono-import.ts';

/**
 * These cover a decision about a medical record, not a mapping detail.
 *
 * Linking a procedure to the wrong visit misfiles it in the chart, so the rule
 * that the fallback declines on an ambiguous day is the behaviour worth pinning
 * down — and the rule that a deduced link is always marked as one.
 */
const MORNING: Reference<Encounter> = { reference: 'Encounter/morning' };
const AFTERNOON: Reference<Encounter> = { reference: 'Encounter/afternoon' };
const BY_APPOINTMENT: Reference<Encounter> = { reference: 'Encounter/from-appointment' };

const ctx = {
  encounters: new Map([['4242', BY_APPOINTMENT]]),
  encountersByDay: new Map([
    ['2025-05-22', [MORNING]],
    ['2025-06-27', [MORNING, AFTERNOON]],
  ]),
};

describe('resolveEncounter', () => {
  test('uses the appointment id DrChrono gave, and does not mark it', () => {
    const ref = resolveEncounter(4242, '2025-05-22', ctx);
    expect(ref?.reference).toBe('Encounter/from-appointment');
    expect(ref?.extension).toBeUndefined();
  });

  test('prefers the asserted link even when the day would also match', () => {
    // The day index holds a different encounter for 2025-05-22. DrChrono's own
    // answer wins; the fallback must never override a stated relationship.
    expect(resolveEncounter(4242, '2025-05-22', ctx)?.reference).toBe('Encounter/from-appointment');
  });

  test('falls back to the day when there is exactly one visit, and marks it', () => {
    const ref = resolveEncounter(undefined, '2025-05-22', ctx);
    expect(ref?.reference).toBe('Encounter/morning');
    expect(ref?.extension?.[0]?.url).toBe(INFERRED_LINK_EXTENSION);
  });

  test('declines when the day had more than one visit', () => {
    // The whole point of the guard: guessing here could file a procedure under
    // the wrong visit, which is worse than leaving it unlinked.
    expect(resolveEncounter(undefined, '2025-06-27', ctx)).toBeUndefined();
  });

  test('declines when the day had no visit at all', () => {
    expect(resolveEncounter(undefined, '2019-09-18', ctx)).toBeUndefined();
  });

  test('declines when there is no date to match on', () => {
    expect(resolveEncounter(undefined, undefined, ctx)).toBeUndefined();
  });

  test('accepts a full timestamp, not just a calendar day', () => {
    const ref = resolveEncounter(null, '2025-05-22T14:05:00', ctx);
    expect(ref?.reference).toBe('Encounter/morning');
  });

  test('falls back when the appointment id is one we never wrote an Encounter for', () => {
    // A cancelled or out-of-directory visit is filtered before the write, so
    // its id is absent from the map. The record should still find its day.
    const ref = resolveEncounter(9999, '2025-05-22', ctx);
    expect(ref?.reference).toBe('Encounter/morning');
    expect(ref?.extension?.[0]?.url).toBe(INFERRED_LINK_EXTENSION);
  });
});
