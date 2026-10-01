// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Location } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  addClinicDays,
  clinicDayStart,
  DEFAULT_CLINIC_TIME_ZONE,
  formatDayKey,
  formatDayKeyLong,
  formatFhirDate,
  getLocationTimeZone,
  resolveClinicTimeZone,
  toCalendarDayKey,
  toClinicIsoDate,
  weekdayForDayKey,
} from './clinic-time';

const TIMEZONE_URI = 'http://hl7.org/fhir/StructureDefinition/timezone';

function office(timeZone?: string): Location {
  return {
    resourceType: 'Location',
    ...(timeZone ? { extension: [{ url: TIMEZONE_URI, valueCode: timeZone }] } : {}),
  };
}

describe('resolving the clinic zone', () => {
  test('reads the standard HL7 timezone extension', () => {
    expect(getLocationTimeZone(office('US/Eastern'))).toBe('US/Eastern');
    expect(getLocationTimeZone(office())).toBeUndefined();
  });

  test('takes the majority zone across the offices', () => {
    const locations = [office('US/Pacific'), office('US/Pacific'), office('US/Eastern')];
    expect(resolveClinicTimeZone(locations)).toBe('US/Pacific');
  });

  test('falls back to the default when no office declares one', () => {
    expect(resolveClinicTimeZone([office(), office()])).toBe(DEFAULT_CLINIC_TIME_ZONE);
    expect(resolveClinicTimeZone([])).toBe(DEFAULT_CLINIC_TIME_ZONE);
  });
});

describe('clinic calendar days', () => {
  test('an afternoon at the clinic is not the next day', () => {
    // The bug this module exists for: 16:30 on the 14th at a Pacific clinic is
    // 05:30 on the 15th in Karachi, so a viewer-local key moved most of an
    // afternoon clinic onto the following date.
    const afternoon = new Date('2026-09-14T23:30:00Z');
    expect(toClinicIsoDate(afternoon, 'US/Pacific')).toBe('2026-09-14');
    expect(toClinicIsoDate(afternoon, 'Asia/Karachi')).toBe('2026-09-15');
  });

  test('every day of a year round-trips through its start instant', () => {
    // A day key converted to an instant and read back must give the same day,
    // on all 365 of them — including the two on which the offset changes.
    let key = '2026-01-01';
    const mismatches: string[] = [];
    for (let i = 0; i < 365; i++) {
      const start = clinicDayStart(key, 'US/Pacific');
      if (!start || toClinicIsoDate(start, 'US/Pacific') !== key) {
        mismatches.push(key);
      }
      key = addClinicDays(key, 1);
    }
    expect(mismatches).toEqual([]);
  });

  test('the last instant of a day still belongs to that day', () => {
    // DST ends on 1 November 2026, making the day 25 hours long.
    const nextStart = clinicDayStart('2026-11-02', 'US/Pacific');
    expect(nextStart).toBeDefined();
    const lastMoment = new Date((nextStart as Date).getTime() - 1);
    expect(toClinicIsoDate(lastMoment, 'US/Pacific')).toBe('2026-11-01');
  });

  test('shifting days is a calendar step, not a 24-hour step', () => {
    expect(addClinicDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addClinicDays('2026-03-01', -1)).toBe('2026-02-28');
    // Across the spring-forward boundary, where a naive 24-hour step lands at
    // 23:00 on the same day.
    expect(addClinicDays('2026-03-07', 1)).toBe('2026-03-08');
  });

  test('rejects a malformed key rather than inventing a day', () => {
    expect(clinicDayStart('2026-1-5', 'US/Pacific')).toBeUndefined();
    expect(addClinicDays('nonsense', 1)).toBe('nonsense');
  });
});

describe('formatting a day key', () => {
  test('does not shift the day it was given', () => {
    // Formatted from the key, never via an instant, so no zone can move it.
    expect(weekdayForDayKey('2026-09-14')).toBe('Monday');
    expect(formatDayKeyLong('2026-09-14')).toContain('September 14, 2026');
  });

  test('leaves a malformed key alone', () => {
    expect(weekdayForDayKey('not-a-day')).toBe('not-a-day');
  });
});

describe('a calendar date that came from parts', () => {
  test('keeps its day instead of rolling back through UTC', () => {
    // A C-CDA birth date of 19870817 is parsed into local calendar parts. The
    // bug this guards: `.toISOString()` reinterprets that local midnight as an
    // instant, so west of UTC it renders as 16 August — which is exactly what
    // the chart showed for a patient born on the 17th.
    const fromParts = new Date(1987, 7, 17);
    expect(toCalendarDayKey(fromParts)).toBe('1987-08-17');
    expect(formatDayKey(toCalendarDayKey(fromParts), { dateStyle: 'medium' })).toContain('1987');
  });

  test('holds for the first of a month, where the roll-back changes the month too', () => {
    expect(toCalendarDayKey(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(toCalendarDayKey(new Date(2026, 3, 1))).toBe('2026-04-01');
  });
});

describe('formatting a FHIR date', () => {
  test('shows a date-only value as that calendar day', () => {
    expect(formatFhirDate('2026-01-06', 'Asia/Karachi')).toBe('Jan 6, 2026');
  });

  test('shows an instant as its day at the clinic', () => {
    // 03:00 UTC on the 7th is still the 6th in Los Angeles.
    expect(formatFhirDate('2026-01-07T03:00:00Z', 'America/Los_Angeles')).toBe('Jan 6, 2026');
  });

  test('keeps a partial date as given and ignores a missing or bad one', () => {
    expect(formatFhirDate('2026-01', 'UTC')).toBe('2026-01');
    expect(formatFhirDate(undefined, 'UTC')).toBeUndefined();
    expect(formatFhirDate('not a date', 'UTC')).toBeUndefined();
  });
});
