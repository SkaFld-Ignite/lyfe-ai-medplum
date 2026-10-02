// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The two clinical-decision features that were ported: ICD-10 coding suggestions
 * and drug interaction checking. Prompts, validators and grounding.
 *
 * Pure — no MedplumClient, no network, no clock. `bots/clinical-decision.ts`
 * does the reads, the `$ai` calls and the terminology check.
 *
 * WHAT WAS PORTED AND WHAT WAS REFUSED
 * ------------------------------------
 * lyfe-provider-ui had four clinical-decision surfaces, all of them unreachable
 * in production — no mount, no caller, or a deleted action. Two are here:
 *
 * - **ICD-10 coding** (`lib/services/ai/ai-service.ts` `suggestICDCodes`), because
 *   it can be grounded: the suggestion comes from conditions that are already
 *   documented on the encounter, and every code is checked against the real
 *   `icd-10-cm` CodeSystem before it is shown.
 * - **Drug interactions** (`lib/services/drug-interaction-service.ts`), because it
 *   can be grounded too: the input is the patient's actual active
 *   `MedicationRequest` list, and an interaction naming a drug that is not on
 *   that list is dropped rather than displayed.
 *
 * Two were refused outright, and would be refused again:
 *
 * - **Readmission risk** (`predictReadmissionRisk`) used `Math.random()`.
 * - **Prior authorisation** (`generatePriorAuthDocument`) returned a hardcoded
 *   `0.75` confidence, as `onboarding-service.ts` returned a hardcoded `85.0`.
 *
 * Both are unvalidated clinical predictions. Replacing the random number with a
 * real model does not make the prediction validated; it makes it a plausible
 * number with no study behind it, presented to a clinician who has no way to
 * check it. `treatment-recommendations-service.ts` and
 * `clinical-insights-service.ts` are refused on the same grounds.
 *
 * NEITHER OUTPUT CARRIES A CONFIDENCE SCORE
 * -----------------------------------------
 * Prod's `ICDCodeSuggestion` had `confidence: number` and its UI rendered
 * "95% confidence" chips. There is nothing to compute that from. What replaces
 * it is checkable instead of numeric: every ICD suggestion carries the
 * documented finding it came from, and a `verified` flag set by the terminology
 * server rather than by the model. A clinician can audit both.
 *
 * Prod's `calculateOverallRisk` rollup ("CRITICAL", "HIGH") is also not ported.
 * It was a deterministic function of the model's own severities, so it invented
 * nothing — but it added no information to the per-interaction severities
 * already on screen while adding a headline that reads like a validated score.
 *
 * PROD'S HARDCODED INTERACTION TABLE IS NOT PORTED EITHER
 * -------------------------------------------------------
 * `KNOWN_INTERACTIONS` held four pairs — warfarin/aspirin, lisinopril/potassium,
 * metformin/contrast, ssri/nsaid — with FDA-style prose. That is real clinical
 * knowledge and it is still left out: four curated pairs in front of a model
 * makes the panel look like a drug database while covering almost nothing, and a
 * clinician cannot tell which rows came from the table and which from the model.
 * A real interaction database is a procurement decision, not a constant.
 */

/** Severity of an interaction. `unknown` is for a row the model did not grade. */
export type InteractionSeverity = 'contraindicated' | 'major' | 'moderate' | 'unknown';

export const INTERACTION_SEVERITY_LABELS: Record<InteractionSeverity, string> = {
  contraindicated: 'Contraindicated',
  major: 'Major',
  moderate: 'Moderate',
  unknown: 'Severity not stated',
};

/** One suggested ICD-10-CM code. */
export interface IcdSuggestion {
  /** ICD-10-CM code, upper-cased. */
  code: string;
  /**
   * The code's description. Replaced with the terminology server's own `display`
   * when the code verified, so what is on screen is ICD-10-CM's wording rather
   * than the model's paraphrase of it.
   */
  description: string;
  /**
   * The documented finding this code was drawn from. Required — a suggestion
   * that cannot say where it came from is dropped, because that is exactly the
   * shape an invented code takes.
   */
  basis: string;
  /** True when `CodeSystem/$validate-code` confirmed the code exists. */
  verified?: boolean;
}

/** One possible interaction between two of the patient's medications. */
export interface DrugInteraction {
  /** Exactly two medications, named as they appear on the patient's list. */
  drugs: [string, string];
  severity: InteractionSeverity;
  /** What may happen clinically. */
  effect: string;
  /** What to do about it. */
  management?: string;
}

/** The ICD-10-CM code system, as `drchrono-import.ts` writes it onto conditions. */
export const ICD10_CM_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-cm';

export const MAX_ICD_SUGGESTIONS = 8;
export const MAX_INTERACTIONS = 12;
/** Chart-note text sent with the ICD prompt. */
export const MAX_NOTE_CHARS = 6000;

/**
 * ICD-10-CM code syntax: a letter (never U), two digits or digit+A/B, and an
 * optional extension of up to four more characters, with or without the dot.
 *
 * A first, free filter before the terminology round trip. It is not a substitute
 * for one — "E11.9" and "E11.4" are both well-formed and only one of them is
 * what the chart says — but it throws out the answers that are not codes at all,
 * which is what a model does when it has nothing to suggest.
 *
 * The dot is optional because both forms are in real use (a claim form carries
 * "E119"), and {@link normaliseIcdCode} puts it back before the code is looked
 * up or displayed.
 */
export const ICD10_CM_PATTERN = /^[A-TV-Z][0-9][0-9AB](?:\.?[0-9A-TV-Z]{1,4})?$/;

/**
 * Put the dot back into a dotless code.
 *
 * ICD-10-CM's canonical form is dotted after the third character, and that is
 * what the `icd-10-cm` CodeSystem holds — so a dotless suggestion would fail
 * `$validate-code` and be dropped as if it had been invented. Normalising first
 * means the verification result is about the code rather than about its spelling.
 * @param code - An upper-cased code matching {@link ICD10_CM_PATTERN}.
 * @returns The code in dotted form.
 */
export function normaliseIcdCode(code: string): string {
  return code.length > 3 && !code.includes('.') ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
}

// ---------------------------------------------------------------------------
// Shared JSON parsing
// ---------------------------------------------------------------------------

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function parseObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new Error('The model did not return JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned JSON that is not an object');
  }
  return parsed as Record<string, unknown>;
}

// NUL is stripped on purpose: extracted chart-note text carries it, and it must
// not reach a prompt or a rendered row.
// eslint-disable-next-line no-control-regex
const NUL_PATTERN = /\u0000/g;

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(NUL_PATTERN, '').trim().slice(0, max) : '';
}

// ---------------------------------------------------------------------------
// ICD-10 coding
// ---------------------------------------------------------------------------

export const ICD_SYSTEM_PROMPT = `You are a medical coding assistant. You suggest ICD-10-CM diagnosis codes for one encounter, using ONLY what that encounter has already documented.

Reply with ONLY a JSON object. No prose, no explanation, no code fence.

{
  "suggestions": [
    { "code": "E11.9", "description": "Type 2 diabetes mellitus without complications", "basis": "Documented condition: Type 2 diabetes mellitus" }
  ]
}

Rules:
- Suggest a code ONLY for a diagnosis that appears in the DOCUMENTED CONDITIONS or in the CHART NOTE below. Never add a diagnosis the encounter does not state.
- "basis" must name the documented condition or quote the exact phrase from the chart note that the code comes from. If you cannot point at something in the context, omit the suggestion entirely.
- Prefer the most specific code the documentation actually supports. Do NOT add laterality, acuity, severity or a complication the documentation does not state — an unspecified code that matches the note is correct, and a specific code that outruns it is not.
- Do not repeat a code that the DOCUMENTED CONDITIONS already carry.
- Suggest at most ${MAX_ICD_SUGGESTIONS}. Fewer is better. An empty "suggestions" array is a valid and correct answer when the documentation supports no additional code.
- Do not diagnose. Do not suggest treatment. You are coding what is written.`;

/** What the ICD prompt is built from. */
export interface IcdContext {
  /** Each documented condition, as `label (code)` or just `label`. */
  conditions: string[];
  /** `Encounter.reasonCode` text, when present. */
  reasons: string[];
  /** The encounter's chart note, already length-capped. */
  note?: string;
}

/**
 * Build the user message for the ICD prompt.
 *
 * Headed blocks rather than prose, matching the chart prompt in
 * `ai-summary-prompt.ts`: the rules above refer to "DOCUMENTED CONDITIONS" and
 * "CHART NOTE" by name, so the blocks have to be named.
 * @param context - What the encounter documents.
 * @returns The user message.
 */
export function buildIcdPrompt(context: IcdContext): string {
  const lines: string[] = ['DOCUMENTED CONDITIONS:'];
  lines.push(context.conditions.length > 0 ? context.conditions.map((c) => `- ${c}`).join('\n') : '- None recorded');
  lines.push('', 'REASON FOR VISIT:');
  lines.push(context.reasons.length > 0 ? context.reasons.map((r) => `- ${r}`).join('\n') : '- Not recorded');
  lines.push('', 'CHART NOTE:');
  lines.push(context.note?.trim() ? context.note.trim() : 'None recorded');
  return lines.join('\n');
}

/**
 * Validate the model's ICD suggestions.
 *
 * Three filters, each dropping a different failure. A malformed code is not a
 * code; a suggestion with no `basis` cannot be audited and is the shape an
 * invented diagnosis takes; a code already on the chart is noise. Nothing is
 * defaulted or filled in — a dropped suggestion is dropped.
 * @param text - The model's raw output.
 * @param alreadyCoded - Codes the chart's conditions already carry, upper-cased.
 * @returns The surviving suggestions.
 */
export function parseIcdSuggestions(text: string, alreadyCoded: string[] = []): IcdSuggestion[] {
  const object = parseObject(text);
  const rows = Array.isArray(object.suggestions) ? object.suggestions : [];
  const existing = new Set(alreadyCoded.map((code) => code.toUpperCase()));
  const seen = new Set<string>();
  const out: IcdSuggestion[] = [];

  for (const row of rows) {
    if (out.length >= MAX_ICD_SUGGESTIONS) {
      break;
    }
    const value = (row ?? {}) as Record<string, unknown>;
    const code = normaliseIcdCode(asText(value.code, 12).toUpperCase());
    const basis = asText(value.basis, 400);
    const description = asText(value.description, 300);
    if (!ICD10_CM_PATTERN.test(code) || !basis || !description) {
      continue;
    }
    if (existing.has(code) || seen.has(code)) {
      continue;
    }
    seen.add(code);
    out.push({ code, description, basis });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drug interactions
// ---------------------------------------------------------------------------

export const INTERACTION_SYSTEM_PROMPT = `You are a clinical pharmacology assistant. You review one patient's active medication list for drug-drug interactions.

Reply with ONLY a JSON object. No prose, no explanation, no code fence.

{
  "interactions": [
    {
      "drugs": ["warfarin", "aspirin"],
      "severity": "major",
      "effect": "Additive bleeding risk; increased INR and risk of major haemorrhage.",
      "management": "Avoid the combination where possible; if continued, monitor INR closely and counsel on bleeding signs."
    }
  ]
}

Rules:
- "drugs" must be EXACTLY TWO medications, and both must be taken from the medication list given below. Never name a drug that is not on that list. Never name a drug class, a food or a condition.
- "severity" must be exactly one of: "contraindicated", "major", "moderate".
- Report only clinically significant interactions. Omit theoretical and trivial ones.
- Report at most ${MAX_INTERACTIONS}. An empty "interactions" array is a valid and correct answer, and is the expected one for most medication lists.
- Do not comment on dosing, indication or adherence. Do not suggest a change to the regimen beyond how to manage the interaction itself.`;

/**
 * Build the user message for the interaction prompt.
 * @param medications - The patient's active medications, as they appear on the chart.
 * @returns The user message.
 */
export function buildInteractionPrompt(medications: string[]): string {
  return ['ACTIVE MEDICATION LIST:', ...medications.map((m) => `- ${m}`)].join('\n');
}

function isSeverity(value: string): value is Exclude<InteractionSeverity, 'unknown'> {
  return value === 'contraindicated' || value === 'major' || value === 'moderate';
}

/**
 * Match a drug name the model wrote back to a medication on the patient's list.
 *
 * Containment either way, on lowercased text. A chart's medication is
 * "Warfarin Sodium 5 MG Oral Tablet" and the model will say "warfarin", so an
 * equality check would reject every real match; and the model sometimes returns
 * the full chart string, so the test has to work in both directions.
 *
 * The containment is anchored on a word boundary to stop a short term matching
 * inside an unrelated word — without it "ASA" would ground against "Asacol",
 * which is a different drug and would attribute an interaction to a medication
 * the patient is not taking.
 * @param name - What the model wrote.
 * @param medications - The patient's real medications.
 * @returns The medication as the chart names it, or undefined when it is not on the list.
 */
export function groundDrugName(name: string, medications: string[]): string | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  for (const medication of medications) {
    const hay = medication.toLowerCase();
    if (hay === needle) {
      return medication;
    }
    // Word-boundary containment in the direction "model said the ingredient,
    // chart has the full product name".
    if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)) {
      return medication;
    }
    // And the other direction, for when the model echoed the whole chart string
    // plus a dose it invented.
    if (new RegExp(`\\b${hay.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(needle)) {
      return medication;
    }
  }
  return undefined;
}

/**
 * Validate the model's interactions against the patient's real medication list.
 *
 * This is the grounding step, and it is the reason this feature was portable at
 * all. A row naming a drug the patient is not taking is **dropped**, not
 * displayed with a caveat: an interaction warning about a medication that is not
 * on the chart is not a weak warning, it is a wrong one, and a clinician acting
 * on it would be acting on a drug they never prescribed.
 *
 * The surviving rows are renamed to the chart's own medication strings, so the
 * panel and the medication list say the same words.
 * @param text - The model's raw output.
 * @param medications - The patient's active medications, as the chart names them.
 * @returns The grounded interactions.
 */
export function parseDrugInteractions(text: string, medications: string[]): DrugInteraction[] {
  const object = parseObject(text);
  const rows = Array.isArray(object.interactions) ? object.interactions : [];
  const seen = new Set<string>();
  const out: DrugInteraction[] = [];

  for (const row of rows) {
    if (out.length >= MAX_INTERACTIONS) {
      break;
    }
    const value = (row ?? {}) as Record<string, unknown>;
    const names = Array.isArray(value.drugs) ? value.drugs : [];
    if (names.length !== 2) {
      continue;
    }
    const first = groundDrugName(asText(names[0], 200), medications);
    const second = groundDrugName(asText(names[1], 200), medications);
    if (!first || !second || first === second) {
      continue;
    }
    const effect = asText(value.effect, 600);
    if (!effect) {
      continue;
    }
    const key = [first, second].sort().join('||');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const severityText = asText(value.severity, 32).toLowerCase();
    const management = asText(value.management, 600);
    out.push({
      drugs: [first, second],
      // Not defaulted to a level. A row the model did not grade is shown as
      // ungraded, because asserting "moderate" would be this module inventing
      // the one field a clinician triages on.
      severity: isSeverity(severityText) ? severityText : 'unknown',
      effect,
      ...(management && { management }),
    });
  }
  return out;
}

/** Display order: worst first, ungraded last. */
const SEVERITY_ORDER: Record<InteractionSeverity, number> = {
  contraindicated: 0,
  major: 1,
  moderate: 2,
  unknown: 3,
};

/**
 * Sort interactions worst first.
 * @param interactions - The grounded interactions.
 * @returns The same rows, sorted.
 */
export function sortInteractions(interactions: DrugInteraction[]): DrugInteraction[] {
  return [...interactions].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
