// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The read side of the encounter summary Compositions.
 *
 * The round-trip tests build a Composition with the bot's own builder and parse
 * it back with the app's parser, so the two cannot drift apart without a failure
 * — the same guard `patient-ai-summary.test.ts` puts on its half of the wire, for
 * the same reason: the only thing joining the bot and the app is a set of code
 * strings.
 */
import type { Composition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { CitationSource } from '../../bots/shared/ai-summary.ts';
import * as botCodes from '../../bots/shared/encounter-summary.ts';
import { buildEncounterSummaryComposition } from '../../bots/shared/encounter-summary.ts';
import {
  COMPOSITION_TITLES,
  ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM,
  ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM,
  ENCOUNTER_SUMMARY_SECTION_SYSTEM,
  encounterSummarySearchQuery,
  formatPostVisitSummaryForNote,
  inferSummaryKind,
  parseEncounterSummary,
  SECTION_TITLES,
} from './encounter-ai-summary';

describe('codes shared with the bot', () => {
  test('match definition for definition', () => {
    // Duplicated rather than imported, per the `LYFE_SOURCE_TAG_SYSTEM`
    // convention — one definition per side of the wire. This is the guard.
    expect(ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM).toEqual(botCodes.ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM);
    expect(ENCOUNTER_SUMMARY_SECTION_SYSTEM).toBe(botCodes.ENCOUNTER_SUMMARY_SECTION_SYSTEM);
    expect(ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM).toBe(botCodes.ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM);
    expect(SECTION_TITLES).toEqual(botCodes.SECTION_TITLES);
    expect(COMPOSITION_TITLES).toEqual(botCodes.COMPOSITION_TITLES);
    expect(encounterSummarySearchQuery('pre-visit', 'enc-1')).toBe(
      botCodes.encounterSummarySearchQuery('pre-visit', 'enc-1')
    );
    expect(encounterSummarySearchQuery('post-visit', 'enc-1')).toBe(
      botCodes.encounterSummarySearchQuery('post-visit', 'enc-1')
    );
  });
});

describe('inferSummaryKind', () => {
  test('gives a finished visit the progress note and everything else the briefing', () => {
    expect(inferSummaryKind({ resourceType: 'Encounter', status: 'finished', class: {} })).toBe('post-visit');
    expect(inferSummaryKind({ resourceType: 'Encounter', status: 'planned', class: {} })).toBe('pre-visit');
    expect(inferSummaryKind({ resourceType: 'Encounter', status: 'in-progress', class: {} })).toBe('pre-visit');
  });
});

// ---------------------------------------------------------------------------
// Round trip through the bot's builder
// ---------------------------------------------------------------------------

const citations = new Map<string, CitationSource>([
  ['C1', { tag: 'C1', kind: 'condition', reference: { reference: 'Condition/cond-nash', display: 'NASH' } }],
  ['L1', { tag: 'L1', kind: 'lab', reference: { reference: 'Observation/lab-ast', display: 'AST: 78 U/L' } }],
  ['M1', { tag: 'M1', kind: 'medication', reference: { reference: 'MedicationRequest/med-1', display: 'Metformin' } }],
]);

function preVisit(): Composition {
  return buildEncounterSummaryComposition({
    kind: 'pre-visit',
    encounter: { reference: 'Encounter/enc-1' },
    patient: { reference: 'Patient/p1' },
    author: { reference: 'Device/dev-1' },
    draft: {
      reasonForVisit: 'F/U NASH [C1] with AST 78 [L1]',
      relevantHistory: [{ condition: 'NASH [C1]', relevance: 'The visit reason', status: 'chronic' }],
      currentMedications: [
        { name: 'Metformin [M1]', relevantToVisit: true, note: 'No GLP-1 on board' },
        { name: 'Lisinopril', relevantToVisit: false, note: null },
      ],
      recentChanges: [{ change: 'AST 54 → 78', date: '3 weeks ago', significance: 'notable' }],
      prepItems: [
        { item: 'Calculate FIB-4', priority: 'high' },
        { item: 'Ask about alcohol', priority: 'low' },
      ],
    },
    citations,
    generatedAt: '2026-09-28T15:00:00.000Z',
  });
}

function postVisit(): Composition {
  return buildEncounterSummaryComposition({
    kind: 'post-visit',
    encounter: { reference: 'Encounter/enc-1' },
    patient: { reference: 'Patient/p1' },
    author: { reference: 'Device/dev-1' },
    draft: {
      visitOutcome: 'NASH addressed [C1]; semaglutide started.',
      keyFindings: [
        { finding: 'AST 78 U/L [L1]', significance: 'abnormal' },
        { finding: 'BP 118/74', significance: 'normal' },
      ],
      decisionsMade: [{ decision: 'Started semaglutide 0.25mg weekly', rationale: 'BMI 32 + NASH, no GLP-1' }],
      followUpPlan: [{ action: 'Recheck CMP + LFTs', timeframe: '12 weeks' }],
      unresolvedItems: [{ item: 'FibroScan', reason: 'Needs prior auth' }],
    },
    citations,
    generatedAt: '2026-09-28T15:00:00.000Z',
  });
}

describe('parseEncounterSummary, pre-visit', () => {
  const summary = parseEncounterSummary(preVisit(), 'pre-visit');

  test('reads the headline back as plain text with its markers intact', () => {
    expect(summary.headline.headline).toBe('F/U NASH [1] with AST 78 [2]');
  });

  test('resolves each marker against the section it belongs to', () => {
    expect(summary.headline.citations).toEqual([
      { index: 1, reference: 'Condition/cond-nash', resourceType: 'Condition', label: 'NASH', kind: 'condition' },
      { index: 2, reference: 'Observation/lab-ast', resourceType: 'Observation', label: 'AST: 78 U/L', kind: 'lab' },
    ]);
  });

  test('returns the blocks in prod’s reading order, titled', () => {
    expect(summary.blocks.map((block) => block.code)).toEqual([
      'relevant-history',
      'recent-changes',
      'current-medications',
      'prep-items',
    ]);
    expect(summary.blocks[3].title).toBe('Preparation');
  });

  test('carries the qualifier that tints each row', () => {
    expect(summary.blocks[0].rows[0].qualifier).toBe('chronic');
    expect(summary.blocks[1].rows[0].qualifier).toBe('notable');
    expect(summary.blocks[2].rows.map((row) => row.qualifier)).toEqual(['relevant', 'not-relevant']);
    expect(summary.blocks[3].rows.map((row) => row.qualifier)).toEqual(['high', 'low']);
  });

  test('keeps the supporting line, and drops it when it is just the headline again', () => {
    expect(summary.blocks[0].rows[0].detail).toBe('The visit reason');
    // A prep item has no detail, so the bot repeated the headline into the
    // narrative to keep the section valid. Rendering it twice would look like a bug.
    expect(summary.blocks[3].rows[0].detail).toBeUndefined();
  });

  test('renumbers a row’s markers against its own entries', () => {
    expect(summary.blocks[0].rows[0].headline).toBe('NASH [1]');
    expect(summary.blocks[0].rows[0].citations[0].reference).toBe('Condition/cond-nash');
  });

  test('dedupes the sources footer on the reference, not the marker', () => {
    // NASH is [1] in the headline and [1] again in its own history row.
    expect(summary.sources.map((citation) => citation.reference)).toEqual([
      'Condition/cond-nash',
      'Observation/lab-ast',
      'MedicationRequest/med-1',
    ]);
  });

  test('reports freshness from Composition.status and the date', () => {
    expect(summary.stale).toBe(false);
    expect(summary.generatedAt).toBe('2026-09-28T15:00:00.000Z');
    expect(parseEncounterSummary({ ...preVisit(), status: 'preliminary' }, 'pre-visit').stale).toBe(true);
  });
});

describe('parseEncounterSummary, post-visit', () => {
  const summary = parseEncounterSummary(postVisit(), 'post-visit');

  test('reads the outcome as the headline', () => {
    expect(summary.headline.headline).toBe('NASH addressed [1]; semaglutide started.');
  });

  test('returns the blocks in prod’s reading order', () => {
    expect(summary.blocks.map((block) => block.code)).toEqual([
      'key-findings',
      'decisions-made',
      'follow-up-plan',
      'unresolved-items',
    ]);
  });

  test('carries the finding significance that tints each row', () => {
    expect(summary.blocks[0].rows.map((row) => row.qualifier)).toEqual(['abnormal', 'normal']);
  });

  test('exposes the follow-up timeframe as the row detail, which the UI renders as a badge', () => {
    expect(summary.blocks[2].rows[0]).toMatchObject({ headline: 'Recheck CMP + LFTs', detail: '12 weeks' });
    expect(summary.blocks[2].rows[0].qualifier).toBeUndefined();
  });
});

describe('parseEncounterSummary tolerance', () => {
  test('still renders the blocks when the headline section is missing', () => {
    const composition = preVisit();
    const summary = parseEncounterSummary({ ...composition, section: composition.section?.slice(1) }, 'pre-visit');
    expect(summary.headline.headline).toBe('');
    expect(summary.blocks).toHaveLength(4);
  });

  test('omits a block the Composition does not carry rather than returning it empty', () => {
    const summary = parseEncounterSummary({ ...preVisit(), section: [] }, 'pre-visit');
    expect(summary.blocks).toEqual([]);
    expect(summary.sources).toEqual([]);
  });

  test('passes an unrecognised qualifier through, so the row renders untinted', () => {
    const composition = preVisit();
    const prepItems = composition.section?.[4];
    const patched: Composition = {
      ...composition,
      section: [
        ...(composition.section?.slice(0, 4) ?? []),
        {
          ...prepItems,
          section: [
            {
              ...prepItems?.section?.[0],
              code: { coding: [{ system: ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM, code: 'URGENT' }] },
            },
          ],
        },
      ],
    };
    expect(parseEncounterSummary(patched, 'pre-visit').blocks[3].rows[0].qualifier).toBe('URGENT');
  });

  test('drops a marker that points past the section’s entries', () => {
    const composition = preVisit();
    const headline = composition.section?.[0];
    const patched: Composition = {
      ...composition,
      section: [{ ...headline, entry: headline?.entry?.slice(0, 1) }, ...(composition.section?.slice(1) ?? [])],
    };
    const summary = parseEncounterSummary(patched, 'pre-visit');
    // The text keeps `[2]`; the UI renders it as plain text rather than a dead chip.
    expect(summary.headline.headline).toContain('[2]');
    expect(summary.headline.citations.map((c) => c.index)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Pull into note
// ---------------------------------------------------------------------------

describe('formatPostVisitSummaryForNote', () => {
  const text = formatPostVisitSummaryForNote(parseEncounterSummary(postVisit(), 'post-visit'));

  test('writes prod’s headings and dash conventions', () => {
    expect(text).toBe(
      [
        'NASH addressed; semaglutide started.',
        '',
        'Key Findings:',
        '- AST 78 U/L (abnormal)',
        '- BP 118/74 (normal)',
        '',
        'Decisions:',
        '- Started semaglutide 0.25mg weekly — BMI 32 + NASH, no GLP-1',
        '',
        'Follow-Up:',
        '- Recheck CMP + LFTs (12 weeks)',
        '',
        'Unresolved:',
        '- FibroScan — Needs prior auth',
      ].join('\n')
    );
  });

  test('strips citation markers, which mean nothing once the text leaves the card', () => {
    expect(text).not.toMatch(/\[\d+\]/);
  });

  test('omits a block the summary does not have', () => {
    const sparse = formatPostVisitSummaryForNote({
      ...parseEncounterSummary(postVisit(), 'post-visit'),
      blocks: [],
    });
    expect(sparse).toBe('NASH addressed; semaglutide started.');
  });
});
