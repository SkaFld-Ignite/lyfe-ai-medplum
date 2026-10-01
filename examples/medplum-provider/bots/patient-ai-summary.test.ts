// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * What these cover, and why those things and not others.
 *
 * Three decisions in this feature can be silently wrong in a way that reaches a
 * provider as a plausible-looking clinical statement, so they are the ones
 * pinned down here:
 *
 *  1. **The schema.** A malformed row must be dropped, not rendered half-built,
 *     and a missing narrative must fail loudly rather than produce an empty card.
 *  2. **The citation mapping.** A marker that points at the wrong resource is
 *     the worst possible failure — a true sentence citing an unrelated record.
 *     An unresolvable tag must leave the text, not survive as `[C9]`.
 *  3. **The Composition shape.** Staleness lives in `status` and citations live
 *     in `section.entry`; if either moves, the card and the subscription both
 *     stop working, and neither fails loudly.
 */
import type { AllergyIntolerance, Condition, MedicationRequest, Observation, Reference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { isInvalidation, resolvePatientId } from './patient-ai-summary.ts';
import type { PatientChart } from './shared/ai-summary-prompt.ts';
import { buildChartPrompt, buildCitationIndex } from './shared/ai-summary-prompt.ts';
import type { CitationSource } from './shared/ai-summary.ts';
import {
  AI_SUMMARY_IDENTIFIER_SYSTEM,
  buildSummaryComposition,
  escapeXhtml,
  MAX_ALERTS,
  parseSummaryDraft,
  PATIENT_SUMMARY_LOINC,
  rewriteCitations,
  summarySearchQuery,
} from './shared/ai-summary.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIABETES: Condition = {
  resourceType: 'Condition',
  id: 'cond-dm',
  subject: { reference: 'Patient/p1' },
  code: { text: 'Type 2 diabetes mellitus' },
};

const CKD: Condition = {
  resourceType: 'Condition',
  id: 'cond-ckd',
  subject: { reference: 'Patient/p1' },
  code: { text: 'Chronic kidney disease stage 3' },
};

const METFORMIN: MedicationRequest = {
  resourceType: 'MedicationRequest',
  id: 'med-metformin',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/p1' },
  medicationCodeableConcept: { text: 'Metformin 1000 mg' },
  dosageInstruction: [{ text: 'Twice daily with food' }],
};

const PENICILLIN: AllergyIntolerance = {
  resourceType: 'AllergyIntolerance',
  id: 'allergy-pcn',
  patient: { reference: 'Patient/p1' },
  code: { text: 'Penicillin' },
  criticality: 'high',
};

const HBA1C: Observation = {
  resourceType: 'Observation',
  id: 'obs-hba1c',
  status: 'final',
  subject: { reference: 'Patient/p1' },
  code: { text: 'Hemoglobin A1c' },
  valueQuantity: { value: 9.1, unit: '%' },
  effectiveDateTime: '2026-08-14T09:00:00Z',
  interpretation: [{ text: 'High' }],
};

const chart = (overrides: Partial<PatientChart> = {}): PatientChart => ({
  patient: { resourceType: 'Patient', id: 'p1', birthDate: '1961-03-02', gender: 'female' },
  conditions: [DIABETES, CKD],
  medications: [METFORMIN],
  allergies: [PENICILLIN],
  labs: [HBA1C],
  vitals: [],
  encounters: [],
  appointments: [],
  documents: [],
  ...overrides,
});

const citationIndex = (): Map<string, CitationSource> => buildCitationIndex(chart());

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

describe('parseSummaryDraft', () => {
  const minimal = { narrative: 'Diabetes is poorly controlled.' };

  test('accepts the shape the system prompt asks for', () => {
    const draft = parseSummaryDraft(
      JSON.stringify({
        narrative: 'A1c is rising [L1] on metformin alone [M1].',
        alerts: [{ severity: 'critical', message: 'A1c 9.1%', action: 'Intensify therapy' }],
        risks: [{ factor: 'Diabetic nephropathy', level: 'high', basis: 'CKD 3 with uncontrolled diabetes' }],
        focusAreas: [{ topic: 'Add a second agent', reason: 'Monotherapy is not holding' }],
        careGaps: [{ gap: 'No retinal screening in 18 months', recommendation: 'Refer to ophthalmology' }],
      })
    );
    expect(draft.narrative).toBe('A1c is rising [L1] on metformin alone [M1].');
    expect(draft.alerts).toEqual([{ severity: 'critical', message: 'A1c 9.1%', action: 'Intensify therapy' }]);
    expect(draft.risks[0].level).toBe('high');
    expect(draft.focusAreas[0].topic).toBe('Add a second agent');
    expect(draft.careGaps[0].gap).toBe('No retinal screening in 18 months');
  });

  test('tolerates a code fence, which models add unasked', () => {
    expect(parseSummaryDraft('```json\n' + JSON.stringify(minimal) + '\n```').narrative).toBe(minimal.narrative);
  });

  test('refuses an answer with no narrative — the one field the card cannot do without', () => {
    expect(() => parseSummaryDraft(JSON.stringify({ alerts: [] }))).toThrow(/no narrative/);
    expect(() => parseSummaryDraft(JSON.stringify({ narrative: '   ' }))).toThrow(/no narrative/);
  });

  test('refuses output that is not JSON at all', () => {
    expect(() => parseSummaryDraft('I am sorry, I cannot help with that.')).toThrow(/did not return JSON/);
    expect(() => parseSummaryDraft(JSON.stringify(['a', 'b']))).toThrow(/not an object/);
  });

  test('drops a row with no headline rather than rendering a blank one', () => {
    const draft = parseSummaryDraft(
      JSON.stringify({
        ...minimal,
        alerts: [
          { severity: 'warning', message: '', action: 'Do something' },
          { message: 'Real alert', action: '' },
        ],
        risks: [{ level: 'high', basis: 'No factor name' }],
        careGaps: [{ recommendation: 'No gap named' }],
      })
    );
    expect(draft.alerts).toHaveLength(1);
    expect(draft.alerts[0].message).toBe('Real alert');
    expect(draft.risks).toEqual([]);
    expect(draft.careGaps).toEqual([]);
  });

  test('falls back on an unknown enum instead of discarding the row', () => {
    // The row's text is the clinical content; the severity is decoration. Losing
    // the row because the model wrote "urgent" would lose the finding.
    const draft = parseSummaryDraft(
      JSON.stringify({
        ...minimal,
        alerts: [{ severity: 'urgent', message: 'Potassium 6.1', action: 'Recheck today' }],
        risks: [{ factor: 'Hyperkalemia', level: 'severe', basis: 'K 6.1' }],
      })
    );
    expect(draft.alerts[0].severity).toBe('info');
    expect(draft.risks[0].level).toBe('low');
  });

  test('accepts an enum in the wrong case', () => {
    const draft = parseSummaryDraft(
      JSON.stringify({ ...minimal, alerts: [{ severity: 'CRITICAL', message: 'x', action: 'y' }] })
    );
    expect(draft.alerts[0].severity).toBe('critical');
  });

  test('enforces the caps the prompt only asks for', () => {
    const draft = parseSummaryDraft(
      JSON.stringify({
        ...minimal,
        alerts: Array.from({ length: 9 }, (_, i) => ({ severity: 'info', message: `Alert ${i}`, action: 'x' })),
      })
    );
    expect(draft.alerts).toHaveLength(MAX_ALERTS);
  });

  test('strips NUL, which extracted document text carries', () => {
    const draft = parseSummaryDraft(JSON.stringify({ narrative: 'Stable\u0000 on therapy' }));
    expect(draft.narrative).toBe('Stable on therapy');
  });
});

// ---------------------------------------------------------------------------
// The citation mapping
// ---------------------------------------------------------------------------

describe('buildCitationIndex', () => {
  test('tags each kind with its own letter and the real reference', () => {
    const index = citationIndex();
    expect(index.get('C1')?.reference).toEqual({ reference: 'Condition/cond-dm', display: 'Type 2 diabetes mellitus' });
    expect(index.get('C2')?.reference.reference).toBe('Condition/cond-ckd');
    expect(index.get('M1')?.reference).toEqual({
      reference: 'MedicationRequest/med-metformin',
      display: 'Metformin 1000 mg',
    });
    expect(index.get('A1')?.reference.reference).toBe('AllergyIntolerance/allergy-pcn');
    expect(index.get('L1')?.reference.display).toBe('Hemoglobin A1c: 9.1%');
  });

  test('numbers in the same order the prompt lists the records', () => {
    // The tags are positional and nothing else ties the two together, so a
    // reordering here would silently point every citation at the wrong record.
    const prompt = buildChartPrompt(chart(), new Date('2026-09-01T00:00:00Z'));
    expect(prompt).toContain('[C1] Type 2 diabetes mellitus');
    expect(prompt).toContain('[C2] Chronic kidney disease stage 3');
    expect(prompt).toContain('[M1] Metformin 1000 mg — Twice daily with food');
    expect(prompt).toContain('[L1] Hemoglobin A1c: 9.1% [High]');
  });

  test('kind is recorded per tag letter', () => {
    const index = citationIndex();
    expect(index.get('C1')?.kind).toBe('condition');
    expect(index.get('M1')?.kind).toBe('medication');
    expect(index.get('A1')?.kind).toBe('allergy');
    expect(index.get('L1')?.kind).toBe('lab');
  });
});

describe('rewriteCitations', () => {
  test('turns a tag into an index into the entries it returns', () => {
    const { texts, entries } = rewriteCitations(['A1c is rising [L1] on metformin [M1].'], citationIndex());
    expect(texts[0]).toBe('A1c is rising [1] on metformin [2].');
    expect(entries.map((e) => e.reference)).toEqual(['Observation/obs-hba1c', 'MedicationRequest/med-metformin']);
  });

  test('reuses one entry for a tag cited twice', () => {
    const { texts, entries } = rewriteCitations(['Diabetes [C1] is worsening; see [C1].'], citationIndex());
    expect(texts[0]).toBe('Diabetes [1] is worsening; see [1].');
    expect(entries).toHaveLength(1);
  });

  test('numbers across every string of the section, because they share one entry list', () => {
    const { texts, entries } = rewriteCitations(['Diabetes [C1]', 'on metformin [M1]'], citationIndex());
    expect(texts).toEqual(['Diabetes [1]', 'on metformin [2]']);
    expect(entries).toHaveLength(2);
  });

  test('deletes a tag that is not in the index, with the space before it', () => {
    // This is the bug the whole scheme exists to remove. lyfe-provider-ui filtered
    // an unresolvable tag out of its citation footer but left it in the prose, so
    // the provider read a literal "[C9]".
    const { texts, entries } = rewriteCitations(['Diabetes is stable [C9] overall.'], citationIndex());
    expect(texts[0]).toBe('Diabetes is stable overall.');
    expect(entries).toEqual([]);
  });

  test('does not leave a space before the punctuation a dropped tag preceded', () => {
    const { texts } = rewriteCitations(['Renal function is declining [L7].'], citationIndex());
    expect(texts[0]).toBe('Renal function is declining.');
  });

  test('leaves text with no tags untouched', () => {
    const { texts, entries } = rewriteCitations(['No follow-up scheduled.'], citationIndex());
    expect(texts[0]).toBe('No follow-up scheduled.');
    expect(entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Composition shape
// ---------------------------------------------------------------------------

const AUTHOR: Reference<never> = { reference: 'Device/dev-1', display: 'Lyfe Clinical AI' };

function composition(): ReturnType<typeof buildSummaryComposition> {
  return buildSummaryComposition({
    patient: { reference: 'Patient/p1' },
    author: AUTHOR,
    generatedAt: '2026-09-30T12:00:00.000Z',
    account: { reference: 'Organization/org-1' },
    citations: citationIndex(),
    draft: parseSummaryDraft(
      JSON.stringify({
        narrative: 'Diabetes [C1] is uncontrolled with CKD 3 [C2].',
        alerts: [{ severity: 'critical', message: 'A1c 9.1% [L1]', action: 'Intensify therapy' }],
        risks: [{ factor: 'Diabetic nephropathy [C2]', level: 'high', basis: 'eGFR falling' }],
        focusAreas: [{ topic: 'Second agent [M1]', reason: 'Monotherapy is not holding' }],
        careGaps: [{ gap: 'No retinal screening in 18 months', recommendation: 'Refer to ophthalmology' }],
      })
    ),
  });
}

describe('buildSummaryComposition', () => {
  test('is keyed on the patient id so a regeneration replaces rather than accumulates', () => {
    expect(composition().identifier).toEqual({ system: AI_SUMMARY_IDENTIFIER_SYSTEM, value: 'p1' });
    expect(summarySearchQuery('p1')).toBe(`identifier=${encodeURIComponent(`${AI_SUMMARY_IDENTIFIER_SYSTEM}|p1`)}`);
  });

  test('is a final patient-summary document about the patient, authored by the device', () => {
    const c = composition();
    expect(c.resourceType).toBe('Composition');
    // Staleness is this field and nothing else; the subscription path flips it to
    // `preliminary` and the card reads it back.
    expect(c.status).toBe('final');
    expect(c.type.coding?.[0]).toEqual({
      system: 'http://loinc.org',
      code: PATIENT_SUMMARY_LOINC,
      display: 'Patient summary Document',
    });
    expect(c.subject?.reference).toBe('Patient/p1');
    expect(c.author).toEqual([AUTHOR]);
    expect(c.date).toBe('2026-09-30T12:00:00.000Z');
  });

  test('carries the clinic compartment, without which clinic users cannot see it', () => {
    expect(composition().meta).toEqual({
      account: { reference: 'Organization/org-1' },
      accounts: [{ reference: 'Organization/org-1' }],
    });
  });

  test('has one section per block, narrative first', () => {
    const codes = composition().section?.map((s) => s.code?.coding?.[0].code);
    expect(codes).toEqual(['narrative', 'alerts', 'risks', 'focus-areas', 'care-gaps']);
  });

  test('omits a block the model left empty rather than writing an invalid empty section', () => {
    const c = buildSummaryComposition({
      patient: { reference: 'Patient/p1' },
      author: AUTHOR,
      generatedAt: '2026-09-30T12:00:00.000Z',
      citations: citationIndex(),
      draft: parseSummaryDraft(JSON.stringify({ narrative: 'Nothing of note.' })),
    });
    expect(c.section?.map((s) => s.code?.coding?.[0].code)).toEqual(['narrative']);
  });

  test('puts the narrative in XHTML with its citations as real references', () => {
    const narrative = composition().section?.[0];
    expect(narrative?.text?.status).toBe('generated');
    expect(narrative?.text?.div).toBe(
      '<div xmlns="http://www.w3.org/1999/xhtml"><p>Diabetes [1] is uncontrolled with CKD 3 [2].</p></div>'
    );
    expect(narrative?.entry).toEqual([
      { reference: 'Condition/cond-dm', display: 'Type 2 diabetes mellitus' },
      { reference: 'Condition/cond-ckd', display: 'Chronic kidney disease stage 3' },
    ]);
  });

  test('also carries the real LOINC for the HPI section', () => {
    expect(composition().section?.[0].code?.coding).toEqual([
      { system: 'https://lyfe.com/CodeSystem/ai-summary-section', code: 'narrative' },
      { system: 'http://loinc.org', code: '10164-2' },
    ]);
  });

  test('makes each alert a sub-section: message as title, severity as code, action as text', () => {
    const alert = composition().section?.[1].section?.[0];
    expect(alert?.title).toBe('A1c 9.1% [1]');
    expect(alert?.code?.coding?.[0]).toEqual({
      system: 'https://lyfe.com/CodeSystem/ai-summary-severity',
      code: 'critical',
    });
    expect(alert?.text?.div).toContain('Intensify therapy');
    // The citation in the message resolves against this sub-section's own entries,
    // not the parent's — markers are always local to the section that holds them.
    expect(alert?.entry).toEqual([{ reference: 'Observation/obs-hba1c', display: 'Hemoglobin A1c: 9.1%' }]);
  });

  test('restarts marker numbering per section, since each has its own entry list', () => {
    const c = composition();
    // `[C2]` is the second condition and therefore `[2]` in the narrative, but it
    // is the only citation in the risk row, so there it is `[1]`.
    expect(c.section?.[0].text?.div).toContain('CKD 3 [2]');
    expect(c.section?.[2].section?.[0].title).toBe('Diabetic nephropathy [1]');
    expect(c.section?.[2].section?.[0].entry).toEqual([
      { reference: 'Condition/cond-ckd', display: 'Chronic kidney disease stage 3' },
    ]);
  });

  test('gives a row with no detail its headline as narrative, to stay valid FHIR', () => {
    // `cmp-1`: a section needs text, entries or sub-sections. `title` is none of
    // those, so a row with neither detail nor citation would otherwise be invalid.
    const c = buildSummaryComposition({
      patient: { reference: 'Patient/p1' },
      author: AUTHOR,
      generatedAt: '2026-09-30T12:00:00.000Z',
      citations: citationIndex(),
      draft: parseSummaryDraft(
        JSON.stringify({ narrative: 'x', careGaps: [{ gap: 'No HbA1c in 12 months', recommendation: '' }] })
      ),
    });
    const gap = c.section?.[1].section?.[0];
    expect(gap?.title).toBe('No HbA1c in 12 months');
    expect(gap?.text?.div).toContain('No HbA1c in 12 months');
  });
});

describe('escapeXhtml', () => {
  test('escapes what would make the narrative invalid XML', () => {
    // A drug name with an ampersand is the realistic case, and an unescaped one
    // invalidates the whole resource rather than just looking wrong.
    expect(escapeXhtml('Tylenol #3 & <b>codeine</b> "500mg"')).toBe(
      'Tylenol #3 &amp; &lt;b&gt;codeine&lt;/b&gt; &quot;500mg&quot;'
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('resolvePatientId', () => {
  test('reads the explicit call', () => {
    expect(resolvePatientId({ patientId: 'p1' })).toBe('p1');
  });

  test('reads a subscription-delivered Patient as its own subject', () => {
    expect(resolvePatientId({ resourceType: 'Patient', id: 'p1' })).toBe('p1');
  });

  test('reads `subject` and `patient` off a delivered clinical resource', () => {
    expect(resolvePatientId(DIABETES)).toBe('p1');
    expect(resolvePatientId(PENICILLIN)).toBe('p1');
  });

  test('declines a resource whose subject is not a patient', () => {
    expect(resolvePatientId({ resourceType: 'Condition', subject: { reference: 'Group/g1' } })).toBeUndefined();
    expect(resolvePatientId(undefined)).toBeUndefined();
  });
});

describe('isInvalidation', () => {
  test('a subscription delivery marks stale rather than regenerating', () => {
    // Regenerating per delivery would mean one model call per imported Condition.
    expect(isInvalidation(DIABETES)).toBe(true);
    expect(isInvalidation({ resourceType: 'Patient', id: 'p1' })).toBe(true);
  });

  test('an explicit call generates unless it asks otherwise', () => {
    expect(isInvalidation({ patientId: 'p1' })).toBe(false);
    expect(isInvalidation({ patientId: 'p1', mode: 'generate' })).toBe(false);
    expect(isInvalidation({ patientId: 'p1', mode: 'invalidate' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The document seam
// ---------------------------------------------------------------------------

describe('document context seam', () => {
  test('reports no documents when none are supplied, which is every call today', () => {
    expect(buildChartPrompt(chart(), new Date('2026-09-01T00:00:00Z'))).toContain(
      'RECENT DOCUMENTS (0):\nNone extracted yet'
    );
  });

  test('is ready for excerpts the moment extraction exists', () => {
    const withDocs = chart({
      documents: [
        {
          reference: { reference: 'DocumentReference/doc-1' },
          title: 'Nephrology consult',
          date: '2026-07-02',
          excerpt: 'Impression:   eGFR   38, progressive.',
        },
      ],
    });
    const prompt = buildChartPrompt(withDocs, new Date('2026-09-01T00:00:00Z'));
    expect(prompt).toContain('[D1] 2026-07-02 | Nephrology consult');
    expect(prompt).toContain('Impression: eGFR 38, progressive.');
    expect(buildCitationIndex(withDocs).get('D1')?.reference).toEqual({
      reference: 'DocumentReference/doc-1',
      display: 'Nephrology consult',
    });
  });
});

describe('buildChartPrompt', () => {
  test('states age and gender but never the name, which the narrative must not echo', () => {
    const prompt = buildChartPrompt(
      chart({
        patient: {
          resourceType: 'Patient',
          id: 'p1',
          birthDate: '1961-03-02',
          gender: 'female',
          name: [{ family: 'Nowak', given: ['Ewa'] }],
        },
      }),
      new Date('2026-09-01T00:00:00Z')
    );
    expect(prompt).toContain('AGE: 65 | GENDER: female');
    expect(prompt).not.toContain('Nowak');
  });

  test('reports the visit gap, which drives the care-gap findings', () => {
    const prompt = buildChartPrompt(
      chart({
        encounters: [
          {
            resourceType: 'Encounter',
            id: 'enc-1',
            status: 'finished',
            class: { display: 'ambulatory' },
            period: { start: '2026-06-02' },
          },
        ],
      }),
      new Date('2026-09-01T00:00:00Z')
    );
    expect(prompt).toContain('DAYS SINCE LAST VISIT: 91');
    expect(prompt).toContain('[E1] 2026-06-02 ambulatory');
  });

  test('says so plainly when a section is empty, rather than leaving a blank the model fills in', () => {
    const prompt = buildChartPrompt(
      chart({ conditions: [], medications: [], allergies: [], labs: [] }),
      new Date('2026-09-01T00:00:00Z')
    );
    expect(prompt).toContain('ACTIVE CONDITIONS (0):\nNone documented');
    expect(prompt).toContain('LATEST VITALS:\nNo vitals recorded');
    expect(prompt).toContain('UPCOMING APPOINTMENTS: None scheduled');
    expect(prompt).toContain('DAYS SINCE LAST VISIT: Unknown');
  });
});
