// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Generate the AI patient summary and store it as a `Composition`.
 *
 * Ported from lyfe-provider-ui's `lib/services/ai-summary-service.ts`. The
 * interesting parts — the prompt, the citation mapping, the Composition shape —
 * live in `shared/ai-summary.ts` and `shared/ai-summary-prompt.ts` and are
 * tested there. What is left here is the part that needs a server: read the
 * chart, call `$ai`, upsert the result.
 *
 * TWO MODES
 * ---------
 * `generate` (the default) reads the chart, calls the model and writes a `final`
 * Composition. `invalidate` flips the existing one to `preliminary` and touches
 * nothing else — no model call, no read of the chart.
 *
 * The split exists because of what a `Subscription` does to cost. A DrChrono
 * chart import writes thousands of Conditions, MedicationRequests and
 * Observations for one patient. A subscription that *regenerated* on each of
 * those would make thousands of model calls for a single import, serially, and
 * the import would finish hours before the summaries did. So a subscription
 * marks the summary stale and the provider's refresh (or an explicit call) is
 * what spends a model call. `Composition.status` is exactly the right field for
 * that, which is why the design puts staleness there.
 *
 * WIRING THE SUBSCRIPTION
 * -----------------------
 * Not created by this repo yet — no server here owns Subscription resources, and
 * `scripts/setup-tenancy.ts` deliberately only defines access policies. The bot
 * already accepts a subscription delivery, so turning it on is three resources
 * and no code change. For each of `Condition`, `MedicationRequest` and
 * `AllergyIntolerance`:
 *
 *   {
 *     "resourceType": "Subscription",
 *     "status": "active",
 *     "reason": "Mark the AI patient summary stale when the chart changes",
 *     "criteria": "Condition",
 *     "channel": { "type": "rest-hook", "endpoint": "Bot/<bot id>" }
 *   }
 *
 * Medplum delivers the changed resource as `event.input`; `resolvePatientId`
 * below pulls the patient off its `subject`/`patient` and the run invalidates.
 *
 * NO `Promise.all` AROUND SEARCHES
 * -------------------------------
 * Concurrent Medplum searches auto-batch and the batch flush uses `setTimeout`,
 * which the `vmcontext` sandbox does not have — the bot hangs forever with no
 * error. Every search below is awaited one at a time on purpose. The service
 * this was ported from used `Promise.all` for exactly this fetch; that is the
 * one thing from it that must not come across.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  AllergyIntolerance,
  Appointment,
  Composition,
  Condition,
  Device,
  Encounter,
  MedicationRequest,
  Observation,
  Organization,
  Parameters,
  Patient,
  Reference,
  Resource,
} from '@medplum/fhirtypes';
import type { PatientChart } from './shared/ai-summary-prompt.ts';
import {
  buildChartPrompt,
  buildCitationIndex,
  CITATION_LIMITS,
  SUMMARY_SYSTEM_PROMPT,
} from './shared/ai-summary-prompt.ts';
import type { SummaryDraft } from './shared/ai-summary.ts';
import {
  AI_SUMMARY_DEVICE_IDENTIFIER_SYSTEM,
  buildSummaryComposition,
  parseSummaryDraft,
  summarySearchQuery,
} from './shared/ai-summary.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';

/**
 * The model, which `$ai` forwards to whatever `LLM_BASE_URL` points at.
 *
 * lyfe-provider-ui resolved every text call to this same Bedrock cross-region
 * inference profile (`lib/config/ai-config.ts`), under AWS's BAA. Note that its
 * `AI_MODELS.GPT4` was a misleading alias to this exact constant, not to GPT-4 —
 * nothing in that app has called an OpenAI text model for some time.
 *
 * `$ai` speaks the OpenAI wire format, so reaching Bedrock means a LiteLLM proxy
 * in front of it, named by the `LLM_BASE_URL` project secret. Override per call
 * with the `model` input when the project is pointed somewhere else.
 */
export const DEFAULT_SUMMARY_MODEL = 'global.anthropic.claude-sonnet-4-6';

/** Matches lyfe-provider-ui's summarization temperature. */
const SUMMARY_TEMPERATURE = 0.3;

/** Identifier value and display of the Device credited as the summary's author. */
const AI_SUMMARY_DEVICE_VALUE = 'lyfe-clinical-ai';
const AI_SUMMARY_DEVICE_NAME = 'Lyfe Clinical AI';

export interface SummaryInput {
  patientId?: string;
  /** Defaults to `generate`. */
  mode?: 'generate' | 'invalidate';
  /** Overrides {@link DEFAULT_SUMMARY_MODEL}. */
  model?: string;
}

export interface SummaryResult {
  ok: boolean;
  mode?: 'generate' | 'invalidate';
  compositionId?: string;
  status?: Composition['status'];
  error?: string;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - Either `{ patientId, mode?, model? }`, or a subscription-delivered resource.
 * @returns What was written, or the reason nothing was.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<SummaryInput | Resource>
): Promise<SummaryResult> {
  // Errors are returned, not thrown, for the same reason as the other Lyfe bots:
  // a throw reaches the caller as a bare 500 and hides the message, and almost
  // every failure here is configuration ("project does not have the ai feature",
  // "OpenAI API key not configured") rather than a server fault.
  try {
    return await run(medplum, event);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Work out which patient an execution is about.
 *
 * Accepts the explicit `{ patientId }` form and the subscription form, where the
 * input is the resource that changed. A Patient is its own subject; everything
 * else points at one through `subject` or `patient`.
 * @param input - The bot input.
 * @returns The patient id, or undefined when the input names no patient.
 */
export function resolvePatientId(input: SummaryInput | Resource | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  if (!('resourceType' in input)) {
    return input.patientId;
  }
  if (input.resourceType === 'Patient') {
    return input.id;
  }
  const candidate = input as { subject?: Reference; patient?: Reference };
  const reference = candidate.subject?.reference ?? candidate.patient?.reference;
  return reference?.startsWith('Patient/') ? reference.slice('Patient/'.length) : undefined;
}

/**
 * Whether an execution should invalidate rather than generate.
 *
 * A subscription delivery is always an invalidation: something in the chart
 * changed, so the stored summary no longer reflects it, but regenerating on
 * every write would cost a model call per imported Condition.
 * @param input - The bot input.
 * @returns True to mark the summary stale instead of rewriting it.
 */
export function isInvalidation(input: SummaryInput | Resource | undefined): boolean {
  if (!input) {
    return false;
  }
  if ('resourceType' in input) {
    return input.resourceType !== 'Parameters';
  }
  return input.mode === 'invalidate';
}

// The explicit-call options, or undefined when this execution came from a Subscription.
function asOptions(input: SummaryInput | Resource | undefined): SummaryInput | undefined {
  return input && !('resourceType' in input) ? input : undefined;
}

async function run(medplum: MedplumClient, event: BotEvent<SummaryInput | Resource>): Promise<SummaryResult> {
  const patientId = resolvePatientId(event.input);
  if (!patientId) {
    throw new Error('No patient on this execution: pass { patientId } or trigger from a patient-scoped resource');
  }

  if (isInvalidation(event.input)) {
    const existing = await medplum.searchOne('Composition', summarySearchQuery(patientId));
    if (!existing?.id) {
      // Nothing to invalidate. Not an error — most patients have never had a
      // summary generated, and a chart import touches all of them.
      return { ok: true, mode: 'invalidate' };
    }
    if (existing.status === 'preliminary') {
      return { ok: true, mode: 'invalidate', compositionId: existing.id, status: 'preliminary' };
    }
    const marked = await medplum.updateResource({ ...existing, status: 'preliminary' });
    return { ok: true, mode: 'invalidate', compositionId: marked.id, status: marked.status };
  }

  const organization = await resolveCallerOrganization({ medplum, requester: event.requester });
  const patient = await medplum.readResource('Patient', patientId);
  const chart = await readChart(medplum, patient);
  const citations = buildCitationIndex(chart);

  const draft = await generateDraft({
    medplum,
    prompt: buildChartPrompt(chart, new Date()),
    model: asOptions(event.input)?.model ?? DEFAULT_SUMMARY_MODEL,
  });

  const author = await resolveAuthorDevice(medplum, organization);
  const composition = buildSummaryComposition({
    patient: { reference: `Patient/${patientId}` },
    author,
    draft,
    citations,
    generatedAt: new Date().toISOString(),
    account: organization,
  });

  // A conditional update on the identifier, so a second generation replaces the
  // summary instead of adding a second one to the chart. The body deliberately
  // carries no id — `PUT /Composition?identifier=…` is how FHIR expresses
  // "replace the one that matches, or create it", and this is the same shape
  // `conditionalUpdateEntry` in shared/batch.ts uses for every imported resource.
  const saved = await medplum.upsertResource(composition, summarySearchQuery(patientId));
  return { ok: true, mode: 'generate', compositionId: saved.id, status: saved.status };
}

/**
 * Read everything the summary reads, one search at a time.
 *
 * Mirrors lyfe-provider-ui's filters: active and recurring problems, active
 * medications, active allergies, recent labs and vitals, the last five visits,
 * and anything scheduled ahead.
 * @param medplum - Bot-scoped Medplum client.
 * @param patient - The patient.
 * @returns The chart, in the order the prompt lists it.
 */
async function readChart(medplum: MedplumClient, patient: Patient): Promise<PatientChart> {
  const subject = `Patient/${patient.id}`;

  const conditions = (await medplum.searchResources('Condition', {
    subject,
    'clinical-status': 'active,recurrence,relapse',
    _count: String(CITATION_LIMITS.conditions),
  })) as Condition[];

  const medications = (await medplum.searchResources('MedicationRequest', {
    subject,
    status: 'active',
    _count: '30',
  })) as MedicationRequest[];

  const allergies = (await medplum.searchResources('AllergyIntolerance', {
    patient: subject,
    'clinical-status': 'active',
    _count: String(CITATION_LIMITS.allergies),
  })) as AllergyIntolerance[];

  const labs = (await medplum.searchResources('Observation', {
    subject,
    category: 'laboratory',
    _sort: '-date',
    _count: '15',
  })) as Observation[];

  const vitals = (await medplum.searchResources('Observation', {
    subject,
    category: 'vital-signs',
    _sort: '-date',
    _count: String(CITATION_LIMITS.vitals),
  })) as Observation[];

  const encounters = (await medplum.searchResources('Encounter', {
    subject,
    _sort: '-date',
    _count: String(CITATION_LIMITS.encounters),
  })) as Encounter[];

  const appointments = (await medplum.searchResources('Appointment', {
    patient: subject,
    date: `ge${new Date().toISOString()}`,
    _sort: 'date',
    _count: '3',
  })) as Appointment[];

  return {
    patient,
    conditions,
    medications,
    allergies,
    labs,
    vitals,
    encounters,
    appointments,
    // See the DOCUMENT CONTEXT SEAM in shared/ai-summary-prompt.ts. There is no
    // document-extraction pipeline in this repo yet, so there is nothing to
    // excerpt; the prompt renders "None extracted yet" and the model is told to
    // ignore the block.
    documents: [],
  };
}

/**
 * Ask the model, through the server's `$ai` operation.
 *
 * `$ai` is the only server-side LLM path and it owns the credentials: the
 * project must carry the `ai` feature and an `OPENAI_API_KEY` secret, with an
 * optional `LLM_BASE_URL` to point somewhere other than OpenAI. Nothing here
 * holds a key or a base URL, which is the point of using it rather than porting
 * lyfe-provider-ui's gateway.
 * @param props - The call inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.prompt - The chart context block.
 * @param props.model - The model name.
 * @returns The validated draft.
 */
async function generateDraft(props: { medplum: MedplumClient; prompt: string; model: string }): Promise<SummaryDraft> {
  const parameters: Parameters = {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'messages',
        valueString: JSON.stringify([
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: props.prompt },
        ]),
      },
      { name: 'model', valueString: props.model },
      { name: 'temperature', valueDecimal: SUMMARY_TEMPERATURE },
    ],
  };

  const response = await props.medplum.post<Parameters>(props.medplum.fhirUrl('$ai'), parameters);
  const content = response.parameter?.find((p) => p.name === 'content')?.valueString;
  if (!content) {
    throw new Error('The $ai operation returned no content');
  }
  return parseSummaryDraft(content);
}

/**
 * Resolve the Device credited as `Composition.author`.
 *
 * `Composition.author` is 1..* and its allowed targets are Practitioner,
 * PractitionerRole, Device, Patient, RelatedPerson and Organization — a Bot is
 * not among them, and crediting the provider who clicked refresh would put a
 * clinician's name on text they did not write. So: one Device per project,
 * upserted on its identifier, standing for the model.
 * @param medplum - Bot-scoped Medplum client.
 * @param owner - The clinic, as the Device's owner and compartment.
 * @returns A reference to the Device.
 */
async function resolveAuthorDevice(medplum: MedplumClient, owner: Reference<Organization>): Promise<Reference<Device>> {
  const query = `identifier=${encodeURIComponent(`${AI_SUMMARY_DEVICE_IDENTIFIER_SYSTEM}|${AI_SUMMARY_DEVICE_VALUE}`)}`;
  const device = await medplum.upsertResource<Device>(
    {
      resourceType: 'Device',
      meta: { account: owner, accounts: [owner] },
      identifier: [{ system: AI_SUMMARY_DEVICE_IDENTIFIER_SYSTEM, value: AI_SUMMARY_DEVICE_VALUE }],
      status: 'active',
      deviceName: [{ name: AI_SUMMARY_DEVICE_NAME, type: 'manufacturer-name' }],
      type: {
        coding: [{ system: 'http://snomed.info/sct', code: '706689003', display: 'Application program software' }],
        text: 'Clinical summarization software',
      },
      owner,
    },
    query
  );
  return { reference: `Device/${device.id}`, display: AI_SUMMARY_DEVICE_NAME };
}
