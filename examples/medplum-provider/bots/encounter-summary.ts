// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Generate an encounter's pre-visit or post-visit AI summary and store it as a
 * `Composition`.
 *
 * Ported from lyfe-provider-ui's `lib/services/encounter-summary-service.ts`. The
 * interesting parts — the two prompts, the two validators, the Composition shape
 * — live in `shared/encounter-summary.ts` and `shared/encounter-summary-prompt.ts`
 * and are tested there. What is left here is the part that needs a server: read
 * the encounter and the chart, call `$ai`, upsert the result.
 *
 * WHAT WAS DELETED ON THE WAY OVER
 * --------------------------------
 * Prod's `fetchEncounterContext` was Medplum-first with a Prisma fallback per
 * record kind, and `buildSyntheticAppointmentFromMedplum` existed to bridge a
 * FHIR Encounter back to a Prisma Appointment row by `mrn` or Zus UPID so the
 * prompt builders could keep taking a Prisma shape. None of that exists here:
 * the encounter *is* the record, so the service's ~170 lines of dual sourcing and
 * synthetic-appointment construction are a straight deletion, along with the
 * `_isSynthetic` flag and the "skip persistence for synthetic appointments"
 * branches that flowed from it.
 *
 * Prod's org gate (`ctx.patient.organizationId !== organizationId`) is also gone,
 * replaced by the server's own compartment: a bot-scoped client reading an
 * Encounter it has no access to gets nothing, and the write carries
 * `meta.account` from the caller's own ProjectMembership via
 * `resolveCallerOrganization`, never from anything the caller passes.
 *
 * NO `Promise.all` AROUND SEARCHES
 * --------------------------------
 * Concurrent Medplum searches auto-batch and the batch flush uses `setTimeout`,
 * which the `vmcontext` sandbox does not have — the bot hangs forever with no
 * error. Every search below is awaited one at a time on purpose. The service this
 * was ported from used `Promise.all` for exactly this fetch; that is the one
 * thing from it that must not come across.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  AllergyIntolerance,
  ClinicalImpression,
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
} from '@medplum/fhirtypes';
import { AI_SUMMARY_SECTION_SYSTEM, summarySearchQuery } from './shared/ai-summary.ts';
import type { EncounterSummaryContext, SummaryKind } from './shared/encounter-summary-prompt.ts';
import {
  buildCitationIndex,
  buildPostVisitPrompt,
  buildPreVisitPrompt,
  CHART_WINDOW_DAYS,
  CITATION_LIMITS,
  observationDate,
  POST_VISIT_SYSTEM_PROMPT,
  PRE_VISIT_SYSTEM_PROMPT,
} from './shared/encounter-summary-prompt.ts';
import type { PostVisitDraft, PreVisitDraft } from './shared/encounter-summary.ts';
import {
  AI_SUMMARY_DEVICE_IDENTIFIER_SYSTEM,
  buildEncounterSummaryComposition,
  ENCOUNTER_SUMMARY_SECTION_SYSTEM,
  encounterSummarySearchQuery,
  parsePostVisitDraft,
  parsePreVisitDraft,
  sectionText,
} from './shared/encounter-summary.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';

/**
 * The model, which `$ai` forwards to whatever `LLM_BASE_URL` points at.
 *
 * lyfe-provider-ui resolved every text call — including both of these summaries —
 * to this same Bedrock cross-region inference profile (`lib/config/ai-config.ts`),
 * under AWS's BAA. Its `AI_MODELS.GPT4` was a misleading alias to this exact
 * constant, not to GPT-4.
 */
export const DEFAULT_SUMMARY_MODEL = 'global.anthropic.claude-sonnet-4-6';

/** Matches lyfe-provider-ui's summarization temperature. */
const SUMMARY_TEMPERATURE = 0.3;

/** Identifier value and display of the Device credited as the summary's author. */
const AI_SUMMARY_DEVICE_VALUE = 'lyfe-clinical-ai';
const AI_SUMMARY_DEVICE_NAME = 'Lyfe Clinical AI';

/** How many chart notes are read to cover this encounter plus the prior ones. */
const CHART_NOTE_COUNT = 10;

const DAY_MS = 86_400_000;

export interface EncounterSummaryInput {
  encounterId?: string;
  /** Defaults to post-visit for a finished encounter, pre-visit otherwise. */
  kind?: SummaryKind;
  /** Overrides {@link DEFAULT_SUMMARY_MODEL}. */
  model?: string;
}

export interface EncounterSummaryResult {
  ok: boolean;
  kind?: SummaryKind;
  compositionId?: string;
  status?: Composition['status'];
  error?: string;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - `{ encounterId, kind?, model? }`.
 * @returns What was written, or the reason nothing was.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<EncounterSummaryInput>
): Promise<EncounterSummaryResult> {
  // Errors are returned, not thrown, for the same reason as the other Lyfe bots:
  // a throw reaches the caller as a bare 500 and hides the message, and almost
  // every failure here is configuration ("project does not have the ai feature")
  // rather than a server fault.
  try {
    return await run(medplum, event);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Which summary an encounter gets when the caller did not say.
 *
 * Prod decided by comparing the appointment date to today. `status` is the better
 * signal here and the same one `EncounterHeader` already shows: a finished visit
 * gets the progress-note summary, anything still planned or in progress gets the
 * briefing.
 * @param encounter - The encounter.
 * @returns The default kind.
 */
export function defaultKind(encounter: Encounter): SummaryKind {
  return encounter.status === 'finished' ? 'post-visit' : 'pre-visit';
}

async function run(medplum: MedplumClient, event: BotEvent<EncounterSummaryInput>): Promise<EncounterSummaryResult> {
  const encounterId = event.input?.encounterId;
  if (!encounterId) {
    throw new Error('No encounter on this execution: pass { encounterId }');
  }

  const organization = await resolveCallerOrganization({ medplum, requester: event.requester });
  const encounter = await medplum.readResource('Encounter', encounterId);
  const kind = event.input?.kind ?? defaultKind(encounter);

  const patientReference = encounter.subject?.reference;
  if (!patientReference?.startsWith('Patient/')) {
    throw new Error(`Encounter/${encounterId} has no patient subject`);
  }
  const patient = await medplum.readResource('Patient', patientReference.slice('Patient/'.length));

  const context = await readContext(medplum, encounter, patient, kind);
  const citations = buildCitationIndex(context, kind);
  const now = new Date();

  const content = await askModel({
    medplum,
    system: kind === 'pre-visit' ? PRE_VISIT_SYSTEM_PROMPT : POST_VISIT_SYSTEM_PROMPT,
    prompt: kind === 'pre-visit' ? buildPreVisitPrompt(context, now) : buildPostVisitPrompt(context, now),
    model: event.input?.model ?? DEFAULT_SUMMARY_MODEL,
  });
  const draft: PreVisitDraft | PostVisitDraft =
    kind === 'pre-visit' ? parsePreVisitDraft(content) : parsePostVisitDraft(content);

  const author = await resolveAuthorDevice(medplum, organization);
  const composition = buildEncounterSummaryComposition({
    kind,
    encounter: { reference: `Encounter/${encounterId}` },
    patient: { reference: patientReference },
    author,
    draft,
    citations,
    generatedAt: now.toISOString(),
    account: organization,
  });

  // A conditional update on the identifier, so regenerating replaces the summary
  // instead of adding a second one to the encounter. The body deliberately
  // carries no id — `PUT /Composition?identifier=…` is how FHIR expresses
  // "replace the one that matches, or create it".
  const saved = await medplum.upsertResource(composition, encounterSummarySearchQuery(kind, encounterId));
  return { ok: true, kind, compositionId: saved.id, status: saved.status };
}

/**
 * Read everything the two summaries read, one search at a time.
 *
 * Mirrors lyfe-provider-ui's filters: active and recurring problems, active
 * medications, active allergies, labs and vitals in a 90-day window, the three
 * visits before this one, and the chart notes for all of them.
 *
 * One deliberate change: the window is anchored to the **encounter's** date, not
 * to today. Prod computed `ninetyDaysAgo` from `new Date()` while filtering
 * same-day vitals against the appointment date, so writing a post-visit summary
 * for a visit more than 90 days ago read none of that visit's own measurements.
 * @param medplum - Bot-scoped Medplum client.
 * @param encounter - The encounter being summarised.
 * @param patient - Its patient.
 * @param kind - Which summary is being written, which decides the two extra reads.
 * @returns The chart, in the order the prompts list it.
 */
async function readContext(
  medplum: MedplumClient,
  encounter: Encounter,
  patient: Patient,
  kind: SummaryKind
): Promise<EncounterSummaryContext> {
  const subject = `Patient/${patient.id}`;
  const anchor = encounter.period?.start ?? encounter.period?.end ?? new Date().toISOString();
  const anchorDay = anchor.slice(0, 10);
  const windowStart = new Date(new Date(anchor).getTime() - CHART_WINDOW_DAYS * DAY_MS).toISOString();

  const conditions = (await medplum.searchResources('Condition', {
    subject,
    'clinical-status': 'active,recurrence,relapse',
    _count: String(CITATION_LIMITS.conditions),
  })) as Condition[];

  const medications = (await medplum.searchResources('MedicationRequest', {
    subject,
    status: 'active',
    _count: String(CITATION_LIMITS.medications),
  })) as MedicationRequest[];

  const allergies = (await medplum.searchResources('AllergyIntolerance', {
    patient: subject,
    'clinical-status': 'active',
    _count: String(CITATION_LIMITS.allergies),
  })) as AllergyIntolerance[];

  const recentVitals = (await medplum.searchResources('Observation', {
    subject,
    category: 'vital-signs',
    date: `ge${windowStart}`,
    _sort: '-date',
    _count: '30',
  })) as Observation[];

  const recentLabs = (await medplum.searchResources('Observation', {
    subject,
    category: 'laboratory',
    date: `ge${windowStart}`,
    _sort: '-date',
    _count: '40',
  })) as Observation[];

  const priorEncounters = (
    (await medplum.searchResources('Encounter', {
      subject,
      date: `lt${anchor}`,
      _sort: '-date',
      _count: String(CITATION_LIMITS.encounters + 1),
    })) as Encounter[]
  )
    // `date=lt<start>` can still return this encounter when its period has no
    // start and the server falls back to another date element.
    .filter((candidate) => candidate.id !== encounter.id)
    .slice(0, CITATION_LIMITS.encounters);

  // One search for every chart note in play rather than one per encounter. The
  // note is `ClinicalImpression.note[0].text`, which is the field
  // `EncounterChart`'s Textarea writes; `summary` and `description` are the
  // fallbacks an imported impression may carry instead.
  const impressions = (await medplum.searchResources('ClinicalImpression', {
    patient: subject,
    _sort: '-date',
    _count: String(CHART_NOTE_COUNT),
  })) as ClinicalImpression[];

  const notesByEncounter: Record<string, string> = {};
  for (const impression of impressions) {
    const reference = impression.encounter?.reference;
    const text = impression.note?.[0]?.text ?? impression.summary ?? impression.description;
    if (reference && text && !notesByEncounter[reference]) {
      notesByEncounter[reference] = text;
    }
  }

  // The pre-visit briefing carries the patient's longitudinal AI summary as
  // context, the way prod spliced in `patient.aiSummary.narrative`. The
  // post-visit note carries this encounter's own stored briefing instead, for the
  // planned-versus-actual line its prompt asks for. Neither existing is normal.
  let longitudinalContext: string | undefined;
  let preVisitPlan: string | undefined;
  if (kind === 'pre-visit') {
    const patientSummary = await medplum.searchOne('Composition', summarySearchQuery(patient.id as string));
    longitudinalContext = patientSummary
      ? sectionText(patientSummary, AI_SUMMARY_SECTION_SYSTEM, 'narrative')
      : undefined;
  } else {
    const stored = await medplum.searchOne('Composition', encounterSummarySearchQuery('pre-visit', encounter.id ?? ''));
    preVisitPlan = stored ? sectionText(stored, ENCOUNTER_SUMMARY_SECTION_SYSTEM, 'reason-for-visit') : undefined;
  }

  const onAnchorDay = (observation: Observation): boolean => observationDate(observation)?.slice(0, 10) === anchorDay;

  return {
    encounter,
    patient,
    conditions,
    medications,
    allergies,
    recentVitals,
    recentLabs,
    sameDayVitals: recentVitals.filter(onAnchorDay),
    sameDayLabs: recentLabs.filter(onAnchorDay),
    priorEncounters,
    notesByEncounter,
    longitudinalContext,
    preVisitPlan,
  };
}

/**
 * Ask the model, through the server's `$ai` operation.
 *
 * `$ai` is the only server-side LLM path and it owns the credentials: the project
 * must carry the `ai` feature and an `OPENAI_API_KEY` secret, with an optional
 * `LLM_BASE_URL` to point somewhere other than OpenAI. Nothing here holds a key
 * or a base URL, which is the point of using it rather than porting
 * lyfe-provider-ui's gateway.
 *
 * `$ai` has no structured-output parameter, so unlike prod's `generateObject`
 * there is no schema the provider enforces. The JSON contract lives in the system
 * prompt and `parsePreVisitDraft` / `parsePostVisitDraft` are what actually hold
 * it.
 * @param props - The call inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.system - The system prompt.
 * @param props.prompt - The chart context block.
 * @param props.model - The model name.
 * @returns The model's raw text.
 */
async function askModel(props: {
  medplum: MedplumClient;
  system: string;
  prompt: string;
  model: string;
}): Promise<string> {
  const parameters: Parameters = {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'messages',
        valueString: JSON.stringify([
          { role: 'system', content: props.system },
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
  return content;
}

/**
 * Resolve the Device credited as `Composition.author`.
 *
 * The same Device the patient AI summary uses, upserted on the same identifier:
 * `Composition.author` cannot be a Bot, and crediting the provider who clicked
 * generate would put a clinician's name on text they did not write.
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
