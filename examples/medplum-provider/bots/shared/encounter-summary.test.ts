// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The pure half of the encounter summaries: the two validators that stand in for
 * prod's Zod schemas, the prompt builders, and the Composition shape.
 *
 * The validators get the most attention here because they are load-bearing in a
 * way prod's schemas were not. `generateObject` had the provider enforce the
 * shape; `$ai` has no structured-output parameter, so a model that returns twelve
 * alerts, a misspelled severity or a bare sentence instead of JSON reaches
 * `parsePreVisitDraft` and `parsePostVisitDraft` and nothing else.
 */
import type { Composition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { CitationSource } from './ai-summary.ts';
import type { EncounterSummaryContext } from './encounter-summary-prompt.ts';
import {
  buildCitationIndex,
  buildPostVisitPrompt,
  buildPreVisitPrompt,
  buildTrendLines,
  encounterReason,
} from './encounter-summary-prompt.ts';
import {
  buildEncounterSummaryComposition,
  buildPostVisitSections,
  buildPreVisitSections,
  ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM,
  ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM,
  ENCOUNTER_SUMMARY_SECTION_SYSTEM,
  ENCOUNTER_SUMMARY_TYPE_SYSTEM,
  encounterSummarySearchQuery,
  MAX_ROWS,
  parsePostVisitDraft,
  parsePreVisitDraft,
  PROGRESS_NOTE_LOINC,
  sectionText,
} from './encounter-summary.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VISIT_DAY = '2026-09-28';
const NOW = new Date('2026-09-28T15:00:00.000Z');

function vital(
  id: string,
  name: string,
  value: number,
  unit: string,
  date: string
): EncounterSummaryContext['recentVitals'][number] {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    subject: { reference: 'Patient/p1' },
    category: [{ coding: [{ code: 'vital-signs' }] }],
    code: { text: name },
    effectiveDateTime: `${date}T09:00:00.000Z`,
    valueQuantity: { value, unit },
  };
}

function lab(
  id: string,
  name: string,
  value: number,
  unit: string,
  date: string
): EncounterSummaryContext['recentLabs'][number] {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    subject: { reference: 'Patient/p1' },
    category: [{ coding: [{ code: 'laboratory' }] }],
    code: { text: name },
    effectiveDateTime: `${date}T09:00:00.000Z`,
    valueQuantity: { value, unit },
  };
}

const context: EncounterSummaryContext = {
  encounter: {
    resourceType: 'Encounter',
    id: 'enc-1',
    status: 'finished',
    class: { code: 'AMB', display: 'ambulatory' },
    subject: { reference: 'Patient/p1' },
    type: [{ text: 'Office Visit' }],
    reasonCode: [{ text: 'NASH follow-up' }],
    period: { start: `${VISIT_DAY}T09:00:00.000Z` },
    location: [{ location: { display: 'Main Clinic' } }],
  },
  patient: { resourceType: 'Patient', id: 'p1', birthDate: '1972-04-11', gender: 'female' },
  conditions: [
    { resourceType: 'Condition', id: 'cond-nash', subject: { reference: 'Patient/p1' }, code: { text: 'NASH' } },
    { resourceType: 'Condition', id: 'cond-t2dm', subject: { reference: 'Patient/p1' }, code: { text: 'T2DM' } },
  ],
  medications: [
    {
      resourceType: 'MedicationRequest',
      id: 'med-metformin',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      medicationCodeableConcept: { text: 'Metformin 1000mg' },
      dosageInstruction: [{ text: 'BID' }],
    },
  ],
  allergies: [
    {
      resourceType: 'AllergyIntolerance',
      id: 'alg-pcn',
      patient: { reference: 'Patient/p1' },
      code: { text: 'Penicillin' },
      criticality: 'high',
    },
  ],
  recentVitals: [
    vital('vital-wt-new', 'Body weight', 212, 'lb', VISIT_DAY),
    vital('vital-wt-old', 'Body weight', 208, 'lb', '2026-08-01'),
  ],
  recentLabs: [
    lab('lab-ast-new', 'AST', 78, 'U/L', VISIT_DAY),
    lab('lab-ast-old', 'AST', 54, 'U/L', '2026-07-02'),
    lab('lab-a1c', 'HbA1c', 6.6, '%', '2026-08-15'),
  ],
  sameDayVitals: [vital('vital-wt-new', 'Body weight', 212, 'lb', VISIT_DAY)],
  sameDayLabs: [lab('lab-ast-new', 'AST', 78, 'U/L', VISIT_DAY)],
  priorEncounters: [
    {
      resourceType: 'Encounter',
      id: 'enc-0',
      status: 'finished',
      class: { code: 'AMB', display: 'ambulatory' },
      subject: { reference: 'Patient/p1' },
      type: [{ text: 'Office Visit' }],
      period: { start: '2026-06-20T09:00:00.000Z' },
    },
  ],
  notesByEncounter: {
    'Encounter/enc-1': 'A&P: NASH with rising transaminases. Start GLP-1.',
    'Encounter/enc-0': 'Planned to recheck LFTs in 3 months.',
  },
  longitudinalContext: 'Middle-aged female with NASH and T2DM, both progressing.',
  preVisitPlan: 'F/U NASH with elevated transaminases.',
};

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe('parsePreVisitDraft', () => {
  test('accepts a well-formed answer', () => {
    const draft = parsePreVisitDraft(
      JSON.stringify({
        reasonForVisit: 'F/U NASH with AST 78 [L1]',
        relevantHistory: [{ condition: 'NASH [C1]', relevance: 'The visit reason', status: 'chronic' }],
        currentMedications: [{ name: 'Metformin 1000mg BID [M1]', relevantToVisit: true, note: 'No GLP-1 on board' }],
        recentChanges: [{ change: 'AST 54 → 78', date: '3 weeks ago', significance: 'notable' }],
        prepItems: [{ item: 'Calculate FIB-4 today', priority: 'high' }],
      })
    );

    expect(draft.reasonForVisit).toBe('F/U NASH with AST 78 [L1]');
    expect(draft.relevantHistory).toEqual([
      { condition: 'NASH [C1]', relevance: 'The visit reason', status: 'chronic' },
    ]);
    expect(draft.currentMedications[0]).toEqual({
      name: 'Metformin 1000mg BID [M1]',
      relevantToVisit: true,
      note: 'No GLP-1 on board',
    });
    expect(draft.recentChanges[0].significance).toBe('notable');
    expect(draft.prepItems[0].priority).toBe('high');
  });

  test('strips a code fence the model wrapped the JSON in', () => {
    const draft = parsePreVisitDraft('```json\n{"reasonForVisit":"F/U NASH"}\n```');
    expect(draft.reasonForVisit).toBe('F/U NASH');
    expect(draft.prepItems).toEqual([]);
  });

  test('throws on a non-JSON answer', () => {
    expect(() => parsePreVisitDraft('Here is the briefing you asked for.')).toThrow('did not return JSON');
  });

  test('throws on JSON that is not an object', () => {
    expect(() => parsePreVisitDraft('[1, 2]')).toThrow('not an object');
  });

  test('throws when the one field the card cannot render without is missing', () => {
    expect(() => parsePreVisitDraft(JSON.stringify({ prepItems: [{ item: 'x', priority: 'high' }] }))).toThrow(
      'no reasonForVisit'
    );
  });

  test('drops malformed rows instead of the whole answer', () => {
    const draft = parsePreVisitDraft(
      JSON.stringify({
        reasonForVisit: 'F/U NASH',
        relevantHistory: [{ relevance: 'no condition name' }, { condition: 'NASH', relevance: 'kept' }],
        prepItems: 'not an array',
      })
    );
    expect(draft.relevantHistory).toHaveLength(1);
    expect(draft.relevantHistory[0].condition).toBe('NASH');
    expect(draft.prepItems).toEqual([]);
  });

  test('falls back on an unrecognised enum rather than dropping the row', () => {
    const draft = parsePreVisitDraft(
      JSON.stringify({
        reasonForVisit: 'F/U NASH',
        relevantHistory: [{ condition: 'NASH', relevance: 'x', status: 'WORSENING' }],
        recentChanges: [{ change: 'x', date: 'y', significance: 'huge' }],
        prepItems: [{ item: 'x', priority: 'URGENT' }],
      })
    );
    expect(draft.relevantHistory[0].status).toBe('active');
    expect(draft.recentChanges[0].significance).toBe('routine');
    expect(draft.prepItems[0].priority).toBe('medium');
  });

  test('accepts an upper-case enum, which is what a model usually sends', () => {
    const draft = parsePreVisitDraft(
      JSON.stringify({ reasonForVisit: 'x', prepItems: [{ item: 'y', priority: 'HIGH' }] })
    );
    expect(draft.prepItems[0].priority).toBe('high');
  });

  test('enforces the row caps the prompt only asked for', () => {
    const draft = parsePreVisitDraft(
      JSON.stringify({
        reasonForVisit: 'x',
        prepItems: Array.from({ length: 12 }, (_, i) => ({ item: `item ${i}`, priority: 'low' })),
        relevantHistory: Array.from({ length: 12 }, (_, i) => ({ condition: `c${i}`, relevance: 'r' })),
      })
    );
    expect(draft.prepItems).toHaveLength(MAX_ROWS.prepItems);
    expect(draft.relevantHistory).toHaveLength(MAX_ROWS.relevantHistory);
  });

  test('treats an omitted relevantToVisit as relevant and an empty note as null', () => {
    const draft = parsePreVisitDraft(
      JSON.stringify({
        reasonForVisit: 'x',
        currentMedications: [{ name: 'Metformin' }, { name: 'Lisinopril', relevantToVisit: false, note: '  ' }],
      })
    );
    expect(draft.currentMedications[0]).toEqual({ name: 'Metformin', relevantToVisit: true, note: null });
    expect(draft.currentMedications[1]).toEqual({ name: 'Lisinopril', relevantToVisit: false, note: null });
  });
});

describe('parsePostVisitDraft', () => {
  test('accepts a well-formed answer', () => {
    const draft = parsePostVisitDraft(
      JSON.stringify({
        visitOutcome: 'NASH addressed; semaglutide started.',
        keyFindings: [{ finding: 'AST 78 U/L [L1]', significance: 'abnormal' }],
        decisionsMade: [{ decision: 'Started semaglutide', rationale: 'BMI 32 + NASH' }],
        followUpPlan: [{ action: 'Recheck CMP + LFTs', timeframe: '12 weeks' }],
        unresolvedItems: [{ item: 'FibroScan', reason: 'Needs prior auth' }],
      })
    );
    expect(draft.visitOutcome).toBe('NASH addressed; semaglutide started.');
    expect(draft.keyFindings[0].significance).toBe('abnormal');
    expect(draft.followUpPlan[0].timeframe).toBe('12 weeks');
    expect(draft.unresolvedItems[0].reason).toBe('Needs prior auth');
  });

  test('throws when visitOutcome is missing', () => {
    expect(() => parsePostVisitDraft(JSON.stringify({ keyFindings: [] }))).toThrow('no visitOutcome');
  });

  test('defaults an unrecognised finding significance to normal', () => {
    const draft = parsePostVisitDraft(
      JSON.stringify({ visitOutcome: 'x', keyFindings: [{ finding: 'y', significance: 'very bad' }] })
    );
    expect(draft.keyFindings[0].significance).toBe('normal');
  });

  test('enforces the follow-up cap', () => {
    const draft = parsePostVisitDraft(
      JSON.stringify({
        visitOutcome: 'x',
        followUpPlan: Array.from({ length: 9 }, (_, i) => ({ action: `a${i}`, timeframe: '2 weeks' })),
      })
    );
    expect(draft.followUpPlan).toHaveLength(MAX_ROWS.followUpPlan);
  });

  test('strips NUL, which extracted document text carries', () => {
    const draft = parsePostVisitDraft(JSON.stringify({ visitOutcome: 'AST\u0000 78' }));
    expect(draft.visitOutcome).toBe('AST 78');
  });
});

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

describe('buildCitationIndex', () => {
  test('tags records positionally, in the order the prompt lists them', () => {
    const index = buildCitationIndex(context, 'pre-visit');
    expect(index.get('C1')?.reference).toEqual({ reference: 'Condition/cond-nash', display: 'NASH' });
    expect(index.get('C2')?.reference.reference).toBe('Condition/cond-t2dm');
    expect(index.get('M1')?.reference.reference).toBe('MedicationRequest/med-metformin');
    expect(index.get('A1')?.reference.reference).toBe('AllergyIntolerance/alg-pcn');
    expect(index.get('E1')?.reference.reference).toBe('Encounter/enc-0');
    expect(index.get('C9')).toBeUndefined();
  });

  test('sets Reference.display so the UI needs no second read', () => {
    const index = buildCitationIndex(context, 'pre-visit');
    expect(index.get('L1')?.reference.display).toContain('AST');
    expect(index.get('L1')?.reference.display).toContain('78');
  });

  test('cites the 90-day window pre-visit and only the visit day post-visit', () => {
    expect(buildCitationIndex(context, 'pre-visit').get('L2')?.reference.reference).toBe('Observation/lab-ast-old');
    // Post-visit cites what was measured at the visit, so there is no L2 at all.
    expect(buildCitationIndex(context, 'post-visit').get('L1')?.reference.reference).toBe('Observation/lab-ast-new');
    expect(buildCitationIndex(context, 'post-visit').get('L2')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const citations = new Map<string, CitationSource>([
  ['C1', { tag: 'C1', kind: 'condition', reference: { reference: 'Condition/cond-nash', display: 'NASH' } }],
  ['L1', { tag: 'L1', kind: 'lab', reference: { reference: 'Observation/lab-ast-new', display: 'AST: 78 U/L' } }],
]);

describe('buildPreVisitSections', () => {
  const sections = buildPreVisitSections(
    {
      reasonForVisit: 'F/U NASH [C1] with AST 78 [L1]',
      relevantHistory: [{ condition: 'NASH [C1]', relevance: 'Today’s problem', status: 'chronic' }],
      currentMedications: [{ name: 'Metformin', relevantToVisit: false, note: null }],
      recentChanges: [{ change: 'AST up', date: '3 weeks ago', significance: 'notable' }],
      prepItems: [{ item: 'Calculate FIB-4', priority: 'high' }],
    },
    citations
  );

  const codeOf = (index: number): string | undefined =>
    sections[index].code?.coding?.find((c) => c.system === ENCOUNTER_SUMMARY_SECTION_SYSTEM)?.code;

  test('writes one section per schema field, in schema order', () => {
    expect(sections.map((_, i) => codeOf(i))).toEqual([
      'reason-for-visit',
      'relevant-history',
      'current-medications',
      'recent-changes',
      'prep-items',
    ]);
  });

  test('rewrites prompt tags into entry offsets and carries the references', () => {
    const headline = sections[0];
    expect(headline.text?.div).toContain('F/U NASH [1] with AST 78 [2]');
    expect(headline.entry).toEqual([
      { reference: 'Condition/cond-nash', display: 'NASH' },
      { reference: 'Observation/lab-ast-new', display: 'AST: 78 U/L' },
    ]);
  });

  test('numbers each leaf section against its own entry list', () => {
    const row = sections[1].section?.[0];
    // `[C1]` was `[2]`-worthy nowhere: within this row's own entry[] it is `[1]`.
    expect(row?.title).toBe('NASH [1]');
    expect(row?.entry).toEqual([{ reference: 'Condition/cond-nash', display: 'NASH' }]);
  });

  test('puts the row qualifier on the row, which is what tints it', () => {
    const qualifier = (section: { code?: { coding?: { system?: string; code?: string }[] } } | undefined): unknown =>
      section?.code?.coding?.find((c) => c.system === ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM)?.code;
    expect(qualifier(sections[1].section?.[0])).toBe('chronic');
    expect(qualifier(sections[2].section?.[0])).toBe('not-relevant');
    expect(qualifier(sections[3].section?.[0])).toBe('notable');
    expect(qualifier(sections[4].section?.[0])).toBe('high');
  });

  test('keeps a detail-less row valid FHIR by repeating its headline as the narrative', () => {
    // `cmp-1` needs text, entries or sub-sections; `title` alone does not count.
    expect(sections[4].section?.[0].text?.div).toContain('Calculate FIB-4');
  });

  test('omits a block the model returned no rows for', () => {
    const sparse = buildPreVisitSections(
      {
        reasonForVisit: 'F/U NASH',
        relevantHistory: [],
        currentMedications: [],
        recentChanges: [],
        prepItems: [],
      },
      citations
    );
    expect(sparse).toHaveLength(1);
  });

  test('deletes a tag the index cannot resolve rather than rendering it', () => {
    const [headline] = buildPreVisitSections(
      {
        reasonForVisit: 'AST is rising [L9]',
        relevantHistory: [],
        currentMedications: [],
        recentChanges: [],
        prepItems: [],
      },
      citations
    );
    expect(headline.text?.div).toContain('AST is rising');
    expect(headline.text?.div).not.toContain('[L9]');
    expect(headline.entry).toBeUndefined();
  });

  test('escapes the narrative, because Narrative.div is parsed as XML', () => {
    const [headline] = buildPreVisitSections(
      {
        reasonForVisit: 'Hep B & C screen <pending>',
        relevantHistory: [],
        currentMedications: [],
        recentChanges: [],
        prepItems: [],
      },
      citations
    );
    expect(headline.text?.div).toContain('&amp;');
    expect(headline.text?.div).toContain('&lt;pending&gt;');
  });
});

describe('buildPostVisitSections', () => {
  const sections = buildPostVisitSections(
    {
      visitOutcome: 'NASH addressed [C1].',
      keyFindings: [{ finding: 'AST 78 [L1]', significance: 'abnormal' }],
      decisionsMade: [{ decision: 'Started semaglutide', rationale: 'BMI 32 + NASH' }],
      followUpPlan: [{ action: 'Recheck LFTs', timeframe: '12 weeks' }],
      unresolvedItems: [{ item: 'FibroScan', reason: 'Prior auth' }],
    },
    citations
  );

  test('writes one section per schema field, in schema order', () => {
    expect(
      sections.map((s) => s.code?.coding?.find((c) => c.system === ENCOUNTER_SUMMARY_SECTION_SYSTEM)?.code)
    ).toEqual(['visit-outcome', 'key-findings', 'decisions-made', 'follow-up-plan', 'unresolved-items']);
  });

  test('keeps the follow-up timeframe as narrative, not as a code', () => {
    // It is free text the model writes, and free text in a `code` would be a code
    // system with infinite members. The UI renders this one block's detail as a badge.
    const row = sections[3].section?.[0];
    expect(row?.title).toBe('Recheck LFTs');
    expect(row?.text?.div).toContain('12 weeks');
    expect(row?.code).toBeUndefined();
  });

  test('tints a key finding by its significance', () => {
    expect(sections[1].section?.[0].code?.coding?.[0]).toEqual({
      system: ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM,
      code: 'abnormal',
    });
  });
});

// ---------------------------------------------------------------------------
// The Composition
// ---------------------------------------------------------------------------

describe('buildEncounterSummaryComposition', () => {
  const build = (kind: 'pre-visit' | 'post-visit'): Composition =>
    buildEncounterSummaryComposition({
      kind,
      encounter: { reference: 'Encounter/enc-1' },
      patient: { reference: 'Patient/p1' },
      author: { reference: 'Device/dev-1', display: 'Lyfe Clinical AI' },
      draft:
        kind === 'pre-visit'
          ? {
              reasonForVisit: 'F/U NASH [C1]',
              relevantHistory: [],
              currentMedications: [],
              recentChanges: [],
              prepItems: [],
            }
          : { visitOutcome: 'Addressed', keyFindings: [], decisionsMade: [], followUpPlan: [], unresolvedItems: [] },
      citations,
      generatedAt: '2026-09-28T15:00:00.000Z',
      account: { reference: 'Organization/org-1' },
    });

  test('keys the identifier on the encounter, which is what makes regeneration an upsert', () => {
    expect(build('pre-visit').identifier).toEqual({
      system: ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM['pre-visit'],
      value: 'enc-1',
    });
    expect(build('post-visit').identifier?.system).toBe(ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM['post-visit']);
  });

  test('sets encounter and subject, so the summary hangs off the visit', () => {
    const composition = build('post-visit');
    expect(composition.encounter).toEqual({ reference: 'Encounter/enc-1' });
    expect(composition.subject).toEqual({ reference: 'Patient/p1' });
  });

  test('is final when just generated', () => {
    expect(build('pre-visit').status).toBe('final');
  });

  test('distinguishes the two by type, and claims a LOINC only for the one that has one', () => {
    expect(build('pre-visit').type.coding).toEqual([{ system: ENCOUNTER_SUMMARY_TYPE_SYSTEM, code: 'pre-visit' }]);
    expect(build('post-visit').type.coding).toEqual([
      { system: ENCOUNTER_SUMMARY_TYPE_SYSTEM, code: 'post-visit' },
      { system: 'http://loinc.org', code: PROGRESS_NOTE_LOINC, display: 'Progress note' },
    ]);
  });

  test('writes both compartment keys, or clinic users cannot see it at all', () => {
    expect(build('pre-visit').meta).toEqual({
      account: { reference: 'Organization/org-1' },
      accounts: [{ reference: 'Organization/org-1' }],
    });
  });

  test('carries no id, so the conditional update is a replace-or-create', () => {
    expect(build('pre-visit').id).toBeUndefined();
  });
});

describe('encounterSummarySearchQuery', () => {
  test('is an exact system|value match per kind', () => {
    expect(encounterSummarySearchQuery('pre-visit', 'enc-1')).toBe(
      'identifier=https%3A%2F%2Flyfe.com%2Fpre-visit-summary%7Cenc-1'
    );
    expect(encounterSummarySearchQuery('post-visit', 'enc-1')).not.toBe(
      encounterSummarySearchQuery('pre-visit', 'enc-1')
    );
  });
});

describe('sectionText', () => {
  test('reads one section back out as plain text, unescaped', () => {
    const composition = buildEncounterSummaryComposition({
      kind: 'pre-visit',
      encounter: { reference: 'Encounter/enc-1' },
      patient: { reference: 'Patient/p1' },
      author: { reference: 'Device/dev-1' },
      draft: {
        reasonForVisit: 'Hep B & C screen',
        relevantHistory: [],
        currentMedications: [],
        recentChanges: [],
        prepItems: [],
      },
      citations,
      generatedAt: NOW.toISOString(),
    });
    expect(sectionText(composition, ENCOUNTER_SUMMARY_SECTION_SYSTEM, 'reason-for-visit')).toBe('Hep B & C screen');
    expect(sectionText(composition, ENCOUNTER_SUMMARY_SECTION_SYSTEM, 'prep-items')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('buildTrendLines', () => {
  test('groups by test and shows oldest to newest with a numeric delta', () => {
    const [line] = buildTrendLines([
      lab('a', 'AST', 78, 'U/L', '2026-09-28'),
      lab('b', 'AST', 54, 'U/L', '2026-07-02'),
    ]);
    expect(line).toContain('AST');
    expect(line.indexOf('54')).toBeLessThan(line.indexOf('78'));
    expect(line).toContain('↑ 24');
  });

  test('marks a falling trend', () => {
    const [line] = buildTrendLines([
      lab('a', 'HbA1c', 6.6, '%', '2026-09-01'),
      lab('b', 'HbA1c', 7.2, '%', '2026-06-01'),
    ]);
    expect(line).toContain('↓ 0.6');
  });

  test('omits the delta for a single datapoint', () => {
    const [line] = buildTrendLines([lab('a', 'AST', 78, 'U/L', '2026-09-28')]);
    expect(line).not.toContain('↑');
    expect(line).not.toContain('↓');
  });

  test('keeps one line per test', () => {
    const lines = buildTrendLines(context.recentLabs);
    expect(lines).toHaveLength(2);
  });
});

describe('encounterReason', () => {
  test('prefers reasonCode, then type, then class', () => {
    expect(encounterReason(context.encounter)).toBe('NASH follow-up');
    expect(encounterReason({ ...context.encounter, reasonCode: undefined })).toBe('Office Visit');
    expect(encounterReason({ resourceType: 'Encounter', status: 'planned', class: { display: 'virtual' } })).toBe(
      'virtual'
    );
  });
});

describe('buildPreVisitPrompt', () => {
  const prompt = buildPreVisitPrompt(context, NOW);

  test('tags every citable record with the tag the index uses', () => {
    expect(prompt).toContain('- [C1] NASH');
    expect(prompt).toContain('- [M1] Metformin 1000mg BID');
    expect(prompt).toContain('- [A1] Penicillin (high)');
    expect(prompt).toContain('[E1] 2026-06-20');
  });

  test('reads the 90-day window, not just the visit day', () => {
    expect(prompt).toContain('[L2]');
    expect(prompt).toContain('VITALS TREND');
  });

  test('carries the longitudinal context prod spliced in from patient.aiSummary', () => {
    expect(prompt).toContain('LONGITUDINAL CONTEXT');
    expect(prompt).toContain('both progressing');
  });

  test('includes prior visits with their chart notes, for the unaddressed-item rule', () => {
    expect(prompt).toContain('Planned to recheck LFTs in 3 months.');
  });

  test('never includes the patient name', () => {
    expect(prompt).toContain('54yo female');
    expect(prompt).not.toMatch(/\bname\b/i);
  });

  test('says so explicitly when a block is empty', () => {
    const empty = buildPreVisitPrompt(
      {
        ...context,
        conditions: [],
        medications: [],
        allergies: [],
        recentVitals: [],
        recentLabs: [],
        priorEncounters: [],
      },
      NOW
    );
    expect(empty).toContain('None documented');
    expect(empty).toContain('No vitals recorded');
    expect(empty).toContain('No prior visits');
    expect(empty).toContain('No trend (insufficient datapoints)');
  });
});

describe('buildPostVisitPrompt', () => {
  const prompt = buildPostVisitPrompt(context, NOW);

  test('scopes "this visit" to the visit day', () => {
    expect(prompt).toContain('VITALS THIS VISIT');
    expect(prompt).toContain('[L1] AST');
    // The older AST is history, not a finding from this visit, so it is not citable.
    expect(prompt).not.toContain('[L2]');
  });

  test('carries this encounter’s chart note, which is what it summarises', () => {
    expect(prompt).toContain('Start GLP-1.');
  });

  test('carries the stored pre-visit plan for the planned-versus-actual line', () => {
    expect(prompt).toContain('PRE-VISIT PLAN');
    expect(prompt).toContain('F/U NASH with elevated transaminases.');
  });

  test('keeps the history only as trend context', () => {
    expect(prompt).toContain('LABS TREND (history');
    expect(prompt).toContain('54');
  });

  test('says so when there is no note to summarise', () => {
    expect(buildPostVisitPrompt({ ...context, notesByEncounter: {} }, NOW)).toContain(
      'No clinical note available for this encounter.'
    );
  });
});
