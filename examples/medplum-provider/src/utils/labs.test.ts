// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DiagnosticReport, Observation } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { buildLabsModel, labFlag, toLabResult } from './labs';

function lab(id: string, code: string, value: number, date: string, extra: Partial<Observation> = {}): Observation {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code, display: `Test ${code}` }] },
    valueQuantity: { value, unit: 'mg/dL' },
    effectiveDateTime: date,
    ...extra,
  };
}

describe('flagging a lab result', () => {
  test('uses the interpretation code first', () => {
    const obs = lab('a', '1', 5, '2026-01-01', {
      interpretation: [{ coding: [{ code: 'LL' }] }],
      referenceRange: [{ high: { value: 1 } }],
    });
    expect(labFlag(obs)).toBe('L');
  });

  test('falls back to the reference range', () => {
    expect(
      labFlag(lab('a', '1', 120, '2026-01-01', { referenceRange: [{ low: { value: 70 }, high: { value: 99 } }] }))
    ).toBe('H');
    expect(
      labFlag(lab('a', '1', 60, '2026-01-01', { referenceRange: [{ low: { value: 70 }, high: { value: 99 } }] }))
    ).toBe('L');
    expect(
      labFlag(lab('a', '1', 80, '2026-01-01', { referenceRange: [{ low: { value: 70 }, high: { value: 99 } }] }))
    ).toBeUndefined();
  });

  test('is undefined without an interpretation or a range', () => {
    expect(labFlag(lab('a', '1', 80, '2026-01-01'))).toBeUndefined();
  });
});

describe('a lab result row', () => {
  test('shows the value, unit and reference range', () => {
    const result = toLabResult(
      lab('a', '2345-7', 142, '2026-01-01', { referenceRange: [{ low: { value: 70 }, high: { value: 99 } }] })
    );
    expect(result).toMatchObject({ label: 'Test 2345-7', display: '142', unit: 'mg/dL', range: '70–99', flag: 'H' });
  });

  test('shows a text value and a text range as given', () => {
    const result = toLabResult({
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Urine culture' },
      valueString: 'No growth',
      referenceRange: [{ text: 'Negative' }],
    });
    expect(result).toMatchObject({ label: 'Urine culture', display: 'No growth', range: 'Negative' });
  });
});

describe('the labs model', () => {
  const older = lab('g1', '2345-7', 98, '2026-01-01T10:00:00Z');
  const newer = lab('g2', '2345-7', 142, '2026-06-01T10:00:00Z', { interpretation: [{ coding: [{ code: 'H' }] }] });
  const loose = lab('c1', '2160-0', 0.9, '2026-03-01T10:00:00Z');
  const report: DiagnosticReport = {
    resourceType: 'DiagnosticReport',
    id: 'r1',
    status: 'final',
    code: { text: 'Metabolic panel' },
    effectiveDateTime: '2026-06-01T10:00:00Z',
    result: [{ reference: 'Observation/g2' }],
  };

  test('groups results under their report and collects the rest', () => {
    const model = buildLabsModel([report], [older, newer, loose]);
    expect(model.panels.map((p) => p.title)).toEqual(['Metabolic panel', 'Other results']);
    expect(model.panels[0].results.map((r) => r.id)).toEqual(['g2']);
    expect(model.panels[1].results.map((r) => r.id).sort()).toEqual(['c1', 'g1']);
  });

  test('keeps each analyte history oldest first for its trend', () => {
    const model = buildLabsModel([report], [newer, older]);
    expect(model.history.get('2345-7')?.map((r) => r.value)).toEqual([98, 142]);
  });

  test('lists only analytes whose latest result is flagged', () => {
    const recovered = lab('g3', '2345-7', 90, '2026-07-01T10:00:00Z');
    expect(buildLabsModel([], [older, newer]).latestAbnormals.map((r) => r.id)).toEqual(['g2']);
    expect(buildLabsModel([], [older, newer, recovered]).latestAbnormals).toEqual([]);
  });

  test('ignores results entered in error', () => {
    const wrong = lab('x', '2345-7', 500, '2026-08-01T10:00:00Z', { status: 'entered-in-error' });
    expect(buildLabsModel([], [wrong]).panels).toEqual([]);
  });
});
