// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * What these cover, and why those things and not others.
 *
 * Four decisions in this feature can be silently wrong in a way that reaches
 * either a provider or a real EHR, so they are the ones pinned down here:
 *
 *  1. **The schema.** `$ai` has no structured-output parameter, so the prompt is
 *     the only contract and `parseSoapDraft` is the only enforcement. A malformed
 *     row must be dropped, and a note with no chief complaint or no HPI must fail
 *     loudly rather than reach DrChrono half-built.
 *  2. **The DrChrono format mapping.** This is the text that enters a patient's
 *     chart in another system. The expected strings below are written out in full
 *     rather than snapshotted, because the port's whole claim is that the output
 *     is lyfe-provider-ui's byte for byte.
 *  3. **The Composition shape, and that it is a lossless home for (2).** The
 *     round-trip test is the load-bearing one: generation stores narratives and
 *     the push reads them back, so if the Composition lost a blank line the EHR
 *     would get reformatted text and nothing would fail.
 *  4. **The write decision.** The one place in this feature that can destroy a
 *     clinician's own work. Every branch has a case.
 */
import type { Composition, Condition, Encounter, Provenance } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { SoapDraft } from './shared/soap-note.ts';
import {
  buildPushProvenance,
  buildSoapComposition,
  CHIEF_COMPLAINT_LOINC,
  compositionToDrChronoFields,
  compositionToSoapNarratives,
  decideClinicalNoteWrite,
  DRCHRONO_CLINICAL_NOTE_SYSTEM,
  drChronoAppointmentId,
  drChronoNoteIdsFrom,
  HPI_NARRATIVE_LOINC,
  mapSoapToDrChronoFormat,
  matchAssessmentConditions,
  parseSoapDraft,
  renderSoapNarratives,
  SOAP_NOTE_IDENTIFIER_SYSTEM,
  SOAP_NOTE_LOINC,
  SOAP_SECTION_LOINC,
  soapNoteSearchQuery,
  textFromNarrative,
  toNarrative,
} from './shared/soap-note.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DRAFT: SoapDraft = {
  subjective: {
    chiefComplaint: 'Cough for 3 days',
    hpiNarrative: 'Dry cough since Monday, no dyspnoea.',
    reviewOfSystems: 'Denies fever or chills.',
    socialHistory: 'Non-smoker.',
  },
  objective: {
    vitals: 'BP 128/82, HR 78, T 37.0',
    physicalExam: 'Lungs clear to auscultation bilaterally.',
    labResults: null,
  },
  assessment: [
    { diagnosis: 'Acute bronchitis', icdCode: 'J20.9', status: 'new', reasoning: 'Cough with a clear chest.' },
    {
      diagnosis: 'Essential hypertension',
      icdCode: 'I10',
      status: 'ongoing',
      reasoning: 'At goal on lisinopril.',
    },
  ],
  plan: [
    { action: 'Start benzonatate 100 mg TID', category: 'medication', details: 'PRN cough' },
    { action: 'Continue lisinopril 10 mg daily', category: 'medication', details: null },
    { action: 'Follow up in 2 weeks', category: 'follow-up', details: null },
  ],
};

const EXPECTED_SUBJECTIVE = `HPI:
Dry cough since Monday, no dyspnoea.

Review of Systems:
Denies fever or chills.

Social History:
Non-smoker.`;

const EXPECTED_OBJECTIVE = `Vitals:
BP 128/82, HR 78, T 37.0

Physical Exam:
Lungs clear to auscultation bilaterally.`;

const EXPECTED_ASSESSMENT = `Assessment:
1. Acute bronchitis (J20.9)
   Cough with a clear chest.

2. Essential hypertension (I10) [ongoing]
   At goal on lisinopril.`;

const EXPECTED_PLAN = `Plan:
Medications:
  - Start benzonatate 100 mg TID — PRN cough
  - Continue lisinopril 10 mg daily

Follow-up:
  - Follow up in 2 weeks`;

function composition(draft: SoapDraft = DRAFT): Composition {
  return buildSoapComposition({
    encounter: { reference: 'Encounter/enc-1' },
    patient: { reference: 'Patient/pat-1' },
    author: { reference: 'Device/dev-1', display: 'Lyfe Clinical AI' },
    narratives: renderSoapNarratives(draft),
    assessmentEntries: [{ reference: 'Condition/cond-htn', display: 'Essential hypertension' }],
    generatedAt: '2026-10-01T12:00:00.000Z',
    account: { reference: 'Organization/org-1' },
  });
}

// ---------------------------------------------------------------------------
// 1. The schema
// ---------------------------------------------------------------------------

describe('parseSoapDraft', () => {
  const minimal = JSON.stringify({
    subjective: { chiefComplaint: 'Cough', hpiNarrative: 'Three days.' },
    objective: {},
    assessment: [],
    plan: [],
  });

  test('accepts the minimum a note needs', () => {
    const draft = parseSoapDraft(minimal);
    expect(draft.subjective.chiefComplaint).toBe('Cough');
    expect(draft.subjective.reviewOfSystems).toBeNull();
    expect(draft.objective.vitals).toBeNull();
    expect(draft.assessment).toEqual([]);
  });

  test('unwraps a fenced code block', () => {
    expect(parseSoapDraft('```json\n' + minimal + '\n```').subjective.chiefComplaint).toBe('Cough');
  });

  test('rejects a missing chief complaint', () => {
    const body = JSON.stringify({ subjective: { hpiNarrative: 'Three days.' } });
    expect(() => parseSoapDraft(body)).toThrow(/chief complaint/i);
  });

  test('rejects a missing HPI', () => {
    const body = JSON.stringify({ subjective: { chiefComplaint: 'Cough' } });
    expect(() => parseSoapDraft(body)).toThrow(/history of present illness/i);
  });

  test('rejects output that is not JSON, and JSON that is not an object', () => {
    expect(() => parseSoapDraft('Here is the note you asked for:')).toThrow(/did not return JSON/);
    expect(() => parseSoapDraft('[1, 2]')).toThrow(/not an object/);
  });

  test('drops rows with nothing to say, and defaults an unknown enum', () => {
    const body = JSON.stringify({
      subjective: { chiefComplaint: 'Cough', hpiNarrative: 'Three days.' },
      assessment: [
        { diagnosis: '', icdCode: 'J20.9', status: 'new', reasoning: 'dropped' },
        { diagnosis: 'Acute bronchitis', icdCode: '  ', status: 'CHRONIC', reasoning: '' },
      ],
      plan: [
        { action: '', category: 'medication' },
        { action: 'Rest', category: 'incantation' },
      ],
    });
    const draft = parseSoapDraft(body);
    expect(draft.assessment).toEqual([{ diagnosis: 'Acute bronchitis', icdCode: null, status: 'new', reasoning: '' }]);
    expect(draft.plan).toEqual([{ action: 'Rest', category: 'other', details: null }]);
  });

  test('accepts an enum the model shouted, and strips NUL from text', () => {
    const body = JSON.stringify({
      subjective: { chiefComplaint: 'Cough\u0000', hpiNarrative: 'Three days.' },
      assessment: [{ diagnosis: 'Hypertension', status: 'Ongoing', reasoning: 'x' }],
      plan: [{ action: 'Recheck', category: 'FOLLOW-UP' }],
    });
    const draft = parseSoapDraft(body);
    expect(draft.subjective.chiefComplaint).toBe('Cough');
    expect(draft.assessment[0].status).toBe('ongoing');
    expect(draft.plan[0].category).toBe('follow-up');
  });

  test('does not cap the assessment list', () => {
    const assessment = Array.from({ length: 12 }, (_, i) => ({
      diagnosis: `Problem ${i}`,
      status: 'new',
      reasoning: '',
    }));
    const body = JSON.stringify({
      subjective: { chiefComplaint: 'Cough', hpiNarrative: 'Three days.' },
      assessment,
    });
    // Deliberate: silently dropping a diagnosis on its way into a legal record is
    // worse than a long note. The AI summary caps its rows; this must not.
    expect(parseSoapDraft(body).assessment).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// 2. The DrChrono format mapping
// ---------------------------------------------------------------------------

describe('renderSoapNarratives / mapSoapToDrChronoFormat', () => {
  test('reproduces lyfe-provider-ui’s three fields exactly', () => {
    expect(mapSoapToDrChronoFormat(DRAFT)).toEqual({
      chief_complaint: 'Cough for 3 days',
      history_of_present_illness: `${EXPECTED_SUBJECTIVE}\n\n${EXPECTED_OBJECTIVE}`,
      assessment_and_plan: `${EXPECTED_ASSESSMENT}\n\n${EXPECTED_PLAN}`,
    });
  });

  test('splits the five blocks on the section boundaries', () => {
    expect(renderSoapNarratives(DRAFT)).toEqual({
      chiefComplaint: 'Cough for 3 days',
      subjective: EXPECTED_SUBJECTIVE,
      objective: EXPECTED_OBJECTIVE,
      assessment: EXPECTED_ASSESSMENT,
      plan: EXPECTED_PLAN,
    });
  });

  test('omits an ICD code it was not given, and the default "new" status', () => {
    const draft: SoapDraft = {
      ...DRAFT,
      assessment: [{ diagnosis: 'Viral URI', icdCode: null, status: 'new', reasoning: 'Self-limiting.' }],
      plan: [],
    };
    expect(renderSoapNarratives(draft).assessment).toBe('Assessment:\n1. Viral URI\n   Self-limiting.');
  });

  test('leaves blocks empty rather than writing a bare heading', () => {
    const draft: SoapDraft = {
      subjective: { chiefComplaint: 'Cough', hpiNarrative: 'Three days.', reviewOfSystems: null, socialHistory: null },
      objective: { vitals: null, physicalExam: null, labResults: null },
      assessment: [],
      plan: [],
    };
    const narratives = renderSoapNarratives(draft);
    expect(narratives.objective).toBe('');
    expect(narratives.assessment).toBe('');
    expect(narratives.plan).toBe('');
    // The join drops the empty blocks instead of leaving stray blank lines.
    expect(mapSoapToDrChronoFormat(draft)).toEqual({
      chief_complaint: 'Cough',
      history_of_present_illness: 'HPI:\nThree days.',
      assessment_and_plan: '',
    });
  });

  test('groups plan items by category in first-appearance order', () => {
    const draft: SoapDraft = {
      ...DRAFT,
      assessment: [],
      plan: [
        { action: 'Refer to cardiology', category: 'referral', details: null },
        { action: 'CBC', category: 'order', details: 'fasting' },
        { action: 'Echo', category: 'order', details: null },
      ],
    };
    expect(renderSoapNarratives(draft).plan).toBe(
      'Plan:\nReferrals:\n  - Refer to cardiology\n\nOrders:\n  - CBC — fasting\n  - Echo'
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The Composition shape
// ---------------------------------------------------------------------------

describe('buildSoapComposition', () => {
  test('keys the note on the encounter, so regeneration replaces it', () => {
    const note = composition();
    expect(note.identifier).toEqual({ system: SOAP_NOTE_IDENTIFIER_SYSTEM, value: 'enc-1' });
    expect(soapNoteSearchQuery('enc-1')).toBe(
      `identifier=${encodeURIComponent(`${SOAP_NOTE_IDENTIFIER_SYSTEM}|enc-1`)}`
    );
  });

  test('starts as a draft, which is what Composition.status now carries', () => {
    expect(composition().status).toBe('preliminary');
  });

  test('is a LOINC consult note with the four standard SOAP section codes', () => {
    const note = composition();
    expect(note.type?.coding?.[0]).toMatchObject({ system: 'http://loinc.org', code: SOAP_NOTE_LOINC });
    expect(note.section?.map((section) => section.code?.coding?.[0]?.code)).toEqual([
      SOAP_SECTION_LOINC.subjective,
      SOAP_SECTION_LOINC.objective,
      SOAP_SECTION_LOINC.assessment,
      SOAP_SECTION_LOINC.plan,
    ]);
  });

  test('keeps the chief complaint separable from the HPI, because DrChrono does', () => {
    const subjective = composition().section?.[0];
    expect(subjective?.section?.map((child) => child.code?.coding?.[0]?.code)).toEqual([
      CHIEF_COMPLAINT_LOINC,
      HPI_NARRATIVE_LOINC,
    ]);
  });

  test('carries the matched Conditions in the assessment section’s entry[]', () => {
    const assessment = composition().section?.find(
      (section) => section.code?.coding?.[0]?.code === SOAP_SECTION_LOINC.assessment
    );
    expect(assessment?.entry).toEqual([{ reference: 'Condition/cond-htn', display: 'Essential hypertension' }]);
  });

  test('sets both compartment keys, or clinic users cannot see it', () => {
    expect(composition().meta).toEqual({
      account: { reference: 'Organization/org-1' },
      accounts: [{ reference: 'Organization/org-1' }],
    });
  });

  test('omits a section with nothing in it rather than writing an invalid empty one', () => {
    const draft: SoapDraft = {
      subjective: { chiefComplaint: 'Cough', hpiNarrative: 'Three days.', reviewOfSystems: null, socialHistory: null },
      objective: { vitals: null, physicalExam: null, labResults: null },
      assessment: [],
      plan: [],
    };
    const note = buildSoapComposition({
      encounter: { reference: 'Encounter/enc-2' },
      patient: { reference: 'Patient/pat-1' },
      author: { reference: 'Device/dev-1' },
      narratives: renderSoapNarratives(draft),
      generatedAt: '2026-10-01T12:00:00.000Z',
    });
    expect(note.section).toHaveLength(1);
    expect(note.section?.[0].code?.coding?.[0]?.code).toBe(SOAP_SECTION_LOINC.subjective);
  });
});

describe('the Composition is a lossless home for the DrChrono payload', () => {
  test('a stored note renders the same three fields the draft did', () => {
    // The load-bearing test. Generation stores narratives; the push reads them
    // back. If the Composition lost a blank line, DrChrono would get reformatted
    // text and nothing would fail.
    expect(compositionToDrChronoFields(composition())).toEqual(mapSoapToDrChronoFormat(DRAFT));
  });

  test('and the five blocks come back unchanged', () => {
    expect(compositionToSoapNarratives(composition())).toEqual(renderSoapNarratives(DRAFT));
  });

  test('including a note whose objective, assessment and plan sections are absent', () => {
    const draft: SoapDraft = {
      subjective: { chiefComplaint: 'Cough', hpiNarrative: 'Three days.', reviewOfSystems: null, socialHistory: null },
      objective: { vitals: null, physicalExam: null, labResults: null },
      assessment: [],
      plan: [],
    };
    expect(compositionToDrChronoFields(composition(draft))).toEqual(mapSoapToDrChronoFormat(draft));
  });
});

describe('narrative round trip', () => {
  test('survives XML-significant characters and blank lines', () => {
    const text = 'Assessment:\n1. "GERD" & reflux <worsening>\n\n2. Plan:\n  - Omeprazole';
    expect(textFromNarrative(toNarrative(text).div)).toBe(text);
  });

  test('escapes rather than embeds markup', () => {
    expect(toNarrative('<script>alert(1)</script>').div).not.toContain('<script>');
  });

  test('reads an absent narrative as empty', () => {
    expect(textFromNarrative(undefined)).toBe('');
  });
});

describe('matchAssessmentConditions', () => {
  const htn: Condition = {
    resourceType: 'Condition',
    id: 'cond-htn',
    subject: { reference: 'Patient/pat-1' },
    code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'I10' }], text: 'Essential hypertension' },
  };

  test('matches on the code, punctuation and case ignored', () => {
    const draft: SoapDraft = {
      ...DRAFT,
      assessment: [{ diagnosis: 'HTN', icdCode: 'i10.', status: 'ongoing', reasoning: '' }],
    };
    expect(matchAssessmentConditions(draft, [htn])).toEqual([
      { reference: 'Condition/cond-htn', display: 'Essential hypertension' },
    ]);
  });

  test('never matches on the diagnosis name', () => {
    const draft: SoapDraft = {
      ...DRAFT,
      assessment: [{ diagnosis: 'Essential hypertension', icdCode: null, status: 'ongoing', reasoning: '' }],
    };
    // A name match would point an assessment at a plausible but unrelated
    // problem, which is worse than citing nothing.
    expect(matchAssessmentConditions(draft, [htn])).toEqual([]);
  });

  test('ignores a code too short to be ICD-10, and dedupes', () => {
    const draft: SoapDraft = {
      ...DRAFT,
      assessment: [
        { diagnosis: 'Something', icdCode: 'I', status: 'new', reasoning: '' },
        { diagnosis: 'HTN', icdCode: 'I10', status: 'ongoing', reasoning: '' },
        { diagnosis: 'HTN again', icdCode: 'I10', status: 'ongoing', reasoning: '' },
      ],
    };
    expect(matchAssessmentConditions(draft, [htn])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The write decision
// ---------------------------------------------------------------------------

describe('decideClinicalNoteWrite', () => {
  const ours = { id: 55, chief_complaint: 'Cough' };

  test('creates when DrChrono has no note for the appointment', () => {
    expect(decideClinicalNoteWrite({ existing: [], recordedNoteIds: [] })).toEqual({ kind: 'create' });
  });

  test('updates a note Lyfe recorded pushing to, which is what makes a second push idempotent', () => {
    expect(decideClinicalNoteWrite({ existing: [ours], recordedNoteIds: ['55'] })).toEqual({
      kind: 'update',
      noteId: 55,
    });
  });

  test('updates an empty note, because there is nothing to lose', () => {
    const empty = { id: 56, chief_complaint: '   ', history_of_present_illness: '', assessment_and_plan: null };
    expect(decideClinicalNoteWrite({ existing: [empty], recordedNoteIds: [] })).toEqual({
      kind: 'update',
      noteId: 56,
    });
  });

  test('refuses to overwrite a note with content that Lyfe did not write', () => {
    const decision = decideClinicalNoteWrite({ existing: [ours], recordedNoteIds: [] });
    expect(decision.kind).toBe('refuse');
    // The id is in the message on purpose: a human has to be able to go and look.
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/55/);
  });

  test('refuses a signed or locked note even when Lyfe wrote it', () => {
    expect(decideClinicalNoteWrite({ existing: [{ ...ours, locked: true }], recordedNoteIds: ['55'] }).kind).toBe(
      'refuse'
    );
    expect(decideClinicalNoteWrite({ existing: [{ ...ours, signed_by: 7 }], recordedNoteIds: ['55'] }).kind).toBe(
      'refuse'
    );
  });

  test('refuses rather than guessing when DrChrono returns more than one note', () => {
    const decision = decideClinicalNoteWrite({ existing: [ours, { id: 56 }], recordedNoteIds: ['55'] });
    expect(decision.kind).toBe('refuse');
  });
});

describe('the record of a push', () => {
  test('targets both the Composition and the DrChrono row', () => {
    const provenance = buildPushProvenance({
      composition: { reference: 'Composition/comp-1' },
      clinicalNoteId: '55',
      agent: { reference: 'Practitioner/prac-1' },
      recorded: '2026-10-01T12:05:00.000Z',
      account: { reference: 'Organization/org-1' },
    });
    expect(provenance.activity?.coding?.[0].code).toBe('TRANSMIT');
    expect(provenance.target?.[0]).toEqual({ reference: 'Composition/comp-1' });
    expect(provenance.target?.[1].identifier).toEqual({ system: DRCHRONO_CLINICAL_NOTE_SYSTEM, value: '55' });
  });

  test('reads back as the note ids the write decision trusts', () => {
    const provenances: Provenance[] = [
      buildPushProvenance({
        composition: { reference: 'Composition/comp-1' },
        clinicalNoteId: '55',
        agent: { reference: 'Practitioner/prac-1' },
        recorded: '2026-10-01T12:05:00.000Z',
      }),
      // An unrelated Provenance on the same Composition — a signature, say — must
      // not be read as a push.
      { resourceType: 'Provenance', target: [{ reference: 'Composition/comp-1' }], recorded: 'x', agent: [] },
    ];
    expect(drChronoNoteIdsFrom(provenances)).toEqual(['55']);
  });
});

describe('drChronoAppointmentId', () => {
  test('reads the identifier the importer wrote', () => {
    const encounter: Encounter = {
      resourceType: 'Encounter',
      status: 'finished',
      class: { code: 'AMB' },
      identifier: [{ system: 'https://drchrono.com/appointments', value: '412' }],
    };
    expect(drChronoAppointmentId(encounter)).toBe('412');
  });

  test('is undefined for an encounter created in Medplum, which is why the push can be unavailable', () => {
    expect(
      drChronoAppointmentId({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' } })
    ).toBeUndefined();
  });
});
