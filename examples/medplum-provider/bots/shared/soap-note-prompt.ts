// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The prompt side of the AI SOAP note: an encounter's clinical data in, a
 * context block out. Pure — the bot does the reads.
 *
 * ONLY THE ENCOUNTER-DATA PATH
 * ----------------------------
 * lyfe-provider-ui's generator had two paths. The first read an
 * `enhancedTranscript` off a `ClinicalDocumentationSession`; a repo-wide grep of
 * that app finds exactly one reference to the model, the read in the SOAP
 * service itself. There is no writer, no seed and no raw SQL that ever inserts
 * one, so the branch cannot be taken in production and every real draft comes
 * from the second path. It is not ported. If ambient capture ever lands here, the
 * seam is one more block in {@link buildEncounterPrompt} and one more line in the
 * system prompt — not a second code path.
 *
 * WHAT STANDS IN FOR WHAT
 * -----------------------
 * lyfe-provider-ui read Prisma rows; the equivalents here are FHIR:
 *
 *   appointment.clinicalNote (CC/HPI/ROS/PE/A&P)  →  ClinicalImpression.note
 *   appointment.reason                            →  Encounter.reasonCode
 *   patient.conditions / medications / allergies  →  Condition / MedicationRequest / AllergyIntolerance
 *   patient.labResults                            →  Observation category=laboratory
 *   (no equivalent)                               →  Observation category=vital-signs for the visit
 *
 * Two inputs have no counterpart and are dropped: `aiPostVisitSummary` and
 * `aiPreVisitSummary`, which were JSON blobs written by features that do not
 * exist in this repo. The visit's own vitals more than make up for them — prod
 * had no structured vitals to offer the model at all.
 */
import { calculateAge, formatCodeableConcept, formatObservationValue, getDisplayString } from '@medplum/core';
import type {
  AllergyIntolerance,
  ClinicalImpression,
  Condition,
  Encounter,
  MedicationRequest,
  Observation,
  Patient,
} from '@medplum/fhirtypes';
import { stripNullBytes } from './soap-note.ts';

/** Everything the SOAP generator reads. Caps are applied by the caller. */
export interface EncounterChart {
  patient: Patient;
  encounter: Encounter;
  /** The encounter's chart notes, most recent first. Prod's `appointment.clinicalNote`. */
  impressions: ClinicalImpression[];
  /** Conditions recorded against this encounter — the visit's own diagnoses. */
  encounterConditions: Condition[];
  /** `category=vital-signs` for this encounter, most recent first. */
  vitals: Observation[];
  /** `category=laboratory` for the patient, most recent first. */
  labs: Observation[];
  /** The patient's active problem list. */
  conditions: Condition[];
  /** The patient's active medications. */
  medications: MedicationRequest[];
  /** The patient's active allergies. */
  allergies: AllergyIntolerance[];
}

/** How many of each kind reach the prompt, mirroring lyfe-provider-ui's `take` values. */
export const CHART_LIMITS = {
  conditions: 25,
  medications: 30,
  allergies: 15,
  labs: 10,
  vitals: 12,
  encounterConditions: 15,
  impressions: 3,
} as const;

// `YYYY-MM-DD` from a FHIR dateTime, without pretending to know a time zone.
function day(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

function observationLine(observation: Observation): string {
  const value = formatObservationValue(observation);
  const name = getDisplayString(observation);
  const date = day(observation.effectiveDateTime);
  const flag = observation.interpretation?.[0] ? ` [${formatCodeableConcept(observation.interpretation[0])}]` : '';
  return `- ${name}${value ? `: ${value}` : ''}${flag}${date ? ` (${date})` : ''}`;
}

function listOrNone(lines: string[], none: string): string {
  return lines.length > 0 ? lines.join('\n') : none;
}

/**
 * Render the patient's standing background.
 *
 * lyfe-provider-ui's `buildPatientBackground`, with the name removed. The name
 * was in its version and served no clinical purpose; leaving it out makes the
 * system prompt's "do not include the patient's name" rule structurally true
 * rather than a request.
 * @param chart - The encounter's chart.
 * @returns The background block.
 */
export function buildPatientBackground(chart: EncounterChart): string {
  const { patient } = chart;
  const age = patient.birthDate ? `${calculateAge(patient.birthDate).years}yo` : 'age unknown';
  const lines: string[] = [`Patient: ${age} ${patient.gender ?? 'unknown gender'}`];

  const problems = chart.conditions.slice(0, CHART_LIMITS.conditions).map((condition) => getDisplayString(condition));
  if (problems.length > 0) {
    lines.push(`Active Problems: ${problems.join(', ')}`);
  }

  const medications = chart.medications.slice(0, CHART_LIMITS.medications).map((medication) => {
    const instruction = medication.dosageInstruction?.[0]?.text;
    return `${getDisplayString(medication)}${instruction ? ` ${instruction}` : ''}`;
  });
  if (medications.length > 0) {
    lines.push(`Medications: ${medications.join('; ')}`);
  }

  const allergies = chart.allergies.slice(0, CHART_LIMITS.allergies).map((allergy) => {
    const reaction = allergy.reaction?.[0]?.manifestation?.[0];
    return `${getDisplayString(allergy)}${reaction ? ` (${formatCodeableConcept(reaction)})` : ''}`;
  });
  if (allergies.length > 0) {
    lines.push(`Allergies: ${allergies.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Render the encounter's own clinical data.
 *
 * Ordered the way lyfe-provider-ui ordered its fallbacks — documented note
 * first, then the structured findings — so the model reads the clinician's own
 * words before anything inferred from codes.
 * @param chart - The encounter's chart.
 * @returns The encounter block, empty when the visit carries nothing at all.
 */
export function buildEncounterContext(chart: EncounterChart): string {
  const parts: string[] = [];

  const notes = chart.impressions
    .slice(0, CHART_LIMITS.impressions)
    .flatMap((impression) => (impression.note ?? []).map((note) => note.text ?? ''))
    .map((text) => text.trim())
    .filter(Boolean);
  if (notes.length > 0) {
    parts.push(`Chart Notes:\n${notes.map((note) => `- ${note}`).join('\n')}`);
  }

  const diagnoses = chart.encounterConditions
    .slice(0, CHART_LIMITS.encounterConditions)
    .map((condition) => `- ${getDisplayString(condition)}`);
  if (diagnoses.length > 0) {
    parts.push(`Visit Diagnoses:\n${diagnoses.join('\n')}`);
  }

  const vitals = chart.vitals.slice(0, CHART_LIMITS.vitals).map(observationLine);
  if (vitals.length > 0) {
    parts.push(`Vitals Recorded:\n${vitals.join('\n')}`);
  }

  const labs = chart.labs.slice(0, CHART_LIMITS.labs).map(observationLine);
  if (labs.length > 0) {
    parts.push(`Recent Labs:\n${labs.join('\n')}`);
  }

  // Prod's last resort: with nothing documented, the booking reason is all there
  // is. Kept, and kept last, for the same reason.
  if (parts.length === 0) {
    const reasons = (chart.encounter.reasonCode ?? []).map((reason) => formatCodeableConcept(reason)).filter(Boolean);
    if (reasons.length > 0) {
      parts.push(`Visit Reason: ${reasons.join(', ')}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Render the whole prompt body.
 * @param chart - The encounter's chart.
 * @returns The prompt, NUL-free, or an empty string when the visit has no clinical data at all.
 */
export function buildEncounterPrompt(chart: EncounterChart): string {
  const context = buildEncounterContext(chart);
  if (!context.trim()) {
    return '';
  }

  const kind = chart.encounter.type?.[0]
    ? formatCodeableConcept(chart.encounter.type[0])
    : (chart.encounter.class?.display ?? 'Visit');
  const reasons = (chart.encounter.reasonCode ?? []).map((reason) => formatCodeableConcept(reason)).filter(Boolean);

  return stripNullBytes(
    `
PATIENT BACKGROUND:
${buildPatientBackground(chart)}

ENCOUNTER:
- Date: ${day(chart.encounter.period?.start) ?? 'unknown'}
- Type: ${kind}
- Reason: ${listOrNone(reasons, 'Not specified')}

CLINICAL DATA:
${context}
`.trim()
  );
}

/**
 * The system prompt.
 *
 * lyfe-provider-ui's wording, carried over close to verbatim, with the JSON
 * contract stated here rather than enforced by a Zod schema the Vercel AI SDK
 * passed to the provider. `$ai` has no structured-output parameter, so this text
 * and `parseSoapDraft` are the only things holding the shape.
 *
 * `null` is spelled out for every optional field because the original schema
 * used `.nullable()` and the parser still treats a missing or empty string as
 * null — telling the model that explicitly is cheaper than repairing it after.
 */
export const SOAP_SYSTEM_PROMPT = `You are a clinical documentation assistant generating SOAP notes for healthcare providers.
Generate accurate, professional SOAP notes based on the provided clinical data.
Use standard medical terminology and abbreviations where appropriate.
For assessment items, suggest ICD-10 codes when the diagnosis is clear.
Mark diagnosis status as "new", "ongoing", or "resolved" based on clinical context.
Categorize plan items appropriately (medication, order, referral, follow-up, education, other).
If information for a section is not available, use null for that field.
Do NOT fabricate clinical findings — only document what is supported by the source data.
Do NOT include the patient's name.

Reply with JSON only — no prose, no code fence — in exactly this shape:
{
  "subjective": {
    "chiefComplaint": string,
    "hpiNarrative": string,
    "reviewOfSystems": string | null,
    "socialHistory": string | null
  },
  "objective": {
    "vitals": string | null,
    "physicalExam": string | null,
    "labResults": string | null
  },
  "assessment": [
    { "diagnosis": string, "icdCode": string | null, "status": "new" | "ongoing" | "resolved", "reasoning": string }
  ],
  "plan": [
    {
      "action": string,
      "category": "medication" | "order" | "referral" | "follow-up" | "education" | "other",
      "details": string | null
    }
  ]
}

"chiefComplaint" and "hpiNarrative" are required and must not be empty — a note without them is rejected.
"chiefComplaint" is one short phrase, as it would appear at the top of a chart.
"assessment" and "plan" may be empty arrays if the source data supports no diagnosis or no action.
An "icdCode" must be a real ICD-10-CM code for the diagnosis named, or null. Never guess a code to fill the field.`;
