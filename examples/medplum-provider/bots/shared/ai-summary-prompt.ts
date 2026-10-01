// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The prompt side of the AI patient summary: a chart in, a tagged context block
 * and a citation index out. Pure — the bot does the reads.
 *
 * Every citable record gets a tag (`C1`, `M3`, `L2`) that appears both in the
 * context the model reads and in the index the bot uses afterwards to turn the
 * model's tags into real references. The two are built in the same pass, from
 * the same arrays, in the same order, which is the only thing that keeps them
 * from drifting.
 *
 * The system prompt is lyfe-provider-ui's, carried over close to verbatim
 * (`lib/services/ai-summary-service.ts`). It earned its wording — the
 * cross-section rules in particular exist because the model kept listing the
 * same finding in the narrative, the risks and the focus areas. What changed:
 * it now has to ask for JSON explicitly, because `$ai` has no structured-output
 * parameter the way the Vercel AI SDK's `generateObject` did.
 */
import { calculateAge, formatCodeableConcept, formatObservationValue, getDisplayString } from '@medplum/core';
import type {
  AllergyIntolerance,
  Appointment,
  Condition,
  Encounter,
  MedicationRequest,
  Observation,
  Patient,
  Reference,
} from '@medplum/fhirtypes';
import type { CitationSource } from './ai-summary.ts';
import { stripNullBytes } from './ai-summary.ts';

/**
 * A document excerpt, for the seam below.
 *
 * ───────────────────────── DOCUMENT CONTEXT SEAM ─────────────────────────
 * lyfe-provider-ui spliced a 600-character excerpt from each of the ten most
 * recent `DocumentExtraction` rows into the prompt as `[D1]`…`[D10]`, so the
 * model could surface a finding that only exists in a scanned referral letter or
 * an imaging report. There is no document-extraction pipeline in this repo yet,
 * so `PatientChart.documents` is always empty and the RECENT DOCUMENTS block
 * renders as "None extracted yet".
 *
 * To light it up, populate `documents` in the bot — one entry per extracted
 * DocumentReference, `reference` pointing at the DocumentReference itself — and
 * nothing else needs to change: the tag letter `D`, the citation index, the
 * system prompt's RECENT DOCUMENTS rules and the UI's citation chip all already
 * handle it. Keep `excerpt` at {@link DOCUMENT_EXCERPT_CHARS} and run it through
 * `stripNullBytes`: extracted OCR text contains NUL.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface SummaryDocument {
  /** The DocumentReference this excerpt came from. */
  reference: Reference;
  title: string;
  /** `YYYY-MM-DD`. */
  date?: string;
  /** Plain text, already truncated and NUL-stripped. */
  excerpt: string;
}

/** How much of a document's text goes in the prompt, per lyfe-provider-ui. */
export const DOCUMENT_EXCERPT_CHARS = 600;

/** Everything the summary reads. Caps are applied by the caller. */
export interface PatientChart {
  patient: Patient;
  conditions: Condition[];
  medications: MedicationRequest[];
  allergies: AllergyIntolerance[];
  /** `category=laboratory`, most recent first. */
  labs: Observation[];
  /** `category=vital-signs`, most recent first. */
  vitals: Observation[];
  /** Most recent first. */
  encounters: Encounter[];
  /** Future only, soonest first. */
  appointments: Appointment[];
  /** See the seam above. Empty until document extraction exists. */
  documents: SummaryDocument[];
}

/**
 * How many of each kind are cited. Beyond these the record still counts towards
 * the stated total in the prompt but is not individually citable — carried over
 * from lyfe-provider-ui, where the limits kept the prompt inside a sane size.
 */
export const CITATION_LIMITS = {
  conditions: 25,
  medications: 15,
  allergies: 15,
  labs: 10,
  vitals: 8,
  encounters: 5,
  documents: 10,
} as const;

const DAY_MS = 86_400_000;

// `YYYY-MM-DD` from a FHIR dateTime, without pretending to know a time zone.
function day(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

function withDisplay(resource: { resourceType: string; id?: string }, display: string): Reference {
  return { reference: `${resource.resourceType}/${resource.id}`, display };
}

// The label shown on a lab or vital chip: the test name and its value.
function observationLabel(observation: Observation): string {
  const value = formatObservationValue(observation);
  const name = getDisplayString(observation);
  return value ? `${name}: ${value}` : name;
}

function encounterLabel(encounter: Encounter): string {
  const date = day(encounter.period?.start) ?? 'undated';
  const kind = encounter.type?.[0] ? formatCodeableConcept(encounter.type[0]) : (encounter.class?.display ?? 'Visit');
  return `${date} ${kind}`;
}

/**
 * Build the tag-to-resource index.
 *
 * Order matters and is the same order {@link buildChartPrompt} lists the records
 * in, because the tags are positional: `C3` is the third condition in both.
 * @param chart - The patient's chart.
 * @returns Tag (without brackets) to citable source.
 */
export function buildCitationIndex(chart: PatientChart): Map<string, CitationSource> {
  const index = new Map<string, CitationSource>();
  const add = (tag: string, kind: CitationSource['kind'], reference: Reference): void => {
    index.set(tag, { tag, kind, reference });
  };

  chart.conditions.slice(0, CITATION_LIMITS.conditions).forEach((condition, i) => {
    add(`C${i + 1}`, 'condition', withDisplay(condition, getDisplayString(condition)));
  });
  chart.medications.slice(0, CITATION_LIMITS.medications).forEach((medication, i) => {
    add(`M${i + 1}`, 'medication', withDisplay(medication, getDisplayString(medication)));
  });
  chart.allergies.slice(0, CITATION_LIMITS.allergies).forEach((allergy, i) => {
    add(`A${i + 1}`, 'allergy', withDisplay(allergy, getDisplayString(allergy)));
  });
  chart.labs.slice(0, CITATION_LIMITS.labs).forEach((lab, i) => {
    add(`L${i + 1}`, 'lab', withDisplay(lab, observationLabel(lab)));
  });
  chart.vitals.slice(0, CITATION_LIMITS.vitals).forEach((vital, i) => {
    add(`V${i + 1}`, 'vital', withDisplay(vital, observationLabel(vital)));
  });
  chart.encounters.slice(0, CITATION_LIMITS.encounters).forEach((encounter, i) => {
    add(`E${i + 1}`, 'encounter', withDisplay(encounter, encounterLabel(encounter)));
  });
  chart.documents.slice(0, CITATION_LIMITS.documents).forEach((document, i) => {
    add(`D${i + 1}`, 'document', { ...document.reference, display: document.title });
  });

  return index;
}

function listOrNone(lines: string[], none: string): string {
  return lines.length > 0 ? lines.join('\n') : none;
}

/**
 * Render the chart as the tagged context block the model reads.
 * @param chart - The patient's chart.
 * @param now - The moment the summary is being generated.
 * @returns The prompt body, NUL-free.
 */
export function buildChartPrompt(chart: PatientChart, now: Date): string {
  const { patient } = chart;
  const age = patient.birthDate ? `${calculateAge(patient.birthDate).years}` : 'Unknown';
  const lastVisit = day(chart.encounters[0]?.period?.start);
  const daysSinceLastVisit = lastVisit
    ? Math.round((now.getTime() - new Date(lastVisit).getTime()) / DAY_MS)
    : undefined;

  const conditions = chart.conditions.slice(0, CITATION_LIMITS.conditions).map((condition, i) => {
    const severity = condition.severity ? ` [${formatCodeableConcept(condition.severity)}]` : '';
    const onset = day(condition.onsetDateTime);
    return `- [C${i + 1}] ${getDisplayString(condition)}${severity}${onset ? ` (onset ${onset})` : ''}`;
  });

  const medications = chart.medications.slice(0, CITATION_LIMITS.medications).map((medication, i) => {
    const instruction = medication.dosageInstruction?.[0]?.text;
    return `- [M${i + 1}] ${getDisplayString(medication)}${instruction ? ` — ${instruction}` : ''}`;
  });

  const allergies = chart.allergies.slice(0, CITATION_LIMITS.allergies).map((allergy, i) => {
    const criticality = allergy.criticality ? ` (${allergy.criticality})` : '';
    const reaction = allergy.reaction?.[0]?.severity ? ` [${allergy.reaction[0].severity}]` : '';
    return `- [A${i + 1}] ${getDisplayString(allergy)}${criticality}${reaction}`;
  });

  const labs = chart.labs.slice(0, CITATION_LIMITS.labs).map((lab, i) => {
    const flag = lab.interpretation?.[0] ? ` [${formatCodeableConcept(lab.interpretation[0])}]` : '';
    const date = day(lab.effectiveDateTime);
    return `- [L${i + 1}] ${observationLabel(lab)}${flag}${date ? ` (${date})` : ''}`;
  });

  const vitals = chart.vitals.slice(0, CITATION_LIMITS.vitals).map((vital, i) => {
    const date = day(vital.effectiveDateTime);
    return `- [V${i + 1}] ${observationLabel(vital)}${date ? ` (${date})` : ''}`;
  });

  const encounters = chart.encounters.slice(0, CITATION_LIMITS.encounters).map((encounter, i) => {
    const reason = encounter.reasonCode?.[0] ? ` — ${formatCodeableConcept(encounter.reasonCode[0])}` : '';
    return `- [E${i + 1}] ${encounterLabel(encounter)}${reason}`;
  });

  // See the DOCUMENT CONTEXT SEAM on SummaryDocument: always empty for now.
  const documents = chart.documents.slice(0, CITATION_LIMITS.documents).map((document, i) => {
    const excerpt = document.excerpt.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_EXCERPT_CHARS);
    return `- [D${i + 1}] ${document.date ?? 'undated'} | ${document.title}\n  ${excerpt || '(no text extracted)'}`;
  });

  const appointments =
    chart.appointments.length > 0
      ? chart.appointments
          .map((appointment) => {
            const kind = appointment.serviceType?.[0] ? ` (${formatCodeableConcept(appointment.serviceType[0])})` : '';
            return `${day(appointment.start) ?? 'undated'}${kind}`;
          })
          .join(', ')
      : 'None scheduled';

  return stripNullBytes(
    `
AGE: ${age} | GENDER: ${patient.gender ?? 'Unknown'}

ACTIVE CONDITIONS (${chart.conditions.length}):
${listOrNone(conditions, 'None documented')}

CURRENT MEDICATIONS (${chart.medications.length} total, showing up to ${CITATION_LIMITS.medications}):
${listOrNone(medications, 'None')}

ALLERGIES (${chart.allergies.length}):
${listOrNone(allergies, 'None documented')}

LATEST VITALS:
${listOrNone(vitals, 'No vitals recorded')}

RECENT LABS (${chart.labs.length}):
${listOrNone(labs, 'None')}

RECENT ENCOUNTERS (${chart.encounters.length}):
${listOrNone(encounters, 'None')}

RECENT DOCUMENTS (${chart.documents.length}):
${listOrNone(documents, 'None extracted yet')}

UPCOMING APPOINTMENTS: ${appointments}

DAYS SINCE LAST VISIT: ${daysSinceLastVisit ?? 'Unknown'}
TODAY: ${now.toISOString().slice(0, 10)}
`.trim()
  );
}

/**
 * The system prompt.
 *
 * Carried over from lyfe-provider-ui with two changes: the JSON contract is
 * stated here rather than enforced by a Zod schema the SDK passed to the
 * provider, and the patient's name is never in the context so the "do not
 * include the name" rule is now also structurally true.
 */
export const SUMMARY_SYSTEM_PROMPT = `You are a clinical intelligence assistant helping providers prepare for patient encounters. Write as if composing the opening of an HPI — focus on active clinical problems, recent changes, and what matters for the next visit.

Reply with JSON only — no prose, no code fence — in exactly this shape:
{
  "narrative": string,
  "alerts": [{ "severity": "critical" | "warning" | "info", "message": string, "action": string }],
  "risks": [{ "factor": string, "level": "high" | "moderate" | "low", "basis": string }],
  "focusAreas": [{ "topic": string, "reason": string }],
  "careGaps": [{ "gap": string, "recommendation": string }]
}

NARRATIVE:
- 2-3 sentences a provider could pull directly into a clinical note.
- Lead with the PRIMARY active problem(s) and their current status/trajectory (stable, worsening, new).
- Name specific diagnoses, not vague phrases like "multiple conditions" or "complex regimen."
- Mention clinically significant vitals or labs only if abnormal or trending.
- Do NOT include the patient's name.
- Do NOT echo or restate an appointment booking reason — synthesize clinical context from conditions, medications, labs, and encounter history instead.

ALERTS (max 4):
- Only flag findings that require provider ACTION — not general observations.
- Polypharmacy: flag if >=10 medications AND there is a specific interaction risk or deprescribing opportunity.
- Abnormal vitals/labs: flag with the specific value and why it matters.
- Do NOT flag a finding that is already the patient's known, stable baseline (e.g., a stable BMI of 28 is not an alert).

RISKS (max 5):
- Clinical risks from active diagnoses, not lifestyle observations.
- Each risk factor must be DISTINCT — do not repeat a finding that appears in alerts or the narrative.
- "high" = immediate clinical concern. "moderate" = monitor closely. "low" = awareness only.

FOCUS AREAS (max 3):
- Discussion topics the provider should raise at the next encounter.
- Prioritize: disease progression, medication changes, overdue follow-ups, pending results.
- Do NOT duplicate risk factors or alerts — focus areas are about CONVERSATIONS to have.

CARE GAPS (max 3):
- Missing or overdue items only: labs, screenings, referrals, follow-up appointments.
- Be specific about WHAT is missing (e.g., "No HbA1c in 12 months", not "No recent labs").

RECENT DOCUMENTS:
- The patient may have extracted clinical documents ([D1], [D2], ...) holding free-text notes from prior visits, lab reports, imaging or referrals.
- Use them to surface findings not yet captured in structured problems or medications — a recent procedure, a specialist's recommendation, a diagnosis mentioned in a referral letter, an abnormal imaging finding.
- Prefer a document citation when a finding ONLY appears in a document. If the same finding is already a structured condition, cite the condition ([Cn]) instead.

CITATIONS:
- Cite a record by writing its tag inline, e.g. "HbA1c is rising [L2]".
- ONLY use tags that appear in the input. A tag that is not in the input is dropped, so the sentence loses its support.
- Cite in "narrative", "message", "factor", "topic" and "gap" — those are the fields that carry citations through.

CROSS-SECTION RULES:
- NEVER mention the same clinical finding in more than two sections. If obesity is in the narrative, do not also list it in risks AND focus areas.
- Do NOT fabricate clinical data. Only reference what is explicitly provided.
- Keep every field concise — a single sentence or a short phrase.`;
