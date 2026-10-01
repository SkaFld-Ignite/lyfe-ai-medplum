// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Read an encounter's SOAP note `Composition` back into something the drawer can
 * render, and turn a provider's edits back into sections.
 *
 * The bot writes the note (`bots/soap-note.ts`); this is the other side of that
 * wire. Pure, so the whole parse is testable without a server.
 *
 * The codes and the section builder below are **duplicated on purpose**,
 * following the same rule as `AI_SUMMARY_IDENTIFIER_SYSTEM` in
 * `patient-ai-summary.ts` and `LYFE_SOURCE_TAG_SYSTEM` in `data-source.ts`:
 * exactly one definition per side of the wire, bots in `bots/shared/soap-note.ts`
 * and the app here, behaviour kept identical. `soap-note.test.ts` imports both
 * and fails if they drift — including a case that asserts the two section
 * builders produce byte-identical output, because the DrChrono payload is derived
 * from those sections and a difference would quietly change what enters the EHR.
 */
import type { Composition, CompositionSection, Narrative, Reference } from '@medplum/fhirtypes';

/** Must equal `SOAP_NOTE_IDENTIFIER_SYSTEM` in `bots/shared/soap-note.ts`. */
export const SOAP_NOTE_IDENTIFIER_SYSTEM = 'https://lyfe.com/soap-note';

/** Must equal `LOINC_SYSTEM` in `bots/shared/soap-note.ts`. */
export const LOINC_SYSTEM = 'http://loinc.org';

/** Must equal `SOAP_SECTION_LOINC` in `bots/shared/soap-note.ts`. */
export const SOAP_SECTION_LOINC = {
  subjective: '61150-9',
  objective: '61149-1',
  assessment: '51848-0',
  plan: '18776-5',
} as const;

/** Must equal `CHIEF_COMPLAINT_LOINC` in `bots/shared/soap-note.ts`. */
export const CHIEF_COMPLAINT_LOINC = '10154-3';

/** Must equal `HPI_NARRATIVE_LOINC` in `bots/shared/soap-note.ts`. */
export const HPI_NARRATIVE_LOINC = '10164-2';

/** Must equal `DRCHRONO_CLINICAL_NOTE_SYSTEM` in `bots/shared/soap-note.ts`. */
export const DRCHRONO_CLINICAL_NOTE_SYSTEM = 'https://drchrono.com/clinical-note-ids';

/** Identifier of the bot that drafts the note and pushes it to DrChrono. */
export const SOAP_NOTE_BOT_IDENTIFIER = {
  system: 'https://lyfe.health/bots',
  value: 'lyfe-soap-note',
};

/** The five editable text blocks, one per leaf section. Mirrors `SoapNarratives`. */
export interface SoapNarratives {
  chiefComplaint: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

/** A `Condition` the assessment section cites. */
export interface SoapSource {
  reference: string;
  label: string;
}

export interface SoapNote {
  compositionId: string;
  /** `Composition.date`. */
  generatedAt?: string;
  status: Composition['status'];
  /** `status === 'final'`: a clinician has signed off on the text. */
  approved: boolean;
  narratives: SoapNarratives;
  /** From the assessment section's `entry[]` — what `assessment[].icdCode` became. */
  sources: SoapSource[];
}

/** The three fields DrChrono's clinical-note endpoint receives. */
export interface DrChronoClinicalNoteFields {
  chief_complaint: string;
  history_of_present_illness: string;
  assessment_and_plan: string;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

/**
 * Escape text for an XHTML narrative. Must match `escapeXhtml` on the bot side.
 * @param text - Plain text.
 * @returns The text, safe to place in XHTML.
 */
export function escapeXhtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Wrap plain text as a FHIR narrative. Must match `toNarrative` on the bot side —
 * `<pre>`, so the whitespace-significant DrChrono payload survives a round trip.
 * @param text - Plain text.
 * @returns A generated `Narrative`.
 */
export function toNarrative(text: string): Narrative {
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><pre>${escapeXhtml(text)}</pre></div>`,
  };
}

/**
 * Read the plain text back out of a `Narrative.div`, newlines intact.
 *
 * Tag-stripping rather than DOM parsing, deliberately: the result is rendered as
 * a React text node — never as HTML — so model output cannot become markup in the
 * provider's browser no matter what it contains.
 * @param div - The `Narrative.div` XHTML.
 * @returns The text content.
 */
export function textFromNarrative(div: string | undefined): string {
  if (!div) {
    return '';
  }
  return div
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos);/gi, (entity) => XML_ENTITIES[entity.toLowerCase()] ?? entity)
    .trim();
}

function hasLoinc(section: CompositionSection, code: string): boolean {
  return Boolean(section.code?.coding?.some((coding) => coding.system === LOINC_SYSTEM && coding.code === code));
}

/**
 * Find a section by its LOINC code, at the top level or one level down.
 * @param composition - The stored note.
 * @param code - The LOINC section code.
 * @returns The section, or undefined.
 */
export function findSoapSection(composition: Composition, code: string): CompositionSection | undefined {
  for (const section of composition.section ?? []) {
    if (hasLoinc(section, code)) {
      return section;
    }
    for (const child of section.section ?? []) {
      if (hasLoinc(child, code)) {
        return child;
      }
    }
  }
  return undefined;
}

/**
 * Parse the stored Composition into the drawer's view model.
 *
 * Tolerant by design: a section the bot never wrote comes back as an empty
 * string. A provider looking at a note should not lose the whole drawer to one
 * missing block.
 * @param composition - The stored note.
 * @returns The view model.
 */
export function parseSoapComposition(composition: Composition): SoapNote {
  const read = (code: string): string => textFromNarrative(findSoapSection(composition, code)?.text?.div);
  const assessmentSection = findSoapSection(composition, SOAP_SECTION_LOINC.assessment);
  return {
    compositionId: composition.id ?? '',
    generatedAt: composition.date,
    status: composition.status,
    approved: composition.status === 'final',
    narratives: {
      chiefComplaint: read(CHIEF_COMPLAINT_LOINC),
      subjective: read(HPI_NARRATIVE_LOINC),
      objective: read(SOAP_SECTION_LOINC.objective),
      assessment: read(SOAP_SECTION_LOINC.assessment),
      plan: read(SOAP_SECTION_LOINC.plan),
    },
    sources: (assessmentSection?.entry ?? [])
      .filter((entry) => entry.reference)
      .map((entry) => ({ reference: entry.reference as string, label: entry.display ?? (entry.reference as string) })),
  };
}

/**
 * The DrChrono payload, derived from the five blocks.
 *
 * Must match `toDrChronoFields` on the bot side: the drawer shows this in the
 * submit confirmation, and a preview that differed from what is transmitted would
 * be worse than no preview.
 * @param narratives - The five blocks.
 * @returns The DrChrono clinical-note fields.
 */
export function toDrChronoFields(narratives: SoapNarratives): DrChronoClinicalNoteFields {
  return {
    chief_complaint: narratives.chiefComplaint,
    history_of_present_illness: [narratives.subjective, narratives.objective].filter(Boolean).join('\n\n'),
    assessment_and_plan: [narratives.assessment, narratives.plan].filter(Boolean).join('\n\n'),
  };
}

function loincCode(code: string, text: string): { coding: { system: string; code: string }[]; text: string } {
  return { coding: [{ system: LOINC_SYSTEM, code }], text };
}

/**
 * Turn the five blocks into `Composition.section[]`. Must match
 * `buildSoapSections` on the bot side; a drift test asserts it does.
 * @param narratives - The five blocks.
 * @param assessmentEntries - The Conditions the assessment cites, carried over unchanged.
 * @returns The sections, in SOAP order.
 */
export function buildSoapSections(
  narratives: SoapNarratives,
  assessmentEntries: Reference[] = []
): CompositionSection[] {
  const sections: CompositionSection[] = [];

  const subjectiveChildren: CompositionSection[] = [];
  if (narratives.chiefComplaint) {
    subjectiveChildren.push({
      title: 'Chief Complaint',
      code: loincCode(CHIEF_COMPLAINT_LOINC, 'Chief complaint'),
      text: toNarrative(narratives.chiefComplaint),
    });
  }
  if (narratives.subjective) {
    subjectiveChildren.push({
      title: 'History of Present Illness',
      code: loincCode(HPI_NARRATIVE_LOINC, 'History of present illness'),
      text: toNarrative(narratives.subjective),
    });
  }
  if (subjectiveChildren.length > 0) {
    sections.push({
      title: 'Subjective',
      code: loincCode(SOAP_SECTION_LOINC.subjective, 'Subjective'),
      section: subjectiveChildren,
    });
  }

  if (narratives.objective) {
    sections.push({
      title: 'Objective',
      code: loincCode(SOAP_SECTION_LOINC.objective, 'Objective'),
      text: toNarrative(narratives.objective),
    });
  }

  if (narratives.assessment || assessmentEntries.length > 0) {
    sections.push({
      title: 'Assessment',
      code: loincCode(SOAP_SECTION_LOINC.assessment, 'Assessment'),
      ...(narratives.assessment && { text: toNarrative(narratives.assessment) }),
      ...(assessmentEntries.length > 0 && { entry: assessmentEntries }),
    });
  }

  if (narratives.plan) {
    sections.push({
      title: 'Plan',
      code: loincCode(SOAP_SECTION_LOINC.plan, 'Plan'),
      text: toNarrative(narratives.plan),
    });
  }

  return sections;
}

/**
 * Apply a provider's edits to the stored note.
 *
 * Drops the note back to `preliminary`, which is the whole point: an approved
 * note that has been edited since approval is not approved any more, and the push
 * gate reads `status`. lyfe-provider-ui did the same thing by resetting
 * `soapStatus` to DRAFT and clearing `soapApprovedAt`.
 *
 * The assessment section's `entry[]` is carried across untouched. Those are the
 * Conditions the bot matched from the chart; the provider is editing prose, not
 * re-matching diagnoses.
 * @param composition - The stored note.
 * @param narratives - The edited blocks.
 * @returns The Composition to save.
 */
export function applySoapEdits(composition: Composition, narratives: SoapNarratives): Composition {
  const entries = findSoapSection(composition, SOAP_SECTION_LOINC.assessment)?.entry ?? [];
  return {
    ...composition,
    status: 'preliminary',
    section: buildSoapSections(narratives, entries),
  };
}

/**
 * The search that finds an encounter's SOAP note. Mirrors `soapNoteSearchQuery` on the bot side.
 * @param encounterId - The encounter the note documents.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function soapNoteSearchQuery(encounterId: string): string {
  return `identifier=${encodeURIComponent(`${SOAP_NOTE_IDENTIFIER_SYSTEM}|${encounterId}`)}`;
}
