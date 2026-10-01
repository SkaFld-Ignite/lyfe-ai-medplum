// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The prompt side of the pre-visit and post-visit encounter summaries: one
 * encounter's context in, a tagged context block and a citation index out.
 * Pure — the bot does the reads.
 *
 * Ported from lyfe-provider-ui's `lib/services/encounter-summary-service.ts`.
 * Two things from that file are deliberately gone:
 *
 *  - **The dual sourcing.** `fetchEncounterContext` tried Prisma first, then
 *    Medplum, then fell back to Prisma again per record kind, and
 *    `buildSyntheticAppointmentFromMedplum` existed only to make a FHIR
 *    Encounter look like a Prisma Appointment row. Here everything is already
 *    FHIR, so all of that is a net deletion.
 *  - **The bespoke trend maths.** Prod had `buildVitalsTrend` keyed on Prisma
 *    columns (`weightLbs`, `systolicBp`, …) and `buildLabsTrend` keyed on
 *    `testName`. Medplum gives one Observation per measurement, so instead of a
 *    LOINC lookup table there is one {@link buildTrendLines} that groups any
 *    observations by their display name and computes the same arrow delta. It
 *    serves the "LABS BY TEST" and "VITALS TREND" blocks both prompts read.
 *
 * Citations are new here, and are the reason this is worth porting rather than
 * copying. Prod's encounter prompts had no citation mechanism at all: the model
 * wrote prose and nothing in it linked back to a record. The tags below work the
 * way `ai-summary-prompt.ts` established — `[C1]`, `[L2]`, `[V3]` in the context
 * the model reads, the same tags in the index the bot rewrites into
 * `section.entry[]` offsets — so a cited finding becomes a clickable chip rather
 * than a sentence the provider has to go and verify by hand.
 */
import { calculateAge, formatCodeableConcept, formatObservationValue, getDisplayString } from '@medplum/core';
import type {
  AllergyIntolerance,
  Condition,
  Encounter,
  MedicationRequest,
  Observation,
  Patient,
  Reference,
} from '@medplum/fhirtypes';
import type { CitationSource } from './ai-summary.ts';
import { stripNullBytes } from './ai-summary.ts';

/** Which of the two summaries is being written. */
export type SummaryKind = 'pre-visit' | 'post-visit';

/**
 * How far back the chart is read, matching lyfe-provider-ui's `ninetyDaysAgo`.
 * The bot applies it; the prompt only states it.
 */
export const CHART_WINDOW_DAYS = 90;

/**
 * How many of each kind are individually citable. The record still counts
 * towards the stated total beyond these — carried over from prod's `take`
 * limits, which kept the prompt inside a sane size.
 */
export const CITATION_LIMITS = {
  conditions: 20,
  medications: 20,
  allergies: 10,
  labs: 15,
  vitals: 10,
  encounters: 3,
} as const;

/** How many values per test the trend block shows, oldest to newest. */
const TREND_VALUES_PER_TEST = 3;

/** How many tests the trend block lists. */
const TREND_TESTS = 10;

/** How much of a prior visit's chart note goes in the prompt, per prod's `substring(0, 300)`. */
const PRIOR_NOTE_CHARS = 300;

/** How much of this visit's chart note goes in the prompt. Prod capped each note field separately. */
const NOTE_CHARS = 2000;

/**
 * Everything the two summaries read. The bot fills it with one awaited search at
 * a time; the caps above are applied here rather than by the prompt.
 */
export interface EncounterSummaryContext {
  /** The encounter being summarised. */
  encounter: Encounter;
  patient: Patient;
  /** Active and recurring problems. */
  conditions: Condition[];
  /** Active medication requests. */
  medications: MedicationRequest[];
  /** Active allergies. */
  allergies: AllergyIntolerance[];
  /** `category=vital-signs` inside the window, most recent first. */
  recentVitals: Observation[];
  /** `category=laboratory` inside the window, most recent first. */
  recentLabs: Observation[];
  /** The subset of {@link recentVitals} recorded on the encounter's own day. */
  sameDayVitals: Observation[];
  /** The subset of {@link recentLabs} resulted on the encounter's own day. */
  sameDayLabs: Observation[];
  /** Up to {@link CITATION_LIMITS.encounters} encounters before this one, most recent first. */
  priorEncounters: Encounter[];
  /** Chart note text keyed by `Encounter/<id>`, for this encounter and the prior ones. */
  notesByEncounter: Record<string, string>;
  /** The patient AI summary's narrative, when one has been generated. */
  longitudinalContext?: string;
  /** This encounter's stored pre-visit `reasonForVisit`, for the post-visit planned-vs-actual line. */
  preVisitPlan?: string;
}

// `YYYY-MM-DD` from a FHIR dateTime, without pretending to know a time zone.
function day(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

function withDisplay(resource: { resourceType: string; id?: string }, display: string): Reference {
  return { reference: `${resource.resourceType}/${resource.id}`, display };
}

/**
 * The date an observation carries, whichever of the two forms it uses.
 * @param observation - The observation.
 * @returns The effective dateTime, or the issued instant when it has no effective date.
 */
export function observationDate(observation: Observation): string | undefined {
  return observation.effectiveDateTime ?? observation.issued;
}

// The label on a lab or vital chip: the test name and its value.
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
 * The encounter's reason, in the order prod preferred it: reason, then type, then a default.
 * @param encounter - The encounter.
 * @returns The reason text shown in both prompts' REASON line.
 */
export function encounterReason(encounter: Encounter): string {
  const reason = encounter.reasonCode?.[0] ? formatCodeableConcept(encounter.reasonCode[0]) : undefined;
  const type = encounter.type?.[0] ? formatCodeableConcept(encounter.type[0]) : undefined;
  return reason ?? type ?? encounter.class?.display ?? 'General visit';
}

// The direction of a change, for the trend line's delta.
function arrowFor(diff: number): string {
  if (diff > 0) {
    return '↑';
  }
  return diff < 0 ? '↓' : '→';
}

// The leading number in a formatted value, so "7.2 %" and "138/88" both compare.
function leadingNumber(text: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  return match ? Number(match[0]) : undefined;
}

/**
 * Group observations by test and render each one's recent values as a trend line.
 *
 * Replaces prod's two column-keyed trend builders with one that works off the
 * display name, because in FHIR a weight and an HbA1c are the same shape. Each
 * line is `name: oldest → … → newest  ↑ delta`, with the delta only when the
 * first and last values both parse as numbers — a trend the model can cite as a
 * number, which is what both system prompts ask it to do.
 * @param observations - Observations, most recent first.
 * @returns One line per test, at most {@link TREND_TESTS} of them.
 */
export function buildTrendLines(observations: Observation[]): string[] {
  const byTest = new Map<string, { value: string; date: string }[]>();
  for (const observation of observations) {
    const name = getDisplayString(observation);
    const value = formatObservationValue(observation);
    if (!name || !value) {
      continue;
    }
    const values = byTest.get(name) ?? [];
    if (values.length < TREND_VALUES_PER_TEST) {
      // Most recent first on the way in, reversed to oldest → newest on the way out.
      values.push({ value, date: day(observationDate(observation)) ?? 'undated' });
      byTest.set(name, values);
    }
  }

  const lines: string[] = [];
  for (const [name, values] of byTest) {
    if (lines.length === TREND_TESTS) {
      break;
    }
    const ordered = [...values].reverse();
    const series = ordered.map((entry) => `${entry.value} (${entry.date})`).join(' → ');
    const first = leadingNumber(ordered[0].value);
    const last = leadingNumber(ordered[ordered.length - 1].value);
    let delta = '';
    if (ordered.length > 1 && first !== undefined && last !== undefined) {
      const diff = Number((last - first).toFixed(2));
      delta = `  ${arrowFor(diff)} ${Math.abs(diff)}`;
    }
    lines.push(`- ${name}: ${series}${delta}`);
  }
  return lines;
}

/**
 * Build the tag-to-resource index for one of the two summaries.
 *
 * Order matters and is the same order {@link buildPreVisitPrompt} and
 * {@link buildPostVisitPrompt} list the records in, because the tags are
 * positional: `C3` is the third condition in both. The vitals and labs a tag
 * points at differ by kind — the pre-visit briefing cites the 90-day window, the
 * post-visit note cites only what was measured at the visit — so the kind is an
 * argument rather than two separate indices.
 * @param context - The encounter's chart.
 * @param kind - Which summary is being written.
 * @returns Tag (without brackets) to citable source.
 */
export function buildCitationIndex(context: EncounterSummaryContext, kind: SummaryKind): Map<string, CitationSource> {
  const index = new Map<string, CitationSource>();
  const add = (tag: string, citationKind: CitationSource['kind'], reference: Reference): void => {
    index.set(tag, { tag, kind: citationKind, reference });
  };

  const vitals = kind === 'pre-visit' ? context.recentVitals : context.sameDayVitals;
  const labs = kind === 'pre-visit' ? context.recentLabs : context.sameDayLabs;

  context.conditions.slice(0, CITATION_LIMITS.conditions).forEach((condition, i) => {
    add(`C${i + 1}`, 'condition', withDisplay(condition, getDisplayString(condition)));
  });
  context.medications.slice(0, CITATION_LIMITS.medications).forEach((medication, i) => {
    add(`M${i + 1}`, 'medication', withDisplay(medication, getDisplayString(medication)));
  });
  context.allergies.slice(0, CITATION_LIMITS.allergies).forEach((allergy, i) => {
    add(`A${i + 1}`, 'allergy', withDisplay(allergy, getDisplayString(allergy)));
  });
  labs.slice(0, CITATION_LIMITS.labs).forEach((lab, i) => {
    add(`L${i + 1}`, 'lab', withDisplay(lab, observationLabel(lab)));
  });
  vitals.slice(0, CITATION_LIMITS.vitals).forEach((vital, i) => {
    add(`V${i + 1}`, 'vital', withDisplay(vital, observationLabel(vital)));
  });
  context.priorEncounters.slice(0, CITATION_LIMITS.encounters).forEach((encounter, i) => {
    add(`E${i + 1}`, 'encounter', withDisplay(encounter, encounterLabel(encounter)));
  });

  return index;
}

function listOrNone(lines: string[], none: string): string {
  return lines.length > 0 ? lines.join('\n') : none;
}

function patientLine(patient: Patient): string {
  const age = patient.birthDate ? `${calculateAge(patient.birthDate).years}yo` : 'age unknown';
  return `${age} ${patient.gender ?? 'unknown gender'}`;
}

function conditionLines(context: EncounterSummaryContext): string[] {
  return context.conditions.slice(0, CITATION_LIMITS.conditions).map((condition, i) => {
    const severity = condition.severity ? ` [${formatCodeableConcept(condition.severity)}]` : '';
    const onset = day(condition.onsetDateTime);
    return `- [C${i + 1}] ${getDisplayString(condition)}${severity}${onset ? ` (onset ${onset})` : ''}`;
  });
}

function medicationLines(context: EncounterSummaryContext): string[] {
  return context.medications.slice(0, CITATION_LIMITS.medications).map((medication, i) => {
    const instruction = medication.dosageInstruction?.[0]?.text;
    const reason = medication.reasonCode?.[0] ? ` (for: ${formatCodeableConcept(medication.reasonCode[0])})` : '';
    return `- [M${i + 1}] ${getDisplayString(medication)}${instruction ? ` ${instruction}` : ''}${reason}`;
  });
}

function allergyLines(context: EncounterSummaryContext): string[] {
  return context.allergies.slice(0, CITATION_LIMITS.allergies).map((allergy, i) => {
    const criticality = allergy.criticality ? ` (${allergy.criticality})` : '';
    const reaction = allergy.reaction?.[0]?.severity ? ` — ${allergy.reaction[0].severity}` : '';
    return `- [A${i + 1}] ${getDisplayString(allergy)}${criticality}${reaction}`;
  });
}

function observationLines(observations: Observation[], letter: 'L' | 'V', limit: number): string[] {
  return observations.slice(0, limit).map((observation, i) => {
    const interpretation = observation.interpretation?.[0]
      ? ` [${formatCodeableConcept(observation.interpretation[0])}]`
      : '';
    const date = day(observationDate(observation));
    return `- [${letter}${i + 1}] ${observationLabel(observation)}${interpretation}${date ? ` (${date})` : ''}`;
  });
}

function priorVisitLines(context: EncounterSummaryContext): string[] {
  return context.priorEncounters.slice(0, CITATION_LIMITS.encounters).map((encounter, i) => {
    const note = context.notesByEncounter[`Encounter/${encounter.id}`];
    const parts = [encounterLabel(encounter), encounterReason(encounter)];
    if (note) {
      parts.push(`Note: ${note.slice(0, PRIOR_NOTE_CHARS)}`);
    }
    return `- [E${i + 1}] ${parts.join(' | ')}`;
  });
}

/**
 * Render the pre-visit context block: the whole chart, with trends, as the
 * briefing prompt reads it.
 * @param context - The encounter's chart.
 * @param now - The moment the summary is being generated.
 * @returns The prompt body, NUL-free.
 */
export function buildPreVisitPrompt(context: EncounterSummaryContext, now: Date): string {
  const { encounter, patient } = context;

  return stripNullBytes(
    `
PATIENT: ${patientLine(patient)}
APPOINTMENT: ${day(encounter.period?.start) ?? 'unscheduled'}
REASON: ${encounterReason(encounter)}
LOCATION: ${encounter.location?.[0]?.location?.display ?? 'Not specified'}

${
  context.longitudinalContext
    ? `LONGITUDINAL CONTEXT (from patient AI summary):\n${context.longitudinalContext}`
    : 'No longitudinal summary available.'
}

ACTIVE CONDITIONS (${context.conditions.length}):
${listOrNone(conditionLines(context), 'None documented')}

CURRENT MEDICATIONS (${context.medications.length}):
${listOrNone(medicationLines(context), 'None')}

ALLERGIES (${context.allergies.length}):
${listOrNone(allergyLines(context), 'None documented')}

RECENT VITALS (last ${CHART_WINDOW_DAYS} days, ${context.recentVitals.length} records):
${listOrNone(observationLines(context.recentVitals, 'V', CITATION_LIMITS.vitals), 'No vitals recorded')}

VITALS TREND (last available datapoints):
${listOrNone(buildTrendLines(context.recentVitals), 'No trend (insufficient datapoints)')}

LABS BY TEST — last ${TREND_VALUES_PER_TEST} values per test, oldest → newest:
${listOrNone(buildTrendLines(context.recentLabs), 'No labs in window')}

RECENT LABS (raw, last ${CHART_WINDOW_DAYS} days, ${context.recentLabs.length}):
${listOrNone(observationLines(context.recentLabs, 'L', CITATION_LIMITS.labs), 'None')}

PRIOR VISITS (last ${CITATION_LIMITS.encounters}):
${listOrNone(priorVisitLines(context), 'No prior visits')}

TODAY: ${now.toISOString().slice(0, 10)}
`.trim()
  );
}

/**
 * Render the post-visit context block: this visit's note, measurements and
 * decisions, with the history only as trend context.
 * @param context - The encounter's chart.
 * @param now - The moment the summary is being generated.
 * @returns The prompt body, NUL-free.
 */
export function buildPostVisitPrompt(context: EncounterSummaryContext, now: Date): string {
  const { encounter, patient } = context;
  const note = context.notesByEncounter[`Encounter/${encounter.id}`];

  const conditions = context.conditions
    .slice(0, CITATION_LIMITS.conditions)
    .map((condition, i) => `[C${i + 1}] ${getDisplayString(condition)}`)
    .join(', ');
  const medications = context.medications
    .slice(0, CITATION_LIMITS.medications)
    .map((medication, i) => `[M${i + 1}] ${getDisplayString(medication)}`)
    .join(', ');

  return stripNullBytes(
    `
PATIENT: ${patientLine(patient)}
VISIT DATE: ${day(encounter.period?.start) ?? 'undated'}
REASON: ${encounterReason(encounter)}
STATUS: ${encounter.status}

${context.preVisitPlan ? `PRE-VISIT PLAN:\n${context.preVisitPlan}` : ''}

CLINICAL NOTE:
${note ? note.slice(0, NOTE_CHARS) : 'No clinical note available for this encounter.'}

VITALS THIS VISIT:
${listOrNone(observationLines(context.sameDayVitals, 'V', CITATION_LIMITS.vitals), 'None recorded')}

LABS THIS VISIT:
${listOrNone(observationLines(context.sameDayLabs, 'L', CITATION_LIMITS.labs), 'None')}

ACTIVE CONDITIONS: ${conditions || 'None'}
CURRENT MEDICATIONS: ${medications || 'None'}

VITALS TREND (history):
${listOrNone(buildTrendLines(context.recentVitals), 'No trend (insufficient datapoints)')}

LABS TREND (history, last ${TREND_VALUES_PER_TEST} per test):
${listOrNone(buildTrendLines(context.recentLabs), 'No labs in window')}

TODAY: ${now.toISOString().slice(0, 10)}
`.trim()
  );
}

/** Shared tail of both system prompts: how to cite, and what not to invent. */
const CITATION_RULES = `CITATIONS:
- Cite a record by writing its tag inline, e.g. "AST 78 U/L [L2]" or "no GLP-1 on board [M4]".
- ONLY use tags that appear in the input. A tag that is not in the input is dropped, so the sentence loses its support.
- Cite wherever a claim rests on a specific record. Every string field carries citations through.`;

/**
 * The pre-visit system prompt.
 *
 * lyfe-provider-ui's `PRE_VISIT_SYSTEM`, carried over close to verbatim — the
 * care-gap detection rules and the specialty-awareness list in particular earned
 * their wording. What changed: it has to ask for JSON explicitly, because `$ai`
 * has no structured-output parameter the way the Vercel AI SDK's
 * `generateObject` did, and it now has citation rules because the records it
 * reads are tagged.
 */
export const PRE_VISIT_SYSTEM_PROMPT = `You are a board-level consultant clinician preparing the encountering provider for a focused visit. Generate a structured pre-visit briefing that reads like a senior specialist's note, not a generic chart review.

Reply with JSON only — no prose, no code fence — in exactly this shape:
{
  "reasonForVisit": string,
  "relevantHistory": [{ "condition": string, "relevance": string, "status": "active" | "chronic" | "resolving" }],
  "currentMedications": [{ "name": string, "relevantToVisit": boolean, "note": string | null }],
  "recentChanges": [{ "change": string, "date": string, "significance": "notable" | "routine" }],
  "prepItems": [{ "item": string, "priority": "high" | "medium" | "low" }]
}

WRITING RULES
- Be terse and clinical. Each field is a single short sentence or labeled phrase. Skim-readable for a 5-minute prep.
- Cite NUMBERS whenever they're in the input: lab values, weight, BMI, BP, percentages, dates. "AST 78 U/L (↑ from 54, 3 mo)" beats "abnormal LFTs".
- Reference TRENDS over snapshots when a trend is supplied: "Wt up 4 lbs / +2.6% over 60d", "A1c 7.2 → 6.9 → 6.6 over 9 mo".
- Use standard medical abbreviations (T2DM, HTN, NASH, CKD, A1c, eGFR, LFTs, FIB-4, GLP-1, etc.).

ANTI-REDUNDANCY (HARD RULE)
- Each clinical fact appears in exactly ONE section. If you say it in reasonForVisit, do NOT restate it in relevantHistory.
- Reconcile contradictions silently: choose the more-specific or higher-confidence label. e.g. "Obesity (ICD)" + "BMI 27" → "Overweight (BMI 27)", drop the obesity ICD label. e.g. "NASH" + "Fatty liver NEC" → just NASH.
- Never list the same drug twice under different brand names or RxNorm codes.

SPECIALTY AWARENESS
- Infer the specialty from the visit type / reason / location and tailor language accordingly: GI/hepatology, cardiology, primary care, endocrinology, ortho, etc.
- Reference relevant scoring tools / staging systems when applicable: FIB-4 / NAFLD-fibrosis-score (NASH), CHA2DS2-VASc / HAS-BLED (AF), ASCVD risk, A1c targets per ADA, eGFR / KDIGO stage, NYHA class (HF), Child-Pugh (cirrhosis), GOLD stage (COPD), CURB-65 (pneumonia).
- Cite guideline bodies by name when invoking a recommendation: AASLD, ACC/AHA, ADA, KDIGO, USPSTF, ACG, ACR — and only when truly relevant.

CARE-GAP DETECTION (key differentiator)
- Cross-reference the patient's active conditions against guideline-recommended workup. Surface ANY missing items in prepItems or recentChanges. Examples:
  * NASH without FIB-4 calculated or FibroScan → flag "calculate FIB-4 today (AST + ALT + plt + age)"
  * T2DM without A1c in last 3 mo → flag
  * HTN without home BP log or recent metabolic panel → flag
  * AF without recent CHA2DS2-VASc reassessment → flag
- Surface unaddressed items from prior visits' notes ("planned to recheck LFTs in 3 mo — no labs on file since").

FIELD GUIDANCE
- reasonForVisit: One sentence framed around the chief problem + clinical context. Lead with the specific condition (e.g. "F/U NASH with elevated transaminases", not "Follow-up appointment for fatty liver management").
- relevantHistory: 3-6 items max. Each: specific condition + the one number that matters + relevance to today. Drop boilerplate co-morbidities unrelated to the visit reason. "status" is that condition's current trajectory.
- currentMedications: Active meds, at most 6, with "relevantToVisit" true for the ones that bear on the visit reason. Include dose + frequency in "name". Use "note" for an interaction risk, a recent change, or an evidence-based agent that is NOT yet on board (e.g. "no GLP-1 despite obesity + NASH"); null when there is nothing to add.
- recentChanges: Concrete deltas since the last visit only — labs trending, weight delta, new diagnoses, Rx changes, missed appointments. "date" is when it happened, as supplied or relative ("3 days ago"). Return an empty list if nothing meaningful changed.
- prepItems: 3-6 actionable items. Each must specify WHAT to do (review specific result, calculate specific score, order specific test, ask specific question). No generic "review chart".

${CITATION_RULES}

CONSTRAINTS
- Do NOT fabricate data. If a number isn't in the input, do not invent one.
- Do NOT include the patient's name.
- If the visit reason is generic ("Office Visit"), infer focus from the active condition list before defaulting to a general chart review.`;

/**
 * The post-visit system prompt.
 *
 * lyfe-provider-ui's `POST_VISIT_SYSTEM`, with the same two changes as the
 * pre-visit one: an explicit JSON contract in place of the Zod schema, and
 * citation rules.
 */
export const POST_VISIT_SYSTEM_PROMPT = `You are a board-level consultant clinician documenting a completed encounter as a structured progress-note summary the provider can finalize quickly.

Reply with JSON only — no prose, no code fence — in exactly this shape:
{
  "visitOutcome": string,
  "keyFindings": [{ "finding": string, "significance": "critical" | "abnormal" | "normal" }],
  "decisionsMade": [{ "decision": string, "rationale": string }],
  "followUpPlan": [{ "action": string, "timeframe": string }],
  "unresolvedItems": [{ "item": string, "reason": string }]
}

WRITING RULES
- Terse, clinical, skim-readable. Each field is a single short sentence or labeled phrase.
- Cite NUMBERS from the visit (BP measured today, lab values returned, weight, BMI, exam findings).
- Reference TRENDS when supplied — connect today's number to where the patient was trending.
- Use standard medical abbreviations.

ANTI-REDUNDANCY (HARD RULE)
- Each fact appears once. If it's in visitOutcome, don't restate it in keyFindings.
- Reconcile contradictions silently (BMI 27 + "obesity" → "overweight"). Pick the data-supported label.

SPECIALTY AWARENESS
- Decisions and follow-up should reference standard scoring tools / staging / guideline targets when relevant (FIB-4, CHA2DS2-VASc, A1c targets, KDIGO stage, NYHA class, Child-Pugh, etc.).

FIELD GUIDANCE
- visitOutcome: 1-2 sentences a provider could paste into a progress note. State problem(s) addressed + key decisions taken.
- keyFindings: ONLY findings from THIS visit — today's vitals deltas, exam, lab results returned today. At most 5. Tie each to its clinical implication ("AST 78 — F2 fibrosis likely given FIB-4 2.1"). "significance" is how far outside normal the finding is.
- decisionsMade: At most 5. Each decision + its specific clinical rationale. "Started semaglutide 0.25mg weekly — BMI 32 + NASH, no current GLP-1, AASLD endorses for MASH with obesity."
- followUpPlan: At most 4. Specific actions + specific timeframes + what triggers earlier follow-up. "Recheck CMP + LFTs in 12 weeks; sooner if jaundice or RUQ pain." Keep "timeframe" to a short phrase ("12 weeks", "at next visit", "stat").
- unresolvedItems: At most 3, genuinely unresolved only. If everything was addressed today, return an empty list. Don't include "monitor chronically".
- If a pre-visit plan was provided, briefly reference whether planned items were addressed.

${CITATION_RULES}

CONSTRAINTS
- Do NOT fabricate data. Only reference what's in the clinical note + visit data + supplied trends.
- Do NOT include the patient's name.`;
