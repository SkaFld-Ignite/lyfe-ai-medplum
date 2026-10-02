// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Natural-language chart search, both sides of the wire.
 *
 * The first block is the drift guard the `patient-ai-summary.ts` convention
 * calls for: the app duplicates the bot's kinds and labels rather than importing
 * them, so something has to fail when the two disagree.
 *
 * The rest covers the two things this feature must never do — invent a result,
 * or invent a number. `parseSearchIntent` is the only thing standing between a
 * free-text model answer and a FHIR query, so it is tested against malformed,
 * padded and hostile output.
 */
import type { Condition, MedicationRequest, Observation } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import * as bot from '../../bots/shared/chart-search.ts';
import {
  buildChartSearchQueries,
  parseSearchIntent,
  sortChartSearchHits,
  toChartSearchHit,
} from '../../bots/shared/chart-search.ts';
import type { DocumentSearchHit } from '../services/document-search';
import { groupHitsByKind, SEARCH_KIND_LABELS, SEARCH_KINDS, toDocumentSearchHits } from './chart-search';

describe('codes shared with the bot', () => {
  test('match definition for definition', () => {
    expect(SEARCH_KINDS).toEqual(bot.SEARCH_KINDS);
    expect(SEARCH_KIND_LABELS).toEqual(bot.SEARCH_KIND_LABELS);
  });
});

describe('parseSearchIntent', () => {
  const plan = {
    kinds: ['condition'],
    terms: ['hypertension'],
    expandedTerms: ['high blood pressure', 'HTN'],
    interpretation: 'Conditions recorded as hypertension',
  };

  test('accepts a well-formed plan', () => {
    expect(parseSearchIntent(JSON.stringify(plan))).toEqual(plan);
  });

  test('accepts a plan wrapped in a code fence', () => {
    expect(parseSearchIntent('```json\n' + JSON.stringify(plan) + '\n```')).toEqual(plan);
  });

  test('throws on output that is not JSON', () => {
    expect(() => parseSearchIntent('The patient has hypertension.')).toThrow(/did not return JSON/);
  });

  test('throws on JSON that is not an object', () => {
    expect(() => parseSearchIntent('["condition"]')).toThrow(/not an object/);
  });

  test('drops kinds that are not record types', () => {
    const intent = parseSearchIntent(JSON.stringify({ ...plan, kinds: ['condition', 'horoscope', 'lab'] }));
    expect(intent.kinds).toEqual(['condition', 'lab']);
  });

  test('searches everything when the model named no usable kind', () => {
    // Not narrowing is not the same as asking for nothing, and an empty plan
    // would silently answer every question with "no matches".
    expect(parseSearchIntent(JSON.stringify({ ...plan, kinds: ['nonsense'] })).kinds).toEqual([...SEARCH_KINDS]);
  });

  test('dedupes a term the model repeated across both lists', () => {
    const intent = parseSearchIntent(
      JSON.stringify({ ...plan, terms: ['HTN'], expandedTerms: ['htn', 'hypertension'] })
    );
    expect(intent.terms).toEqual(['HTN']);
    expect(intent.expandedTerms).toEqual(['hypertension']);
  });

  test('strips commas out of a term, which are the OR delimiter in a :text value', () => {
    // A term carrying a comma would become two half-terms in the query.
    const intent = parseSearchIntent(JSON.stringify({ ...plan, terms: ['warfarin, coumadin'], expandedTerms: [] }));
    expect(intent.terms).toEqual(['warfarin  coumadin']);
  });

  test('caps the total number of terms', () => {
    const many = Array.from({ length: 40 }, (_, i) => `term${i}`);
    const intent = parseSearchIntent(JSON.stringify({ ...plan, terms: many, expandedTerms: many }));
    expect(intent.terms.length + intent.expandedTerms.length).toBeLessThanOrEqual(bot.MAX_TERMS);
  });

  test('ignores non-string entries rather than coercing them', () => {
    const intent = parseSearchIntent(JSON.stringify({ ...plan, terms: ['aspirin', 42, null, { a: 1 }] }));
    expect(intent.terms).toEqual(['aspirin']);
  });

  test('caps the interpretation and drops a non-string one', () => {
    expect(
      parseSearchIntent(JSON.stringify({ ...plan, interpretation: 'x'.repeat(5000) })).interpretation
    ).toHaveLength(bot.MAX_INTERPRETATION_CHARS);
    expect(parseSearchIntent(JSON.stringify({ ...plan, interpretation: 0.75 })).interpretation).toBeUndefined();
  });

  test('carries no confidence score, whatever the model sends', () => {
    // The whole point. Prod's schema had `confidence`, and its sibling features
    // filled the same field with a hardcoded 0.75 and an 85.0.
    const intent = parseSearchIntent(JSON.stringify({ ...plan, confidence: 0.99 }));
    expect(intent).not.toHaveProperty('confidence');
  });
});

describe('buildChartSearchQueries', () => {
  const intent = parseSearchIntent(
    JSON.stringify({
      kinds: ['condition', 'medication', 'lab', 'allergy', 'immunization', 'document'],
      terms: ['hypertension'],
      expandedTerms: ['HTN'],
      interpretation: 'x',
    })
  );
  const queries = buildChartSearchQueries({ patientId: 'pat-1', intent });

  test('ORs every term into one :text value per kind', () => {
    const condition = queries.find((q) => q.kind === 'condition');
    expect(condition?.resourceType).toBe('Condition');
    expect(condition?.params['code:text']).toBe('hypertension,HTN');
  });

  test('uses `patient` for the types whose search parameter is not `subject`', () => {
    // Getting this wrong is a silent empty result, not an error.
    expect(queries.find((q) => q.kind === 'allergy')?.params).toHaveProperty('patient', 'Patient/pat-1');
    expect(queries.find((q) => q.kind === 'immunization')?.params).toHaveProperty('patient', 'Patient/pat-1');
    expect(queries.find((q) => q.kind === 'condition')?.params).toHaveProperty('subject', 'Patient/pat-1');
  });

  test('separates labs from vitals by category', () => {
    expect(queries.find((q) => q.kind === 'lab')?.params).toHaveProperty('category', 'laboratory');
  });

  test('bounds every query', () => {
    for (const query of queries) {
      expect(query.params._count).toBe(String(bot.MAX_HITS_PER_KIND));
      expect(query.params._sort).toBeTruthy();
    }
  });

  test('never queries FHIR for documents — that leg is the pgvector index', () => {
    expect(queries.some((q) => q.kind === 'document')).toBe(false);
  });

  test('runs no query at all when the plan found no clinical term', () => {
    // Listing the whole chart would be a different feature pretending to answer.
    const empty = parseSearchIntent(JSON.stringify({ kinds: ['condition'], terms: [], expandedTerms: [] }));
    expect(buildChartSearchQueries({ patientId: 'pat-1', intent: empty })).toEqual([]);
  });
});

describe('toChartSearchHit', () => {
  test('a condition shows its concept and clinical status', () => {
    const condition: Condition = {
      resourceType: 'Condition',
      id: 'c1',
      subject: { reference: 'Patient/pat-1' },
      code: { text: 'Essential hypertension' },
      clinicalStatus: { coding: [{ code: 'active', display: 'Active' }] },
      onsetDateTime: '2021-03-04',
    };
    expect(toChartSearchHit(condition, 'condition')).toEqual({
      reference: 'Condition/c1',
      resourceType: 'Condition',
      kind: 'condition',
      title: 'Essential hypertension',
      detail: 'Active',
      date: '2021-03-04',
    });
  });

  test('a medication falls back to the reference display when there is no coded concept', () => {
    const request: MedicationRequest = {
      resourceType: 'MedicationRequest',
      id: 'm1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/pat-1' },
      medicationReference: { reference: 'Medication/x', display: 'Warfarin 5 mg tablet' },
      authoredOn: '2026-01-02',
    };
    const hit = toChartSearchHit(request, 'medication');
    expect(hit.title).toBe('Warfarin 5 mg tablet');
    expect(hit.detail).toBe('active');
  });

  test('an observation shows its value with units', () => {
    const observation: Observation = {
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { text: 'Creatinine' },
      valueQuantity: { value: 1.4, unit: 'mg/dL' },
      effectiveDateTime: '2026-09-01',
    };
    expect(toChartSearchHit(observation, 'lab').detail).toBe('1.4 mg/dL');
  });

  test('a resource with no readable title keeps its reference rather than being dropped', () => {
    // It matched a real query. Hiding it would be the one dishonest option.
    const hit = toChartSearchHit({ resourceType: 'Condition', id: 'c9', subject: {} }, 'condition');
    expect(hit.title).toBe('Condition/c9');
  });
});

describe('sortChartSearchHits', () => {
  test('newest first, undated last', () => {
    const sorted = sortChartSearchHits([
      { reference: 'a', resourceType: 'Condition', kind: 'condition', title: 'a' },
      { reference: 'b', resourceType: 'Condition', kind: 'condition', title: 'b', date: '2020-01-01' },
      { reference: 'c', resourceType: 'Condition', kind: 'condition', title: 'c', date: '2026-01-01' },
    ]);
    expect(sorted.map((h) => h.reference)).toEqual(['c', 'b', 'a']);
  });
});

describe('toDocumentSearchHits', () => {
  const hit = (over: Partial<DocumentSearchHit>): DocumentSearchHit => ({
    documentId: 'd1',
    chunkIndex: 0,
    snippet: 'Patient had a GI bleed in 2019.',
    distance: 0.2,
    title: 'Colonoscopy report',
    documentDate: '2019-05-05',
    contentType: 'application/pdf',
    ...over,
  });

  test('keeps the closest chunk per document', () => {
    // The index's grain is a chunk, and the worker returns them closest first,
    // so first-seen is best-seen. Three rows linking to one document would be
    // three links to the same place.
    const rows = toDocumentSearchHits([
      hit({ chunkIndex: 0, distance: 0.1, snippet: 'closest' }),
      hit({ chunkIndex: 4, distance: 0.4, snippet: 'further' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe('closest');
    expect(rows[0].reference).toBe('DocumentReference/d1');
  });

  test('normalises whitespace and labels an untitled document', () => {
    const rows = toDocumentSearchHits([hit({ title: null, snippet: 'line one\n\n  line two' })]);
    expect(rows[0].title).toBe('Untitled document');
    expect(rows[0].detail).toBe('line one line two');
  });
});

describe('groupHitsByKind', () => {
  test('keeps a searched kind with no matches, and omits one that was not searched', () => {
    const groups = groupHitsByKind({
      hits: [{ reference: 'Condition/c1', resourceType: 'Condition', kind: 'condition', title: 'HTN' }],
      kinds: ['condition', 'medication'],
    });
    expect(groups.map((g) => g.kind)).toEqual(['condition', 'medication']);
    expect(groups[1].hits).toEqual([]);
  });

  test('orders groups as SEARCH_KINDS lists them, not as the model returned them', () => {
    const groups = groupHitsByKind({ hits: [], kinds: ['document', 'condition'] });
    expect(groups.map((g) => g.kind)).toEqual(['condition', 'document']);
  });
});
