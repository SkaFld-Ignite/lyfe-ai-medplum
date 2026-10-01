// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Draft an encounter's SOAP note, and push the approved note back to DrChrono.
 *
 * Ported from lyfe-provider-ui's `lib/services/soap-note-service.ts` and
 * `app/actions/ai/soap-note-actions.ts`. The interesting parts — the schema, the
 * DrChrono rendering, the Composition shape, the write decision — live in
 * `shared/soap-note.ts` and `shared/soap-note-prompt.ts` and are tested there.
 * What is left here is the part that needs a server: read the chart, call `$ai`,
 * upsert the Composition, and talk to DrChrono with the clinic's credentials.
 *
 * TWO ACTIONS
 * -----------
 * `generate` (the default) reads the encounter, calls the model and upserts a
 * `preliminary` Composition. `push` reads the stored Composition, refuses unless
 * it is `final`, and writes it to the clinic's DrChrono as a clinical note.
 *
 * The three states in between — approve, revert, edit — are not here. They are
 * `Composition.status` and `section[].text` changes with no secret and no
 * external call behind them, so the app writes them with `updateResource`
 * directly. A bot that only forwarded them would be an extra hop that could
 * fail, over a resource the server already guards.
 *
 * WHY THE PUSH IS A BOT AND NOT A FETCH FROM THE APP
 * -------------------------------------------------
 * The DrChrono token must never reach client JS, DrChrono sends no CORS headers
 * for a browser origin, and the credentials are per clinic and encrypted with a
 * project secret. Same reasoning as `drchrono-search.ts`.
 *
 * NO `Promise.all` AROUND SEARCHES
 * -------------------------------
 * Concurrent Medplum searches auto-batch and the batch flush uses `setTimeout`,
 * which the `vmcontext` sandbox does not have — the bot hangs forever with no
 * error. Every search below is awaited one at a time on purpose.
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
  Provenance,
  Reference,
} from '@medplum/fhirtypes';
import { deriveEncryptionKey, ENCRYPTION_KEY_SECRET_NAME } from './shared/credentials.ts';
import type { DrChronoClient } from './shared/drchrono.ts';
import { createDrChronoClient } from './shared/drchrono.ts';
import type { EncounterChart } from './shared/soap-note-prompt.ts';
import { buildEncounterPrompt, CHART_LIMITS, SOAP_SYSTEM_PROMPT } from './shared/soap-note-prompt.ts';
import type { DrChronoClinicalNote, DrChronoClinicalNoteFields, ProvenanceAgent } from './shared/soap-note.ts';
import {
  buildPushProvenance,
  buildSoapComposition,
  compositionToDrChronoFields,
  decideClinicalNoteWrite,
  drChronoAppointmentId,
  drChronoNoteIdsFrom,
  matchAssessmentConditions,
  parseSoapDraft,
  renderSoapNarratives,
  SOAP_NOTE_DEVICE_IDENTIFIER_SYSTEM,
  soapNoteSearchQuery,
} from './shared/soap-note.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';

/**
 * The model, which `$ai` forwards to whatever `LLM_BASE_URL` points at.
 *
 * lyfe-provider-ui resolved every text call to this same Bedrock cross-region
 * inference profile (`lib/config/ai-config.ts`), under AWS's BAA — including the
 * SOAP generator, whose `AI_MODELS.GPT4` was a misleading alias to this exact
 * constant and not to GPT-4.
 */
export const DEFAULT_SOAP_MODEL = 'global.anthropic.claude-sonnet-4-6';

/** Matches lyfe-provider-ui's `AI_TEMPERATURES.SUMMARIZATION`, which the SOAP call used. */
const SOAP_TEMPERATURE = 0.3;

/** Identifier value and display of the Device credited as the note's author. */
const SOAP_DEVICE_VALUE = 'lyfe-clinical-ai';
const SOAP_DEVICE_NAME = 'Lyfe Clinical AI';

export interface SoapNoteInput {
  encounterId?: string;
  /** Defaults to `generate`. */
  action?: 'generate' | 'push';
  /** Overrides {@link DEFAULT_SOAP_MODEL}. */
  model?: string;
}

export interface SoapNoteResult {
  ok: boolean;
  action?: 'generate' | 'push';
  compositionId?: string;
  status?: Composition['status'];
  /** The DrChrono clinical-note row id, on a successful push. */
  clinicalNoteId?: string;
  error?: string;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - `{ encounterId, action?, model? }`, plus project secrets.
 * @returns What was written, or the reason nothing was.
 */
export async function handler(medplum: MedplumClient, event: BotEvent<SoapNoteInput>): Promise<SoapNoteResult> {
  // Errors are returned, not thrown, for the same reason as the other Lyfe bots:
  // a throw reaches the caller as a bare 500 and hides the message, and almost
  // every failure here is either configuration ("project does not have the ai
  // feature", "DrChrono is not configured") or a deliberate refusal the provider
  // needs to read.
  try {
    return await run(medplum, event);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function run(medplum: MedplumClient, event: BotEvent<SoapNoteInput>): Promise<SoapNoteResult> {
  const encounterId = event.input?.encounterId;
  if (!encounterId) {
    throw new Error('No encounter on this execution: pass { encounterId }');
  }

  // Derived from the caller's own membership, never from an argument — the IDOR
  // class lyfe-provider-ui had to fix. See shared/tenant.ts.
  const organization = await resolveCallerOrganization({ medplum, requester: event.requester });
  const encounter = await medplum.readResource('Encounter', encounterId);

  if (event.input?.action === 'push') {
    return pushToDrChrono({ medplum, event, encounter, organization });
  }
  return generate({ medplum, event, encounter, organization });
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

async function generate(props: {
  medplum: MedplumClient;
  event: BotEvent<SoapNoteInput>;
  encounter: Encounter;
  organization: Reference<Organization>;
}): Promise<SoapNoteResult> {
  const { medplum, encounter, organization } = props;
  const encounterId = encounter.id as string;

  const patientReference = encounter.subject?.reference;
  if (!patientReference?.startsWith('Patient/')) {
    throw new Error('This encounter has no patient subject');
  }
  const patient = await medplum.readResource('Patient', patientReference.slice('Patient/'.length));

  const chart = await readChart(medplum, patient, encounter);
  const prompt = buildEncounterPrompt(chart);
  if (!prompt) {
    // Prod's wording. The provider can act on it: document something on the
    // visit, then regenerate.
    throw new Error('Insufficient clinical data to generate SOAP note');
  }

  const draft = parseSoapDraft(
    await askModel({
      medplum,
      prompt,
      model: props.event.input?.model ?? DEFAULT_SOAP_MODEL,
    })
  );

  const author = await resolveAuthorDevice(medplum, organization);
  const composition = buildSoapComposition({
    encounter: { reference: `Encounter/${encounterId}` },
    patient: { reference: patientReference },
    author,
    narratives: renderSoapNarratives(draft),
    // The visit's own diagnoses first: when the same ICD code appears on both an
    // encounter diagnosis and a standing problem, the encounter's is the one this
    // note is about.
    assessmentEntries: matchAssessmentConditions(draft, [...chart.encounterConditions, ...chart.conditions]),
    generatedAt: new Date().toISOString(),
    account: organization,
  });

  // A conditional update on the identifier, so regenerating replaces the note
  // instead of adding a second one to the chart. The body deliberately carries no
  // id — `PUT /Composition?identifier=…` is how FHIR expresses "replace the one
  // that matches, or create it". Regenerating therefore also drops the note back
  // to `preliminary`, which is what prod did when it reset `soapStatus` to DRAFT.
  const saved = await medplum.upsertResource(composition, soapNoteSearchQuery(encounterId));
  return { ok: true, action: 'generate', compositionId: saved.id, status: saved.status };
}

/**
 * Read everything the generator reads, one search at a time.
 * @param medplum - Bot-scoped Medplum client.
 * @param patient - The patient.
 * @param encounter - The encounter being documented.
 * @returns The chart, in the order the prompt lists it.
 */
async function readChart(medplum: MedplumClient, patient: Patient, encounter: Encounter): Promise<EncounterChart> {
  const subject = `Patient/${patient.id}`;
  const encounterReference = `Encounter/${encounter.id}`;

  const impressions = (await medplum.searchResources('ClinicalImpression', {
    encounter: encounterReference,
    _sort: '-_lastUpdated',
    _count: String(CHART_LIMITS.impressions),
  })) as ClinicalImpression[];

  const encounterConditions = (await medplum.searchResources('Condition', {
    encounter: encounterReference,
    _count: String(CHART_LIMITS.encounterConditions),
  })) as Condition[];

  const vitals = (await medplum.searchResources('Observation', {
    encounter: encounterReference,
    category: 'vital-signs',
    _sort: '-date',
    _count: String(CHART_LIMITS.vitals),
  })) as Observation[];

  // Labs are read for the patient rather than the encounter: a result ordered at
  // the visit is usually resulted days later and carries no encounter link, so
  // an encounter-scoped search returns nothing exactly when it matters.
  const labs = (await medplum.searchResources('Observation', {
    subject,
    category: 'laboratory',
    _sort: '-date',
    _count: String(CHART_LIMITS.labs),
  })) as Observation[];

  const conditions = (await medplum.searchResources('Condition', {
    subject,
    'clinical-status': 'active,recurrence,relapse',
    _count: String(CHART_LIMITS.conditions),
  })) as Condition[];

  const medications = (await medplum.searchResources('MedicationRequest', {
    subject,
    status: 'active',
    _count: String(CHART_LIMITS.medications),
  })) as MedicationRequest[];

  const allergies = (await medplum.searchResources('AllergyIntolerance', {
    patient: subject,
    'clinical-status': 'active',
    _count: String(CHART_LIMITS.allergies),
  })) as AllergyIntolerance[];

  return {
    patient,
    encounter,
    impressions,
    encounterConditions,
    vitals,
    labs,
    conditions,
    medications,
    allergies,
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
 *
 * `$ai` has no structured-output parameter, so unlike prod's `generateObject`
 * there is no schema on the wire. The contract is in {@link SOAP_SYSTEM_PROMPT}
 * and `parseSoapDraft` is what enforces it.
 * @param props - The call inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.prompt - The encounter context block.
 * @param props.model - The model name.
 * @returns The model's raw text.
 */
async function askModel(props: { medplum: MedplumClient; prompt: string; model: string }): Promise<string> {
  const parameters: Parameters = {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'messages',
        valueString: JSON.stringify([
          { role: 'system', content: SOAP_SYSTEM_PROMPT },
          { role: 'user', content: props.prompt },
        ]),
      },
      { name: 'model', valueString: props.model },
      { name: 'temperature', valueDecimal: SOAP_TEMPERATURE },
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
 * `Composition.author` is 1..* and its allowed targets are Practitioner,
 * PractitionerRole, Device, Patient, RelatedPerson and Organization — a Bot is
 * not among them, and crediting the provider who clicked generate would put a
 * clinician's name on text they did not write. So: one Device per project,
 * upserted on its identifier, standing for the model. The same Device the AI
 * summary uses, under this feature's own identifier system.
 * @param medplum - Bot-scoped Medplum client.
 * @param owner - The clinic, as the Device's owner and compartment.
 * @returns A reference to the Device.
 */
async function resolveAuthorDevice(medplum: MedplumClient, owner: Reference<Organization>): Promise<Reference<Device>> {
  const query = `identifier=${encodeURIComponent(`${SOAP_NOTE_DEVICE_IDENTIFIER_SYSTEM}|${SOAP_DEVICE_VALUE}`)}`;
  const device = await medplum.upsertResource<Device>(
    {
      resourceType: 'Device',
      meta: { account: owner, accounts: [owner] },
      identifier: [{ system: SOAP_NOTE_DEVICE_IDENTIFIER_SYSTEM, value: SOAP_DEVICE_VALUE }],
      status: 'active',
      deviceName: [{ name: SOAP_DEVICE_NAME, type: 'manufacturer-name' }],
      type: {
        coding: [{ system: 'http://snomed.info/sct', code: '706689003', display: 'Application program software' }],
        text: 'Clinical documentation software',
      },
      owner,
    },
    query
  );
  return { reference: `Device/${device.id}`, display: SOAP_DEVICE_NAME };
}

// ---------------------------------------------------------------------------
// Push to DrChrono
// ---------------------------------------------------------------------------

async function pushToDrChrono(props: {
  medplum: MedplumClient;
  event: BotEvent<SoapNoteInput>;
  encounter: Encounter;
  organization: Reference<Organization>;
}): Promise<SoapNoteResult> {
  const { medplum, encounter, organization } = props;
  const encounterId = encounter.id as string;

  const composition = await medplum.searchOne('Composition', soapNoteSearchQuery(encounterId));
  if (!composition?.id) {
    throw new Error('No SOAP note to submit for this encounter');
  }
  // Prod's gate, kept: the provider has to approve before anything reaches the
  // EHR. `final` is what the approve action sets.
  if (composition.status !== 'final') {
    throw new Error('The SOAP note must be approved before it can be submitted to DrChrono');
  }

  const fields = compositionToDrChronoFields(composition);
  if (!fields.chief_complaint.trim()) {
    throw new Error('The SOAP note has no chief complaint — refusing to submit an empty note');
  }

  const appointmentId = drChronoAppointmentId(encounter);
  if (!appointmentId) {
    throw new Error('This encounter did not come from DrChrono, so there is no appointment to attach a note to');
  }

  const material = props.event.secrets[ENCRYPTION_KEY_SECRET_NAME]?.valueString;
  if (!material) {
    throw new Error(`${ENCRYPTION_KEY_SECRET_NAME} is not set in project secrets`);
  }

  const client = await createDrChronoClient({
    medplum,
    organization,
    key: deriveEncryptionKey({ material }),
  });

  const existing = await readClinicalNotes(client, appointmentId);
  const provenances = (await medplum.searchResources(
    'Provenance',
    `target=Composition/${composition.id}`
  )) as Provenance[];

  const decision = decideClinicalNoteWrite({ existing, recordedNoteIds: drChronoNoteIdsFrom(provenances) });
  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const clinicalNoteId =
    decision.kind === 'update'
      ? await updateClinicalNote(client, decision.noteId, fields)
      : await createClinicalNote(client, appointmentId, fields);

  // Recorded AFTER the write, deliberately. A Provenance written first and then
  // orphaned by a failed push would be a standing licence to overwrite whatever
  // note later appeared under that id. The cost of this order is the opposite
  // failure: a write that succeeds and a Provenance that does not leaves the next
  // push unable to prove ownership, so it refuses and names the note id for a
  // human to reconcile. Refusing is the right side to fail on.
  await medplum.createResource(
    buildPushProvenance({
      composition: { reference: `Composition/${composition.id}` },
      clinicalNoteId,
      // The provider who clicked submit, which is the honest answer: they chose
      // to transmit the note even though a Device wrote the text. Falls back to
      // that Device when the execution has no requester — a bot-to-bot call —
      // and then to a bare display, because `Provenance.agent.who` is required
      // and a Bot is not an allowed target for it.
      agent: (props.event.requester as ProvenanceAgent | undefined) ??
        composition.author?.[0] ?? { display: SOAP_DEVICE_NAME },
      recorded: new Date().toISOString(),
      account: organization,
    })
  );

  return { ok: true, action: 'push', compositionId: composition.id, status: composition.status, clinicalNoteId };
}

/**
 * Read the clinical notes DrChrono holds for one appointment.
 * @param client - The clinic's DrChrono client.
 * @param appointmentId - The DrChrono appointment id.
 * @returns The notes, usually zero or one.
 */
async function readClinicalNotes(client: DrChronoClient, appointmentId: string): Promise<DrChronoClinicalNote[]> {
  const response = await client.fetch(`/clinical_notes?appointment=${encodeURIComponent(appointmentId)}`);
  if (!response.ok) {
    throw new Error(`DrChrono rejected the clinical-note lookup with ${response.status}`);
  }
  const body = (await response.json()) as { results?: DrChronoClinicalNote[] };
  return body.results ?? [];
}

async function createClinicalNote(
  client: DrChronoClient,
  appointmentId: string,
  fields: DrChronoClinicalNoteFields
): Promise<string> {
  const response = await client.fetch('/clinical_notes', {
    method: 'POST',
    body: { appointment: Number(appointmentId), ...fields },
  });
  if (!response.ok) {
    throw new Error(`DrChrono rejected the new clinical note with ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { id?: number };
  if (!body.id) {
    throw new Error('DrChrono accepted the clinical note but returned no id');
  }
  return String(body.id);
}

async function updateClinicalNote(
  client: DrChronoClient,
  noteId: number,
  fields: DrChronoClinicalNoteFields
): Promise<string> {
  const response = await client.fetch(`/clinical_notes/${noteId}`, { method: 'PATCH', body: fields });
  if (!response.ok) {
    throw new Error(`DrChrono rejected the clinical-note update with ${response.status}: ${await response.text()}`);
  }
  return String(noteId);
}
