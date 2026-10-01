// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Observation } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { buildVitalsMatrix } from './vitals-matrix';

const TZ = 'America/Los_Angeles';

function vital(code: string, value: number, date: string, unit = ''): Observation {
  return {
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code }] },
    valueQuantity: { value, unit },
    effectiveDateTime: date,
  };
}

function bp(systolic: number, diastolic: number, date: string): Observation {
  return {
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
    effectiveDateTime: date,
    component: [
      { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: systolic } },
      { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: diastolic } },
    ],
  };
}

describe('the vitals matrix', () => {
  test('puts the newest clinic day first and leaves out vitals never recorded', () => {
    const matrix = buildVitalsMatrix(
      [vital('8867-4', 74, '2026-09-01T17:00:00Z', '/min'), vital('8867-4', 78, '2026-09-20T17:00:00Z', '/min')],
      TZ
    );
    expect(matrix.days).toEqual(['2026-09-20', '2026-09-01']);
    expect(matrix.rows.map((r) => r.key)).toEqual(['pulse']);
    expect(matrix.rows[0].unit).toBe('/min');
  });

  test('files a reading under its day at the clinic, not in UTC', () => {
    // 03:00 UTC on the 2nd is still the 1st in Los Angeles.
    const matrix = buildVitalsMatrix([vital('8867-4', 74, '2026-09-02T03:00:00Z')], TZ);
    expect(matrix.days).toEqual(['2026-09-01']);
  });

  test('keeps the latest reading of a vital on a day', () => {
    const matrix = buildVitalsMatrix(
      [vital('8867-4', 90, '2026-09-01T20:00:00Z'), vital('8867-4', 70, '2026-09-01T17:00:00Z')],
      TZ
    );
    expect(matrix.rows[0].cells['2026-09-01'].display).toBe('90');
  });

  test('shows blood pressure as systolic/diastolic and grades it', () => {
    const matrix = buildVitalsMatrix([bp(150, 95, '2026-09-01T17:00:00Z')], TZ);
    expect(matrix.rows[0]).toMatchObject({ key: 'bp', unit: 'mmHg' });
    expect(matrix.rows[0].cells['2026-09-01']).toEqual({ display: '150/95', level: 'abnormal' });
  });

  test('skips readings entered in error', () => {
    const wrong: Observation = { ...vital('8867-4', 74, '2026-09-01T17:00:00Z'), status: 'entered-in-error' };
    expect(buildVitalsMatrix([wrong], TZ).rows).toEqual([]);
  });
});
