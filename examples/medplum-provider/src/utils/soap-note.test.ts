// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The app half of the SOAP note wire, and the drift guard.
 *
 * `src/utils/soap-note.ts` and `bots/shared/soap-note.ts` define the same codes
 * and the same section builder, deliberately, so that app code does not import
 * bot code. That duplication is only safe if something fails when the two
 * diverge, and the divergence that matters is not cosmetic: the DrChrono payload
 * is derived from these sections, so a difference in either side would quietly
 * change what enters a patient's chart in another system.
 */
import type { Composition } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import * as bot from '../../bots/shared/soap-note.ts';
import type { SoapNarratives } from './soap-note';
import * as app from './soap-note';
import { applySoapEdits, parseSoapComposition, toDrChronoFields } from './soap-note';

const NARRATIVES: SoapNarratives = {
  chiefComplaint: 'Cough for 3 days',
  subjective: 'HPI:\nDry cough since Monday.\n\nReview of Systems:\nDenies fever.',
  objective: 'Vitals:\nBP 128/82\n\nPhysical Exam:\nLungs clear.',
  assessment: 'Assessment:\n1. Acute bronchitis (J20.9)\n   Clear chest.',
  plan: 'Plan:\nMedications:\n  - Benzonatate 100 mg TID — PRN cough',
};

const ENTRIES = [{ reference: 'Condition/cond-htn', display: 'Essential hypertension' }];

function stored(narratives: SoapNarratives = NARRATIVES): Composition {
  return bot.buildSoapComposition({
    encounter: { reference: 'Encounter/enc-1' },
    patient: { reference: 'Patient/pat-1' },
    author: { reference: 'Device/dev-1' },
    narratives,
    assessmentEntries: ENTRIES,
    generatedAt: '2026-10-01T12:00:00.000Z',
  });
}

describe('the two sides of the wire agree', () => {
  test('on every code', () => {
    expect(app.SOAP_NOTE_IDENTIFIER_SYSTEM).toBe(bot.SOAP_NOTE_IDENTIFIER_SYSTEM);
    expect(app.LOINC_SYSTEM).toBe(bot.LOINC_SYSTEM);
    expect(app.SOAP_SECTION_LOINC).toEqual(bot.SOAP_SECTION_LOINC);
    expect(app.CHIEF_COMPLAINT_LOINC).toBe(bot.CHIEF_COMPLAINT_LOINC);
    expect(app.HPI_NARRATIVE_LOINC).toBe(bot.HPI_NARRATIVE_LOINC);
    expect(app.DRCHRONO_CLINICAL_NOTE_SYSTEM).toBe(bot.DRCHRONO_CLINICAL_NOTE_SYSTEM);
  });

  test('on the search that finds a note', () => {
    expect(app.soapNoteSearchQuery('enc-1')).toBe(bot.soapNoteSearchQuery('enc-1'));
  });

  test('on the XHTML narrative, in both directions', () => {
    const text = 'A & B <c>\n\n  - indented';
    expect(app.toNarrative(text)).toEqual(bot.toNarrative(text));
    expect(app.textFromNarrative(bot.toNarrative(text).div)).toBe(text);
    expect(bot.textFromNarrative(app.toNarrative(text).div)).toBe(text);
  });

  test('on the sections — the one that decides what DrChrono receives', () => {
    expect(app.buildSoapSections(NARRATIVES, ENTRIES)).toEqual(bot.buildSoapSections(NARRATIVES, ENTRIES));
    const sparse: SoapNarratives = { ...NARRATIVES, objective: '', assessment: '', plan: '' };
    expect(app.buildSoapSections(sparse, [])).toEqual(bot.buildSoapSections(sparse, []));
  });

  test('on the DrChrono fields, so the submit preview is what is transmitted', () => {
    expect(toDrChronoFields(NARRATIVES)).toEqual(bot.toDrChronoFields(NARRATIVES));
    expect(toDrChronoFields(parseSoapComposition(stored()).narratives)).toEqual(
      bot.compositionToDrChronoFields(stored())
    );
  });
});

describe('parseSoapComposition', () => {
  test('reads the five blocks back with their line structure intact', () => {
    expect(parseSoapComposition(stored()).narratives).toEqual(NARRATIVES);
  });

  test('reports draft and approved off Composition.status', () => {
    expect(parseSoapComposition(stored()).approved).toBe(false);
    expect(parseSoapComposition({ ...stored(), status: 'final' }).approved).toBe(true);
  });

  test('surfaces the assessment’s Condition references as sources', () => {
    expect(parseSoapComposition(stored()).sources).toEqual([
      { reference: 'Condition/cond-htn', label: 'Essential hypertension' },
    ]);
  });

  test('tolerates a note with no sections at all rather than throwing', () => {
    const empty: Composition = {
      resourceType: 'Composition',
      status: 'final',
      date: '2026-10-01',
      title: 'x',
      type: { text: 'SOAP note' },
      author: [{ reference: 'Device/dev-1' }],
    };
    const note = parseSoapComposition(empty);
    expect(note.narratives.plan).toBe('');
    expect(note.sources).toEqual([]);
  });
});

describe('applySoapEdits', () => {
  test('drops an approved note back to draft, so the push gate re-closes', () => {
    const approved: Composition = { ...stored(), status: 'final' };
    expect(applySoapEdits(approved, NARRATIVES).status).toBe('preliminary');
  });

  test('keeps the Conditions the bot matched', () => {
    const edited = applySoapEdits(stored(), { ...NARRATIVES, plan: 'Plan:\nOrders:\n  - CBC' });
    expect(parseSoapComposition(edited).sources).toEqual([
      { reference: 'Condition/cond-htn', label: 'Essential hypertension' },
    ]);
  });

  test('round-trips an edit into the DrChrono payload', () => {
    const edits: SoapNarratives = { ...NARRATIVES, chiefComplaint: 'Productive cough, 5 days' };
    const edited = applySoapEdits(stored(), edits);
    expect(bot.compositionToDrChronoFields(edited).chief_complaint).toBe('Productive cough, 5 days');
  });
});
