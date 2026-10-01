// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The read side of the AI summary Composition.
 *
 * The round-trip tests here build a Composition with the bot's own builder and
 * parse it back with the app's parser, so the two cannot drift apart without a
 * failure. That matters more than usual: the only thing joining them is a set of
 * code strings, and the last time this repo relied on matching strings across the
 * bot/app boundary a one-word difference emptied three screens in silence.
 */
import type { Composition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { PatientChart } from '../../bots/shared/ai-summary-prompt.ts';
import { buildCitationIndex } from '../../bots/shared/ai-summary-prompt.ts';
import * as botCodes from '../../bots/shared/ai-summary.ts';
import { buildSummaryComposition, parseSummaryDraft } from '../../bots/shared/ai-summary.ts';
import {
  AI_SUMMARY_IDENTIFIER_SYSTEM,
  AI_SUMMARY_RISK_LEVEL_SYSTEM,
  AI_SUMMARY_SECTION_SYSTEM,
  AI_SUMMARY_SEVERITY_SYSTEM,
  aiSummarySearchQuery,
  parseAiSummaryComposition,
  plainTextFromDiv,
  resolveCitations,
} from './patient-ai-summary';

describe('codes shared with the bot', () => {
  test('match definition for definition', () => {
    // Duplicated rather than imported, per the `LYFE_SOURCE_TAG_SYSTEM` convention
    // — one definition per side of the wire. This is the guard that convention
    // was missing.
    expect(AI_SUMMARY_IDENTIFIER_SYSTEM).toBe(botCodes.AI_SUMMARY_IDENTIFIER_SYSTEM);
    expect(AI_SUMMARY_SECTION_SYSTEM).toBe(botCodes.AI_SUMMARY_SECTION_SYSTEM);
    expect(AI_SUMMARY_SEVERITY_SYSTEM).toBe(botCodes.AI_SUMMARY_SEVERITY_SYSTEM);
    expect(AI_SUMMARY_RISK_LEVEL_SYSTEM).toBe(botCodes.AI_SUMMARY_RISK_LEVEL_SYSTEM);
    expect(aiSummarySearchQuery('p1')).toBe(botCodes.summarySearchQuery('p1'));
  });
});

// ---------------------------------------------------------------------------
// Round trip through the bot's builder
// ---------------------------------------------------------------------------

const chart: PatientChart = {
  patient: { resourceType: 'Patient', id: 'p1', birthDate: '1961-03-02' },
  conditions: [
    {
      resourceType: 'Condition',
      id: 'cond-dm',
      subject: { reference: 'Patient/p1' },
      code: { text: 'Type 2 diabetes' },
    },
    { resourceType: 'Condition', id: 'cond-ckd', subject: { reference: 'Patient/p1' }, code: { text: 'CKD stage 3' } },
  ],
  medications: [
    {
      resourceType: 'MedicationRequest',
      id: 'med-1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      medicationCodeableConcept: { text: 'Metformin 1000 mg' },
    },
  ],
  allergies: [],
  labs: [
    {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      subject: { reference: 'Patient/p1' },
      code: { text: 'Hemoglobin A1c' },
      valueQuantity: { value: 9.1, unit: '%' },
    },
  ],
  vitals: [],
  encounters: [],
  appointments: [],
  documents: [],
};

function roundTrip(answer: Record<string, unknown>, status: Composition['status'] = 'final'): Composition {
  const composition = buildSummaryComposition({
    patient: { reference: 'Patient/p1' },
    author: { reference: 'Device/dev-1', display: 'Lyfe Clinical AI' },
    generatedAt: '2026-09-30T12:00:00.000Z',
    citations: buildCitationIndex(chart),
    draft: parseSummaryDraft(JSON.stringify(answer)),
  });
  return { ...composition, id: 'comp-1', status };
}

const FULL = {
  narrative: 'Diabetes [C1] is uncontrolled alongside CKD 3 [C2].',
  alerts: [{ severity: 'critical', message: 'A1c 9.1% [L1]', action: 'Intensify therapy' }],
  risks: [{ factor: 'Diabetic nephropathy [C2]', level: 'high', basis: 'eGFR falling' }],
  focusAreas: [{ topic: 'Add a second agent [M1]', reason: 'Monotherapy is not holding' }],
  careGaps: [{ gap: 'No retinal screening in 18 months', recommendation: 'Refer to ophthalmology' }],
};

describe('parseAiSummaryComposition', () => {
  test('reads every block back out of what the bot wrote', () => {
    const summary = parseAiSummaryComposition(roundTrip(FULL));
    expect(summary.compositionId).toBe('comp-1');
    expect(summary.generatedAt).toBe('2026-09-30T12:00:00.000Z');
    expect(summary.narrative.headline).toBe('Diabetes [1] is uncontrolled alongside CKD 3 [2].');
    expect(summary.alerts).toHaveLength(1);
    expect(summary.risks).toHaveLength(1);
    expect(summary.focusAreas).toHaveLength(1);
    expect(summary.careGaps).toHaveLength(1);
  });

  test('resolves each marker to the resource the bot cited', () => {
    const summary = parseAiSummaryComposition(roundTrip(FULL));
    expect(summary.narrative.citations).toEqual([
      {
        index: 1,
        reference: 'Condition/cond-dm',
        resourceType: 'Condition',
        label: 'Type 2 diabetes',
        kind: 'condition',
      },
      { index: 2, reference: 'Condition/cond-ckd', resourceType: 'Condition', label: 'CKD stage 3', kind: 'condition' },
    ]);
    expect(summary.alerts[0].citations).toEqual([
      {
        index: 1,
        reference: 'Observation/obs-1',
        resourceType: 'Observation',
        label: 'Hemoglobin A1c: 9.1%',
        kind: 'lab',
      },
    ]);
    expect(summary.focusAreas[0].citations[0].kind).toBe('medication');
  });

  test('carries severity and level through as codes, not as text', () => {
    const summary = parseAiSummaryComposition(roundTrip(FULL));
    expect(summary.alerts[0].severity).toBe('critical');
    expect(summary.risks[0].level).toBe('high');
  });

  test('splits a row into its headline and its detail', () => {
    const summary = parseAiSummaryComposition(roundTrip(FULL));
    expect(summary.alerts[0].headline).toBe('A1c 9.1% [1]');
    expect(summary.alerts[0].detail).toBe('Intensify therapy');
    expect(summary.careGaps[0].detail).toBe('Refer to ophthalmology');
  });

  test('does not repeat the headline as the detail when the bot had nothing else to put there', () => {
    const summary = parseAiSummaryComposition(
      roundTrip({ narrative: 'x', careGaps: [{ gap: 'No HbA1c in 12 months', recommendation: '' }] })
    );
    expect(summary.careGaps[0].headline).toBe('No HbA1c in 12 months');
    expect(summary.careGaps[0].detail).toBeUndefined();
  });

  test('reads staleness off the status and nothing else', () => {
    expect(parseAiSummaryComposition(roundTrip(FULL, 'final')).stale).toBe(false);
    expect(parseAiSummaryComposition(roundTrip(FULL, 'preliminary')).stale).toBe(true);
  });

  test('lists every cited resource once in the footer, across all sections', () => {
    // CKD is cited in both the narrative and the risk row, with a different marker
    // in each, so deduping has to be on the reference rather than the marker.
    const summary = parseAiSummaryComposition(roundTrip(FULL));
    expect(summary.sources.map((s) => s.reference)).toEqual([
      'Condition/cond-dm',
      'Condition/cond-ckd',
      'Observation/obs-1',
      'MedicationRequest/med-1',
    ]);
  });

  test('renders a block the bot omitted as empty rather than throwing', () => {
    const summary = parseAiSummaryComposition(roundTrip({ narrative: 'Nothing of note.' }));
    expect(summary.narrative.headline).toBe('Nothing of note.');
    expect(summary.alerts).toEqual([]);
    expect(summary.risks).toEqual([]);
    expect(summary.sources).toEqual([]);
  });

  test('survives a Composition with no sections at all', () => {
    const summary = parseAiSummaryComposition({
      resourceType: 'Composition',
      id: 'comp-1',
      status: 'final',
      type: {},
      date: '2026-09-30T12:00:00.000Z',
      author: [],
      title: 'AI Patient Summary',
    });
    expect(summary.narrative.headline).toBe('');
    expect(summary.alerts).toEqual([]);
  });

  test('falls back on an unrecognised severity or level instead of dropping the row', () => {
    const summary = parseAiSummaryComposition({
      resourceType: 'Composition',
      id: 'comp-1',
      status: 'final',
      type: {},
      date: '2026-09-30T12:00:00.000Z',
      author: [],
      title: 'AI Patient Summary',
      section: [
        {
          code: { coding: [{ system: AI_SUMMARY_SECTION_SYSTEM, code: 'alerts' }] },
          section: [{ title: 'Something', code: { coding: [{ system: 'urn:other', code: 'nope' }] } }],
        },
        {
          code: { coding: [{ system: AI_SUMMARY_SECTION_SYSTEM, code: 'risks' }] },
          section: [{ title: 'Something else' }],
        },
      ],
    });
    expect(summary.alerts[0].severity).toBe('info');
    expect(summary.risks[0].level).toBe('low');
  });
});

describe('resolveCitations', () => {
  const entries = [
    { reference: 'Condition/a', display: 'A' },
    { reference: 'Condition/b', display: 'B' },
  ];

  test('ignores a marker past the end of the entry list', () => {
    // The stored form makes this impossible to produce, but a hand-edited or
    // partially written Composition should degrade to plain text rather than
    // render a chip pointing nowhere.
    expect(resolveCitations({ entry: entries }, ['See [1] and [5].'])).toEqual([
      { index: 1, reference: 'Condition/a', resourceType: 'Condition', label: 'A', kind: 'condition' },
    ]);
  });

  test('ignores every marker when the section carries no entries', () => {
    expect(resolveCitations({}, ['See [1].'])).toEqual([]);
  });

  test('returns each marker once, in index order', () => {
    expect(resolveCitations({ entry: entries }, ['[2] then [1]', 'and [2] again']).map((c) => c.index)).toEqual([1, 2]);
  });
});

describe('plainTextFromDiv', () => {
  test('unescapes what the bot escaped on the way in', () => {
    expect(plainTextFromDiv('<div xmlns="http://www.w3.org/1999/xhtml"><p>Tylenol &amp; codeine</p></div>')).toBe(
      'Tylenol & codeine'
    );
  });

  test('strips tags rather than interpreting them, so model text cannot become markup', () => {
    expect(plainTextFromDiv('<div><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>')).toBe(
      '<script>alert(1)</script>'
    );
  });

  test('is empty for a missing narrative', () => {
    expect(plainTextFromDiv(undefined)).toBe('');
  });
});
