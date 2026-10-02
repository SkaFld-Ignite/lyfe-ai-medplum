// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * ICD-10 coding suggestions, and drug interaction checking.
 *
 * Two actions in one bot, following `soap-note.ts`: they share the `$ai` plumbing
 * and the error handling, and they are both "read a bit of the chart, ask the
 * model, validate hard".
 *
 * Ported from the clinical-decision features that were dead in
 * lyfe-provider-ui — `lib/services/ai/ai-service.ts` `suggestICDCodes` and
 * `lib/services/drug-interaction-service.ts`. What was refused, and why, is in
 * the header of `shared/clinical-decision.ts`: readmission risk
 * (`Math.random()`), prior auth (a hardcoded `0.75`), treatment recommendations
 * and clinical insights are all unvalidated clinical predictions and are not
 * here.
 *
 * NOTHING IS PERSISTED
 * --------------------
 * Both actions return their answer and write nothing. That is deliberate. A
 * suggested code is not a diagnosis and a possible interaction is not a clinical
 * finding; writing either to the chart would turn model output into a record
 * that later reads as fact, and the panels are advisory by design. The
 * clinician's own action — adding a `Condition`, changing a prescription — is
 * what creates a record, through the surfaces that already do that.
 *
 * It also means no new FHIR resource type and nothing to add to
 * `scripts/setup-tenancy.ts`: every type read below is already in the clinic
 * access policy.
 *
 * THE ICD CODES ARE CHECKED AGAINST REAL TERMINOLOGY
 * --------------------------------------------------
 * Every surviving suggestion goes through `CodeSystem/$validate-code` against
 * `icd-10-cm`. A code the terminology server rejects is dropped — that is the
 * hallucinated-code case, and it is the one failure mode this feature could not
 * ship with. A code it accepts gets the server's own `display` in place of the
 * model's description, so the wording on screen is ICD-10-CM's.
 *
 * When the CodeSystem is not loaded in the project the check cannot run at all.
 * The suggestions are then returned with `verified: false` and
 * `terminologyAvailable: false`, and the card says the codes could not be
 * checked. Silently presenting unchecked codes as checked is the thing that must
 * not happen.
 *
 * NO `Promise.all` AROUND SEARCHES
 * --------------------------------
 * Concurrent Medplum searches auto-batch and the batch flush uses `setTimeout`,
 * which the `vmcontext` sandbox does not have — the bot hangs forever with no
 * error. Every read and every terminology call below is awaited one at a time.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  ClinicalImpression,
  Condition,
  Encounter,
  MedicationRequest,
  Parameters,
  Patient,
} from '@medplum/fhirtypes';
import type { DrugInteraction, IcdSuggestion } from './shared/clinical-decision.ts';
import {
  buildIcdPrompt,
  buildInteractionPrompt,
  ICD10_CM_SYSTEM,
  ICD_SYSTEM_PROMPT,
  INTERACTION_SYSTEM_PROMPT,
  MAX_NOTE_CHARS,
  parseDrugInteractions,
  parseIcdSuggestions,
  sortInteractions,
} from './shared/clinical-decision.ts';

/** Matches the other Lyfe bots: `$ai` forwards this to whatever `LLM_BASE_URL` points at. */
export const DEFAULT_CLINICAL_MODEL = 'global.anthropic.claude-sonnet-4-6';

/**
 * Zero for both actions.
 *
 * Coding and interaction checking are lookups against documentation, not
 * writing. The same encounter must code the same way twice, or the suggestion is
 * not auditable.
 */
const CLINICAL_TEMPERATURE = 0;

/** Active medications read for the interaction check. */
const MEDICATION_COUNT = 40;

/** Conditions read for the coding context. */
const CONDITION_COUNT = 40;

export interface ClinicalDecisionInput {
  action?: 'icd-codes' | 'drug-interactions';
  /** For `icd-codes`. */
  encounterId?: string;
  /** For `drug-interactions`. */
  patientId?: string;
  /** Overrides {@link DEFAULT_CLINICAL_MODEL}. */
  model?: string;
}

export interface ClinicalDecisionResult {
  ok: boolean;
  action?: 'icd-codes' | 'drug-interactions';
  /** `icd-codes`: the suggestions that survived validation and the terminology check. */
  suggestions?: IcdSuggestion[];
  /** `icd-codes`: false when the `icd-10-cm` CodeSystem could not be reached. */
  terminologyAvailable?: boolean;
  /** `icd-codes`: codes the encounter's conditions already carry, read from the chart. */
  documented?: { code: string; display?: string }[];
  /** `drug-interactions`: the medications actually checked, as the chart names them. */
  medications?: string[];
  /** `drug-interactions`: the grounded interactions, worst first. */
  interactions?: DrugInteraction[];
  error?: string;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - `{ action, encounterId | patientId, model? }`.
 * @returns The answer, or the reason there is none.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<ClinicalDecisionInput>
): Promise<ClinicalDecisionResult> {
  // Returned, not thrown, as in the other Lyfe bots: a throw reaches the caller
  // as a bare 500 and hides the message, and most failures here are
  // configuration rather than faults.
  try {
    const action = event.input?.action ?? 'icd-codes';
    const model = event.input?.model ?? DEFAULT_CLINICAL_MODEL;
    if (action === 'drug-interactions') {
      return await checkInteractions(medplum, event.input?.patientId?.trim(), model);
    }
    return await suggestCodes(medplum, event.input?.encounterId?.trim(), model);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// ICD-10 coding
// ---------------------------------------------------------------------------

function conceptLabel(concept: Condition['code']): string {
  return concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? concept?.coding?.[0]?.code ?? '';
}

function icdCodingsOf(condition: Condition): { code: string; display?: string }[] {
  return (condition.code?.coding ?? [])
    .filter((coding) => coding.system?.includes('icd-10') && coding.code)
    .map((coding) => ({
      code: (coding.code as string).toUpperCase(),
      ...(coding.display && { display: coding.display }),
    }));
}

async function suggestCodes(
  medplum: MedplumClient,
  encounterId: string | undefined,
  model: string
): Promise<ClinicalDecisionResult> {
  if (!encounterId) {
    throw new Error('encounterId is required for the icd-codes action');
  }
  const encounter = await medplum.readResource('Encounter', encounterId);
  const patientReference = encounter.subject?.reference;
  if (!patientReference?.startsWith('Patient/')) {
    throw new Error('This encounter has no patient');
  }
  const patient = await medplum.readResource('Patient', patientReference.slice('Patient/'.length));

  const context = await readCodingContext(medplum, patient, encounter);

  const documented: { code: string; display?: string }[] = [];
  for (const coding of context.documentedCodes) {
    if (!documented.some((d) => d.code === coding.code)) {
      documented.push(coding);
    }
  }

  const content = await askModel({
    medplum,
    model,
    system: ICD_SYSTEM_PROMPT,
    user: buildIcdPrompt({ conditions: context.conditions, reasons: context.reasons, note: context.note }),
  });

  const parsed = parseIcdSuggestions(
    content,
    documented.map((d) => d.code)
  );

  const { suggestions, terminologyAvailable } = await verifyCodes(medplum, parsed);
  return { ok: true, action: 'icd-codes', suggestions, terminologyAvailable, documented };
}

/**
 * Read what the encounter documents.
 *
 * Conditions come from two searches rather than one: the encounter's own
 * conditions are the ones being coded, but a coder also needs the patient's
 * standing problems — a chronic condition that the visit manages is codeable on
 * that visit and is usually not re-recorded against it. Both are labelled the
 * same way in the prompt, because the model is told to code only what is
 * documented either way.
 * @param medplum - Bot-scoped Medplum client.
 * @param patient - The patient.
 * @param encounter - The encounter being coded.
 * @returns The prompt context plus the ICD codes already on the chart.
 */
async function readCodingContext(
  medplum: MedplumClient,
  patient: Patient,
  encounter: Encounter
): Promise<{
  conditions: string[];
  reasons: string[];
  note?: string;
  documentedCodes: { code: string; display?: string }[];
}> {
  const seen = new Set<string>();
  const conditions: string[] = [];
  const documentedCodes: { code: string; display?: string }[] = [];

  const collect = (list: readonly Condition[]): void => {
    for (const condition of list) {
      const label = conceptLabel(condition.code);
      const codings = icdCodingsOf(condition);
      const key = `${label}|${codings.map((c) => c.code).join(',')}`;
      if (!label || seen.has(key)) {
        continue;
      }
      seen.add(key);
      conditions.push(codings.length > 0 ? `${label} (${codings.map((c) => c.code).join(', ')})` : label);
      documentedCodes.push(...codings);
    }
  };

  // One at a time. See the header.
  collect(
    await medplum.searchResources('Condition', {
      encounter: `Encounter/${encounter.id}`,
      _count: String(CONDITION_COUNT),
    })
  );
  collect(
    await medplum.searchResources('Condition', {
      subject: `Patient/${patient.id}`,
      'clinical-status': 'active,recurrence,relapse',
      _count: String(CONDITION_COUNT),
    })
  );

  const reasons: string[] = [];
  for (const reason of encounter.reasonCode ?? []) {
    const label = conceptLabel(reason);
    if (label) {
      reasons.push(label);
    }
  }

  const impressions = (await medplum.searchResources('ClinicalImpression', {
    encounter: `Encounter/${encounter.id}`,
    _count: '5',
  })) as ClinicalImpression[];
  const note = impressions
    .flatMap((impression) => impression.note ?? [])
    .map((annotation) => annotation.text)
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_NOTE_CHARS);

  return { conditions, reasons, note: note || undefined, documentedCodes };
}

/**
 * Check each suggested code against the `icd-10-cm` CodeSystem.
 *
 * A rejected code is dropped. A failure of the operation itself — which is what
 * happens when the CodeSystem is not loaded in the project — stops the checking
 * for the whole run and returns `terminologyAvailable: false`, rather than
 * dropping every suggestion as if each one had been rejected. Those two
 * outcomes mean opposite things and must not collapse into each other.
 * @param medplum - Bot-scoped Medplum client.
 * @param suggestions - The suggestions that passed syntax and grounding.
 * @returns The surviving suggestions and whether the check could run.
 */
async function verifyCodes(
  medplum: MedplumClient,
  suggestions: IcdSuggestion[]
): Promise<{ suggestions: IcdSuggestion[]; terminologyAvailable: boolean }> {
  const out: IcdSuggestion[] = [];
  // One call at a time — the no-`Promise.all` rule applies to every Medplum
  // request from a bot, not only to searches.
  for (const suggestion of suggestions) {
    let response: Parameters;
    try {
      response = await medplum.post<Parameters>(medplum.fhirUrl('CodeSystem', '$validate-code'), {
        resourceType: 'Parameters',
        parameter: [
          { name: 'url', valueUri: ICD10_CM_SYSTEM },
          { name: 'code', valueCode: suggestion.code },
        ],
      } satisfies Parameters);
    } catch {
      // The operation itself failed, so nothing has been checked. Return every
      // suggestion unverified and say so.
      return { suggestions: suggestions.map((s) => ({ ...s, verified: false })), terminologyAvailable: false };
    }
    const parameters = response.parameter ?? [];
    if (parameters.find((p) => p.name === 'result')?.valueBoolean !== true) {
      continue;
    }
    const display = parameters.find((p) => p.name === 'display')?.valueString;
    out.push({ ...suggestion, verified: true, ...(display && { description: display }) });
  }
  return { suggestions: out, terminologyAvailable: true };
}

// ---------------------------------------------------------------------------
// Drug interactions
// ---------------------------------------------------------------------------

function medicationLabel(request: MedicationRequest): string {
  const concept = request.medicationCodeableConcept;
  return (
    concept?.text ??
    concept?.coding?.find((c) => c.display)?.display ??
    request.medicationReference?.display ??
    concept?.coding?.[0]?.code ??
    ''
  );
}

async function checkInteractions(
  medplum: MedplumClient,
  patientId: string | undefined,
  model: string
): Promise<ClinicalDecisionResult> {
  if (!patientId) {
    throw new Error('patientId is required for the drug-interactions action');
  }
  // Turns a patient id the caller should not have into a 404 here rather than
  // an empty result that reads as "no interactions".
  await medplum.readResource('Patient', patientId);

  const requests = (await medplum.searchResources('MedicationRequest', {
    subject: `Patient/${patientId}`,
    status: 'active',
    _count: String(MEDICATION_COUNT),
  })) as MedicationRequest[];

  const medications: string[] = [];
  for (const request of requests) {
    const label = medicationLabel(request).trim();
    if (label && !medications.some((m) => m.toLowerCase() === label.toLowerCase())) {
      medications.push(label);
    }
  }

  if (medications.length < 2) {
    // No model call. One drug cannot interact with itself, and prod spent a
    // request to be told so.
    return { ok: true, action: 'drug-interactions', medications, interactions: [] };
  }

  const content = await askModel({
    medplum,
    model,
    system: INTERACTION_SYSTEM_PROMPT,
    user: buildInteractionPrompt(medications),
  });

  return {
    ok: true,
    action: 'drug-interactions',
    medications,
    interactions: sortInteractions(parseDrugInteractions(content, medications)),
  };
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

/**
 * Ask the model, through the server's `$ai` operation.
 *
 * `$ai` has no structured-output parameter, so the JSON contract lives in the
 * system prompt and the validators in `shared/clinical-decision.ts` are what
 * actually enforce it.
 * @param props - The call inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.model - The model name.
 * @param props.system - The system prompt.
 * @param props.user - The context block.
 * @returns The model's raw text.
 */
async function askModel(props: {
  medplum: MedplumClient;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const parameters: Parameters = {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'messages',
        valueString: JSON.stringify([
          { role: 'system', content: props.system },
          { role: 'user', content: props.user },
        ]),
      },
      { name: 'model', valueString: props.model },
      { name: 'temperature', valueDecimal: CLINICAL_TEMPERATURE },
    ],
  };

  const response = await props.medplum.post<Parameters>(props.medplum.fhirUrl('$ai'), parameters);
  const content = response.parameter?.find((p) => p.name === 'content')?.valueString;
  if (!content) {
    throw new Error('The $ai operation returned no content');
  }
  return content;
}
