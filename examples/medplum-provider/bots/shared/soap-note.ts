// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The AI SOAP note draft, as a FHIR `Composition`.
 *
 * Everything here is pure: no MedplumClient, no network, no clock. The bot
 * (`bots/soap-note.ts`) does the reads, the `$ai` call and the DrChrono write;
 * this module turns a model answer into a validated draft, a draft into the
 * Composition, and a Composition back into the three text fields DrChrono's
 * clinical-note endpoint accepts.
 *
 * WHY COMPOSITION, AND WHAT REPLACED `soapStatus`
 * ----------------------------------------------
 * lyfe-provider-ui stored the draft as a JSON blob on `Appointment.soapDraft`
 * with a sibling `soapStatus` enum (DRAFT / APPROVED / SUBMITTED) and three
 * timestamp columns. Here it is a `Composition` whose `status` carries the
 * workflow — `preliminary` is a draft, `final` is approved — and whose
 * `meta.lastUpdated` is the timestamp. No invented field, and a generic FHIR
 * viewer renders the note with no knowledge of Lyfe.
 *
 * SUBMITTED is deliberately *not* a third status. FHIR's CompositionStatus has
 * only `preliminary | final | amended | entered-in-error`, and "we transmitted
 * this to an external EHR" is not a clinical standing of the document — it is an
 * event that happened to it. That belongs in `Provenance`, which this app
 * already writes when a provider signs an encounter. See the bot.
 *
 * THE FOUR SECTIONS
 * -----------------
 * `section[]` is keyed on the standard LOINC section codes rather than on
 * Lyfe-local strings, so the shape is one a C-CDA reader already knows:
 * Subjective `61150-9`, Objective `61149-1`, Assessment `51848-0`,
 * Plan `18776-5`. Subjective nests two sub-sections (Chief complaint `10154-3`
 * and HPI `10164-2`) because DrChrono wants the chief complaint as its own
 * field, so it has to stay separable after a provider edits the note.
 *
 * WHAT HAPPENED TO `assessment[].icdCode`
 * --------------------------------------
 * It is not a stored field. The code is rendered into the assessment narrative,
 * exactly as DrChrono receives it ("1. Hypertension (I10)"), and its
 * machine-readable form is a `Condition` reference in the assessment section's
 * `entry[]`, matched against the patient's own chart by
 * {@link matchAssessmentConditions}. A diagnosis the chart has no Condition for
 * still reaches DrChrono with its code in the text; it simply has nothing true
 * to point at, which beats a reference to a row that does not exist.
 *
 * THE NARRATIVES ARE WHAT GOES TO DRCHRONO
 * ----------------------------------------
 * `renderSoapNarratives` is lyfe-provider-ui's `mapSOAPToDrChronoFormat`, split
 * one step earlier: it produces five text blocks, and the join into DrChrono's
 * three fields happens in {@link toDrChronoFields}. The Composition stores those
 * same blocks verbatim, so
 * `compositionToDrChronoFields(buildSoapComposition(draft))` is byte-identical to
 * `mapSoapToDrChronoFormat(draft)` — pinned by a test. The point is that the
 * provider reads, and edits, the literal text that will enter the EHR. There is
 * no second rendering pass between the drawer and DrChrono.
 */
import type {
  CodeableConcept,
  Composition,
  CompositionSection,
  Condition,
  Device,
  Encounter,
  Narrative,
  Organization,
  Patient,
  Provenance,
  Reference,
} from '@medplum/fhirtypes';

// ---------------------------------------------------------------------------
// Identity and coding
// ---------------------------------------------------------------------------

/**
 * Identifier system for the one SOAP note per encounter. The identifier *value*
 * is the encounter id, which is what makes the bot's conditional update a true
 * upsert: regenerating replaces the note rather than stacking a second one on
 * the chart.
 */
export const SOAP_NOTE_IDENTIFIER_SYSTEM = 'https://lyfe.com/soap-note';

/** LOINC `11488-4` "Consult note" — `Composition.type`. */
export const SOAP_NOTE_LOINC = '11488-4';

/** LOINC, as `Coding.system`. */
export const LOINC_SYSTEM = 'http://loinc.org';

/** The standard LOINC section codes for the four SOAP blocks. */
export const SOAP_SECTION_LOINC = {
  /** `61150-9` Subjective Narrative. */
  subjective: '61150-9',
  /** `61149-1` Objective Narrative. */
  objective: '61149-1',
  /** `51848-0` Assessment note. */
  assessment: '51848-0',
  /** `18776-5` Plan of care note. */
  plan: '18776-5',
} as const;

/** `10154-3` "Chief complaint Narrative - Reported" — the Subjective sub-section DrChrono reads as its own field. */
export const CHIEF_COMPLAINT_LOINC = '10154-3';

/** `10164-2` "History of present illness Narrative" — the other Subjective sub-section. */
export const HPI_NARRATIVE_LOINC = '10164-2';

/** Marks the Composition as this feature's output, for a `category` search. Shared with the AI summary. */
export const COMPOSITION_CATEGORY_SYSTEM = 'https://lyfe.com/CodeSystem/composition-category';

/** `category` code of an AI SOAP note. */
export const SOAP_NOTE_CATEGORY = 'ai-soap-note';

/** Identifier of the Device credited as `Composition.author`. */
export const SOAP_NOTE_DEVICE_IDENTIFIER_SYSTEM = 'https://lyfe.com/soap-note-device';

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

export type DiagnosisStatus = 'new' | 'ongoing' | 'resolved';

export type PlanCategory = 'medication' | 'order' | 'referral' | 'follow-up' | 'education' | 'other';

export const DIAGNOSIS_STATUSES: readonly DiagnosisStatus[] = ['new', 'ongoing', 'resolved'];

export const PLAN_CATEGORIES: readonly PlanCategory[] = [
  'medication',
  'order',
  'referral',
  'follow-up',
  'education',
  'other',
];

export interface SoapAssessment {
  diagnosis: string;
  icdCode: string | null;
  status: DiagnosisStatus;
  reasoning: string;
}

export interface SoapPlanItem {
  action: string;
  category: PlanCategory;
  details: string | null;
}

/** A validated model answer, before it becomes FHIR. Shape carried over from lyfe-provider-ui's Zod schema. */
export interface SoapDraft {
  subjective: {
    chiefComplaint: string;
    hpiNarrative: string;
    reviewOfSystems: string | null;
    socialHistory: string | null;
  };
  objective: {
    vitals: string | null;
    physicalExam: string | null;
    labResults: string | null;
  };
  assessment: SoapAssessment[];
  plan: SoapPlanItem[];
}

/** The three text fields DrChrono's `/clinical_notes` endpoint accepts. */
export interface DrChronoClinicalNoteFields {
  chief_complaint: string;
  history_of_present_illness: string;
  assessment_and_plan: string;
}

/** The five text blocks the Composition stores, one per leaf section. */
export interface SoapNarratives {
  /** Subjective / Chief complaint. */
  chiefComplaint: string;
  /** Subjective / HPI: the HPI narrative plus review of systems and social history. */
  subjective: string;
  /** Objective: vitals, physical exam and labs. */
  objective: string;
  /** Assessment: the numbered diagnosis list. */
  assessment: string;
  /** Plan: the plan items, grouped by category. */
  plan: string;
}

// ---------------------------------------------------------------------------
// Parsing the model's answer
// ---------------------------------------------------------------------------

/**
 * Strip a fenced code block, if the model wrapped its JSON in one.
 * @param text - Raw model output.
 * @returns The text with any surrounding code fence removed.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Strip NUL bytes. Extracted clinical text (OCR, PDF, binary decode) carries
 * 0x00, which breaks both a Postgres write and an XHTML narrative.
 * @param text - Text that may contain NUL.
 * @returns The text without NUL bytes.
 */
export function stripNullBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000/g, '');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? stripNullBytes(value).trim() : '';
}

function asOptionalString(value: unknown): string | null {
  const text = asString(value);
  return text ? text : null;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = typeof value === 'string' ? (value.trim().toLowerCase() as T) : undefined;
  return candidate && allowed.includes(candidate) ? candidate : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Validate and normalise a model answer.
 *
 * `$ai` has no structured-output parameter, unlike the `generateObject` call
 * lyfe-provider-ui relied on, so the JSON contract lives in the prompt and this
 * is the only thing enforcing it.
 *
 * Strict about the two fields a clinical note cannot be missing — the chief
 * complaint and the HPI — and lenient about rows, where a malformed entry is
 * dropped rather than rendered half-built. Unlike the AI summary, assessment and
 * plan are **not capped**: silently truncating a diagnosis list on its way into
 * a legal record is a worse failure than a long note.
 * @param text - The model's raw text output.
 * @returns The validated draft.
 */
export function parseSoapDraft(text: string): SoapDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new Error('The model did not return JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned JSON that is not an object');
  }
  const object = parsed as Record<string, unknown>;

  const subjective = asObject(object.subjective);
  const chiefComplaint = asString(subjective.chiefComplaint);
  if (!chiefComplaint) {
    throw new Error('The model returned no chief complaint');
  }
  const hpiNarrative = asString(subjective.hpiNarrative);
  if (!hpiNarrative) {
    throw new Error('The model returned no history of present illness');
  }

  const objective = asObject(object.objective);

  const assessment: SoapAssessment[] = [];
  for (const row of asArray(object.assessment)) {
    const value = asObject(row);
    const diagnosis = asString(value.diagnosis);
    if (!diagnosis) {
      continue;
    }
    assessment.push({
      diagnosis,
      icdCode: asOptionalString(value.icdCode),
      status: asEnum(value.status, DIAGNOSIS_STATUSES, 'new'),
      reasoning: asString(value.reasoning),
    });
  }

  const plan: SoapPlanItem[] = [];
  for (const row of asArray(object.plan)) {
    const value = asObject(row);
    const action = asString(value.action);
    if (!action) {
      continue;
    }
    plan.push({
      action,
      category: asEnum(value.category, PLAN_CATEGORIES, 'other'),
      details: asOptionalString(value.details),
    });
  }

  return {
    subjective: {
      chiefComplaint,
      hpiNarrative,
      reviewOfSystems: asOptionalString(subjective.reviewOfSystems),
      socialHistory: asOptionalString(subjective.socialHistory),
    },
    objective: {
      vitals: asOptionalString(objective.vitals),
      physicalExam: asOptionalString(objective.physicalExam),
      labResults: asOptionalString(objective.labResults),
    },
    assessment,
    plan,
  };
}

// ---------------------------------------------------------------------------
// Rendering — lyfe-provider-ui's mapSOAPToDrChronoFormat, split in two
// ---------------------------------------------------------------------------

/** Category headings, verbatim from lyfe-provider-ui. */
const PLAN_CATEGORY_LABELS: Record<string, string> = {
  medication: 'Medications',
  order: 'Orders',
  referral: 'Referrals',
  'follow-up': 'Follow-up',
  education: 'Patient Education',
  other: 'Other',
};

/**
 * Render a draft as the five text blocks.
 *
 * This is the body of lyfe-provider-ui's `mapSOAPToDrChronoFormat`, unchanged
 * apart from stopping one step short of the final join: the subjective and
 * objective halves of DrChrono's `history_of_present_illness` are returned
 * separately so they can live in their own FHIR sections, and the assessment and
 * plan halves of `assessment_and_plan` likewise.
 * @param draft - The validated draft.
 * @returns The five blocks, each possibly empty.
 */
export function renderSoapNarratives(draft: SoapDraft): SoapNarratives {
  const subjectiveSections: string[] = [`HPI:\n${draft.subjective.hpiNarrative}`];

  if (draft.subjective.reviewOfSystems) {
    subjectiveSections.push(`Review of Systems:\n${draft.subjective.reviewOfSystems}`);
  }

  if (draft.subjective.socialHistory) {
    subjectiveSections.push(`Social History:\n${draft.subjective.socialHistory}`);
  }

  const objectiveSections: string[] = [];

  if (draft.objective.vitals) {
    objectiveSections.push(`Vitals:\n${draft.objective.vitals}`);
  }

  if (draft.objective.physicalExam) {
    objectiveSections.push(`Physical Exam:\n${draft.objective.physicalExam}`);
  }

  if (draft.objective.labResults) {
    objectiveSections.push(`Lab Results:\n${draft.objective.labResults}`);
  }

  // Assessment — numbered diagnoses with their ICD code and non-default status.
  const assessmentLines = draft.assessment.map((dx, i) => {
    const icdPart = dx.icdCode ? ` (${dx.icdCode})` : '';
    const statusPart = dx.status !== 'new' ? ` [${dx.status}]` : '';
    return `${i + 1}. ${dx.diagnosis}${icdPart}${statusPart}\n   ${dx.reasoning}`;
  });

  // Plan — grouped by category, in the order the categories first appear.
  const planByCategory = new Map<string, { action: string; details: string | null }[]>();
  for (const item of draft.plan) {
    const existing = planByCategory.get(item.category) ?? [];
    existing.push({ action: item.action, details: item.details });
    planByCategory.set(item.category, existing);
  }

  const planSections: string[] = [];
  for (const [category, items] of planByCategory) {
    const label = PLAN_CATEGORY_LABELS[category] ?? category;
    const itemLines = items.map((item) => `  - ${item.action}${item.details ? ` — ${item.details}` : ''}`);
    planSections.push(`${label}:\n${itemLines.join('\n')}`);
  }

  return {
    chiefComplaint: draft.subjective.chiefComplaint,
    subjective: subjectiveSections.join('\n\n'),
    objective: objectiveSections.join('\n\n'),
    assessment: assessmentLines.length > 0 ? `Assessment:\n${assessmentLines.join('\n\n')}` : '',
    plan: planSections.length > 0 ? `Plan:\n${planSections.join('\n\n')}` : '',
  };
}

/**
 * Join the five blocks into DrChrono's three fields.
 *
 * The only mapping step that runs at push time. It is deliberately this dull —
 * everything expressive happened in {@link renderSoapNarratives} before the text
 * was stored, so what the provider approved is what is transmitted.
 * @param narratives - The five blocks, as stored in the Composition.
 * @returns The DrChrono clinical-note fields.
 */
export function toDrChronoFields(narratives: SoapNarratives): DrChronoClinicalNoteFields {
  return {
    chief_complaint: narratives.chiefComplaint,
    history_of_present_illness: [narratives.subjective, narratives.objective].filter(Boolean).join('\n\n'),
    assessment_and_plan: [narratives.assessment, narratives.plan].filter(Boolean).join('\n\n'),
  };
}

/**
 * lyfe-provider-ui's `mapSOAPToDrChronoFormat`, preserved end to end.
 *
 * Nothing in the shipping path calls this — generation stores narratives and the
 * push reads them back — but it is the definition the port is measured against:
 * a test asserts `compositionToDrChronoFields(buildSoapComposition(draft))`
 * equals this, which is what proves the Composition is a lossless home for the
 * DrChrono payload.
 * @param draft - The validated draft.
 * @returns The DrChrono clinical-note fields.
 */
export function mapSoapToDrChronoFormat(draft: SoapDraft): DrChronoClinicalNoteFields {
  return toDrChronoFields(renderSoapNarratives(draft));
}

// ---------------------------------------------------------------------------
// Narrative XHTML
// ---------------------------------------------------------------------------

/**
 * Escape text for an XHTML narrative. `Narrative.div` is parsed as XML, so an
 * unescaped `&` in a drug name does not look wrong — it makes the whole resource
 * invalid.
 * @param text - Plain text.
 * @returns The text, safe to place in XHTML.
 */
export function escapeXhtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

/**
 * Wrap plain text as a FHIR narrative that survives a round trip.
 *
 * `<pre>` rather than `<p>`, which is the one interesting choice here. The
 * DrChrono payload is whitespace-significant — headings separated by a blank
 * line, plan items indented two spaces — and `<p>` would hand it to any reader
 * that collapses whitespace as one run-on paragraph. `pre` is in FHIR's
 * permitted narrative element list and preserves the text exactly, which is what
 * lets {@link textFromNarrative} reconstruct it character for character.
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
 * Read the plain text back out of a `Narrative.div`.
 *
 * Tag-stripping rather than DOM parsing, and newline-preserving rather than
 * whitespace-collapsing: the result is the DrChrono payload, so losing the line
 * structure would silently reformat a clinical note on its way into the EHR.
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

// ---------------------------------------------------------------------------
// Condition matching
// ---------------------------------------------------------------------------

// Codes are compared without punctuation or case: DrChrono sends "I10", the
// model may answer "i10." and a FHIR Condition may carry "I10.0".
function normaliseCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Match the draft's ICD codes against the patient's own Conditions.
 *
 * This is what `assessment[].icdCode` became: a real reference in the assessment
 * section's `entry[]` instead of a bare string in a JSON blob. Matching is on the
 * code, never on the diagnosis text — a name match would happily point an
 * assessment at an unrelated problem, and a reference to the wrong Condition is
 * worse than no reference at all.
 *
 * Codes shorter than three characters are ignored: ICD-10 has none, and a
 * one-character "code" from a confused model would match far too much.
 * @param draft - The validated draft.
 * @param conditions - The patient's Conditions, already read.
 * @returns One reference per matched Condition, in assessment order, deduped.
 */
export function matchAssessmentConditions(draft: SoapDraft, conditions: Condition[]): Reference<Condition>[] {
  const byCode = new Map<string, Condition>();
  for (const condition of conditions) {
    for (const coding of condition.code?.coding ?? []) {
      const code = coding.code ? normaliseCode(coding.code) : '';
      if (code.length >= 3 && !byCode.has(code)) {
        byCode.set(code, condition);
      }
    }
  }

  const entries: Reference<Condition>[] = [];
  const seen = new Set<string>();
  for (const item of draft.assessment) {
    const code = item.icdCode ? normaliseCode(item.icdCode) : '';
    if (code.length < 3) {
      continue;
    }
    const condition = byCode.get(code);
    const reference = condition?.id ? `Condition/${condition.id}` : undefined;
    if (!reference || seen.has(reference)) {
      continue;
    }
    seen.add(reference);
    entries.push({ reference, display: condition?.code?.text ?? item.diagnosis });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function loincCode(code: string, text: string): CodeableConcept {
  return { coding: [{ system: LOINC_SYSTEM, code }], text };
}

/**
 * Turn the five narrative blocks into `Composition.section[]`.
 *
 * A block with no text is omitted rather than written empty: an empty section
 * needs `emptyReason` to satisfy FHIR's `cmp-1`, and inventing a reason the
 * model never gave is worse than a shorter note. The reader keys on the LOINC
 * code and treats a missing section as an empty string, so the join in
 * {@link compositionToDrChronoFields} comes out the same either way.
 * @param narratives - The five blocks.
 * @param assessmentEntries - Conditions the assessment cites, from {@link matchAssessmentConditions}.
 * @returns The sections, in SOAP order.
 */
export function buildSoapSections(
  narratives: SoapNarratives,
  assessmentEntries: Reference<Condition>[] = []
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

// ---------------------------------------------------------------------------
// Reading a stored Composition
// ---------------------------------------------------------------------------

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
 * Read the five narrative blocks back out of a stored note.
 * @param composition - The stored note.
 * @returns The five blocks, each empty when its section is absent.
 */
export function compositionToSoapNarratives(composition: Composition): SoapNarratives {
  const read = (code: string): string => textFromNarrative(findSoapSection(composition, code)?.text?.div);
  return {
    chiefComplaint: read(CHIEF_COMPLAINT_LOINC),
    subjective: read(HPI_NARRATIVE_LOINC),
    objective: read(SOAP_SECTION_LOINC.objective),
    assessment: read(SOAP_SECTION_LOINC.assessment),
    plan: read(SOAP_SECTION_LOINC.plan),
  };
}

/**
 * Map a stored note onto DrChrono's three clinical-note fields.
 *
 * The whole push payload, derived from the Composition rather than from the
 * draft, so a provider's edit is what gets transmitted.
 * @param composition - The stored note.
 * @returns The DrChrono clinical-note fields.
 */
export function compositionToDrChronoFields(composition: Composition): DrChronoClinicalNoteFields {
  return toDrChronoFields(compositionToSoapNarratives(composition));
}

// ---------------------------------------------------------------------------
// The Composition
// ---------------------------------------------------------------------------

export interface BuildSoapCompositionProps {
  /** The encounter the note documents. `encounter.id` is also the identifier value. */
  encounter: Reference<Encounter> & { reference: string };
  patient: Reference<Patient> & { reference: string };
  /** The Device credited with writing it. */
  author: Reference<Device>;
  narratives: SoapNarratives;
  /** Conditions the assessment cites. */
  assessmentEntries?: Reference<Condition>[];
  /** ISO instant the draft was generated. */
  generatedAt: string;
  /** The clinic compartment, so clinic users can see it at all. */
  account?: Reference<Organization>;
}

/**
 * Build the Composition.
 *
 * `status` is `preliminary`: a freshly generated note is a draft no clinician has
 * read. The UI's approve action is what sets `final`.
 * @param props - The inputs.
 * @returns The Composition, ready for a conditional update on its identifier.
 */
export function buildSoapComposition(props: BuildSoapCompositionProps): Composition {
  const encounterId = props.encounter.reference.split('/')[1];
  return {
    resourceType: 'Composition',
    // Both keys, per the rest of the Lyfe bots: `accounts` is the current field
    // and `account` the deprecated one the compartment search still reads.
    // Without the compartment the write returns 200 and the resource is
    // invisible to every clinic user.
    ...(props.account && { meta: { account: props.account, accounts: [props.account] } }),
    identifier: { system: SOAP_NOTE_IDENTIFIER_SYSTEM, value: encounterId },
    status: 'preliminary',
    type: {
      coding: [{ system: LOINC_SYSTEM, code: SOAP_NOTE_LOINC, display: 'Consult note' }],
      text: 'SOAP note',
    },
    category: [
      {
        coding: [{ system: COMPOSITION_CATEGORY_SYSTEM, code: SOAP_NOTE_CATEGORY }],
        text: 'AI SOAP note',
      },
    ],
    subject: props.patient,
    encounter: props.encounter,
    date: props.generatedAt,
    author: [props.author],
    title: 'SOAP Note',
    section: buildSoapSections(props.narratives, props.assessmentEntries ?? []),
  };
}

/**
 * The search that finds an encounter's SOAP note, for both the bot and the app.
 * @param encounterId - The encounter the note documents.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function soapNoteSearchQuery(encounterId: string): string {
  return `identifier=${encodeURIComponent(`${SOAP_NOTE_IDENTIFIER_SYSTEM}|${encounterId}`)}`;
}

// ---------------------------------------------------------------------------
// The record of a push to DrChrono
// ---------------------------------------------------------------------------

/**
 * Identifier system for a DrChrono **clinical-note row id**.
 *
 * Deliberately not `https://drchrono.com/clinical-notes`, which
 * `bots/drchrono-import.ts` already uses for the visit-note PDF and keys on an
 * appointment id. Two systems whose values mean different things must not
 * share a name — the importer's `clinical-notes|412` and a note row id `412` are
 * unrelated numbers, and a search that conflated them would match the wrong
 * resource.
 */
export const DRCHRONO_CLINICAL_NOTE_SYSTEM = 'https://drchrono.com/clinical-note-ids';

/** `Provenance.activity` for "this was transmitted to an external system". */
export const TRANSMIT_ACTIVITY = {
  system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
  code: 'TRANSMIT',
  display: 'transmit',
} as const;

/** What `Provenance.agent.who` accepts — notably not a Bot. */
export type ProvenanceAgent = NonNullable<NonNullable<Provenance['agent']>[number]['who']>;

export interface BuildPushProvenanceProps {
  composition: Reference<Composition> & { reference: string };
  /** The DrChrono clinical-note row id that was written. */
  clinicalNoteId: string;
  /** Who asked for the push: the caller's profile, or the authoring Device when there is none. */
  agent: ProvenanceAgent;
  recorded: string;
  account?: Reference<Organization>;
}

/**
 * Record a push to DrChrono as a `Provenance`.
 *
 * This is where "SUBMITTED" lives, and it is load-bearing rather than
 * decorative: the push refuses to overwrite a DrChrono note it cannot prove it
 * wrote, and this is the proof. `target` carries both the Composition and the
 * DrChrono row — `Provenance.target` is "the resources that were updated by this
 * activity", and both were — with the external one addressed by `identifier`,
 * since it is not a FHIR resource on this server.
 * @param props - The inputs.
 * @returns The Provenance, ready to create.
 */
export function buildPushProvenance(props: BuildPushProvenanceProps): Provenance {
  return {
    resourceType: 'Provenance',
    ...(props.account && { meta: { account: props.account, accounts: [props.account] } }),
    target: [
      props.composition,
      {
        identifier: { system: DRCHRONO_CLINICAL_NOTE_SYSTEM, value: props.clinicalNoteId },
        display: `DrChrono clinical note ${props.clinicalNoteId}`,
      },
    ],
    recorded: props.recorded,
    activity: { coding: [{ ...TRANSMIT_ACTIVITY }], text: 'Transmitted to DrChrono' },
    agent: [{ who: props.agent, ...(props.account && { onBehalfOf: props.account }) }],
  };
}

/**
 * Read the DrChrono clinical-note ids out of a Composition's Provenance records.
 * @param provenances - Provenance resources targeting the Composition.
 * @returns The note ids this Composition has been pushed to, deduped.
 */
export function drChronoNoteIdsFrom(provenances: Provenance[]): string[] {
  const ids = new Set<string>();
  for (const provenance of provenances) {
    for (const target of provenance.target ?? []) {
      if (target.identifier?.system === DRCHRONO_CLINICAL_NOTE_SYSTEM && target.identifier.value) {
        ids.add(target.identifier.value);
      }
    }
  }
  return [...ids];
}

/** One DrChrono clinical note, as much of it as the push decision needs. */
export interface DrChronoClinicalNote {
  id: number;
  locked?: boolean;
  signed_by?: number | null;
  chief_complaint?: string | null;
  history_of_present_illness?: string | null;
  assessment_and_plan?: string | null;
}

export type ClinicalNoteWrite =
  { kind: 'create' } | { kind: 'update'; noteId: number } | { kind: 'refuse'; reason: string };

/**
 * Decide what the push is allowed to do to DrChrono.
 *
 * Pure, and separated out because this is the one decision in the feature that
 * can destroy a clinician's own work. lyfe-provider-ui PATCHed whatever
 * `drchronoClinicalNoteId` happened to hold, with no check that Lyfe had written
 * that note and no check that it was unlocked; a stale or mis-synced id there
 * overwrites a human-authored note with AI text and the only trace is DrChrono's
 * own audit log.
 *
 * So this fails closed:
 *  - no note for the appointment → create;
 *  - a note Lyfe recorded pushing to → update it, which is what makes a second
 *    push idempotent rather than duplicating;
 *  - a note that is locked or signed → refuse, even if Lyfe wrote it; a signed
 *    note is part of the legal record;
 *  - a note with no content at all → update, there is nothing to lose;
 *  - anything else → refuse and name the note id, because something or someone
 *    other than this feature wrote it.
 * @param props - The decision inputs.
 * @param props.existing - Clinical notes DrChrono holds for the appointment.
 * @param props.recordedNoteIds - Note ids Lyfe has a Provenance for, from {@link drChronoNoteIdsFrom}.
 * @returns What to do.
 */
export function decideClinicalNoteWrite(props: {
  existing: DrChronoClinicalNote[];
  recordedNoteIds: string[];
}): ClinicalNoteWrite {
  const note = props.existing[0];
  if (!note) {
    return { kind: 'create' };
  }
  if (props.existing.length > 1) {
    return {
      kind: 'refuse',
      reason:
        `DrChrono holds ${props.existing.length} clinical notes for this appointment ` +
        `(${props.existing.map((n) => n.id).join(', ')}). Refusing to guess which one to write.`,
    };
  }
  if (note.locked || note.signed_by) {
    return {
      kind: 'refuse',
      reason: `DrChrono clinical note ${note.id} is signed or locked. Unlock it in DrChrono before pushing.`,
    };
  }
  if (props.recordedNoteIds.includes(String(note.id))) {
    return { kind: 'update', noteId: note.id };
  }
  const empty =
    !note.chief_complaint?.trim() && !note.history_of_present_illness?.trim() && !note.assessment_and_plan?.trim();
  if (empty) {
    return { kind: 'update', noteId: note.id };
  }
  return {
    kind: 'refuse',
    reason: `DrChrono clinical note ${note.id} already has content that Lyfe did not write. Refusing to overwrite it.`,
  };
}

/**
 * The DrChrono appointment id an imported Encounter carries.
 *
 * Written by `bots/drchrono-import.ts` under `IDENTIFIER_SYSTEMS.encounter`. An
 * encounter created in Medplum rather than imported has none, which is the only
 * reason the push can be unavailable for an otherwise complete note.
 * @param encounter - The encounter the note documents.
 * @returns The DrChrono appointment id, or undefined.
 */
export function drChronoAppointmentId(encounter: Encounter): string | undefined {
  return encounter.identifier?.find((identifier) => identifier.system === 'https://drchrono.com/appointments')?.value;
}
