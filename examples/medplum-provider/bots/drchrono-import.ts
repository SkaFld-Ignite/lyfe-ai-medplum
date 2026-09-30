// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Import one DrChrono patient's whole chart into Medplum as FHIR.
 *
 * This is a port of lyfe-provider-ui's `lib/medplum/drchrono-import-handler.ts`,
 * which has run against real practices for months. The mapping detail is the
 * value here — US Core extensions on Patient, OMB race/ethnicity codings, the
 * ICD-10/SNOMED dual coding on Condition, the HL7 v2 payload carried inline on a
 * lab DocumentReference — so it is carried over rather than simplified.
 *
 * What is deliberately *different* from the original:
 *
 * - **The clinic comes from the caller, never from the input.** The original
 *   took `organizationId` as an argument, which is an IDOR: pass another
 *   clinic's id and its chart gets written (or read) under your session.
 *   {@link resolveCallerOrganization} derives it from the caller's own
 *   ProjectMembership instead.
 * - **Credentials are per clinic.** The original took a bearer token as an
 *   argument. Here {@link createDrChronoClient} reads the calling clinic's
 *   stored pair and persists DrChrono's rotated refresh token.
 * - **Appointments are walked in 180-day `date_range` chunks.** The original
 *   used `since=`, which DrChrono accepts. `date_range` is the filter that also
 *   bounds the future, but DrChrono rejects a range over ~190 days unless the
 *   whole range is in the past — and "in the past" excludes a range ending today
 *   or yesterday. A single wide range therefore comes back **empty rather than
 *   erroring**, which is how it silently imported zero appointments before the
 *   chunking was found. Every chunk here is 180 days, so the limit is never hit.
 * - **Appointments are imported before the resources that reference them.** The
 *   original built `encounterByApptId` in step 6 but consumed it in step 4, so
 *   `MedicationRequest.encounter` and `Condition.encounter` were always empty.
 *   Ordering is fixed here.
 * - **Writes go through {@link upsertBatch}**, not one HTTP call per resource.
 *
 * Every resource written carries `meta.account` (and `meta.accounts`) pointing
 * at the calling Organization. Without it the resource lands outside the
 * compartment and is invisible to everyone under the clinic AccessPolicy —
 * a silent, total data loss from the clinic's point of view.
 *
 * Progress is tracked on a FHIR `Task` created before the first fetch and closed
 * out at the end, so a run that dies mid-import leaves evidence behind.
 *
 * Re-running is safe: every resource is keyed on a DrChrono identifier and
 * written with a conditional `PUT`, so a second import updates in place.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  AllergyIntolerance,
  Appointment,
  Attachment,
  AuditEvent,
  Communication,
  Condition,
  Coverage,
  DiagnosticReport,
  DocumentReference,
  Encounter,
  Extension,
  FamilyMemberHistory,
  Immunization,
  Location,
  MedicationRequest,
  Meta,
  Observation,
  Organization,
  Patient,
  Practitioner,
  Procedure,
  Provenance,
  Reference,
  Schedule,
  ServiceRequest,
  Slot,
  Task,
} from '@medplum/fhirtypes';
import { Buffer as NodeBuffer } from 'node:buffer';
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';
import type { BatchResult, UpsertEntry } from './shared/batch.ts';
import { sleep, upsertBatch, withMedplum429Retry } from './shared/batch.ts';
import { ENCRYPTION_KEY_SECRET_NAME, deriveEncryptionKey } from './shared/credentials.ts';
import { ZUS_ENROLMENT_EXTENSION, mergeEnabled, mergeZusEnabled, readDirectoryState } from './shared/directory.ts';
import type { DrChronoClient } from './shared/drchrono.ts';
import { createDrChronoClient } from './shared/drchrono.ts';
import { contentTypeFromName } from './shared/file-type.ts';
import { mapWithConcurrency, storeFile, storedBinaryReference } from './shared/files.ts';
import { ImportProgress, buildStatusReason, countsToOutput } from './shared/progress.ts';
import { DRCHRONO_SOURCE_TAG } from './shared/source.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';

/**
 * Put Node's timers and Buffer back on the global object.
 *
 * A Medplum `vmcontext` bot does not run in Node's global scope. Its sandbox is
 * built by hand in `packages/server/src/bots/vmcontext.ts` and contains exactly
 * `console`, `fetch`, `require`, `process`, `ContentType`, `Hl7Message`,
 * `MedplumClient`, `TextDecoder`, `TextEncoder`, `URL`, `URLSearchParams` and
 * `event`. There is **no `setTimeout`, no `clearTimeout` and no `Buffer`** —
 * this bot's first live run died on `clearTimeout is not defined` before it had
 * issued a single DrChrono request.
 *
 * Importing them by module works, because `require` *is* in the sandbox and
 * esbuild compiles a `node:` import to a `require` call. This bot's own code
 * uses the imported bindings directly. The assignment below is for
 * `shared/batch.ts`, whose `sleep()` closes over the global `setTimeout` and
 * would otherwise throw the moment a write is rate-limited or a bundle spans
 * more than one chunk — a failure that only shows up on the large charts, which
 * is the worst possible time to find it.
 *
 * This runs at module scope, so it is in place before `handler` is ever called.
 */
const sandboxGlobals = globalThis as unknown as Record<string, unknown>;
if (typeof sandboxGlobals.setTimeout !== 'function') {
  sandboxGlobals.setTimeout = nodeSetTimeout;
}
if (typeof sandboxGlobals.clearTimeout !== 'function') {
  sandboxGlobals.clearTimeout = nodeClearTimeout;
}
if (typeof sandboxGlobals.Buffer !== 'function') {
  sandboxGlobals.Buffer = NodeBuffer;
}

// ─── Input / output ──────────────────────────────────────────────────────────

/** Import one patient's chart. */
export interface ImportChartInput {
  /** Discriminator. */
  action: 'import';
  /** DrChrono's numeric patient id, as a string. */
  drchronoPatientId: string;
}

/**
 * Refresh the practice directory (providers and offices) without importing
 * any chart. This is what the Directory page's "Pull from DrChrono" calls.
 */
export interface SyncDirectoryInput {
  /** Discriminator. */
  action: 'syncDirectory';
}

/** Everything this bot accepts. */
export type ImportInput = ImportChartInput | SyncDirectoryInput;

/** Returned by the `syncDirectory` action. */
export interface DirectorySyncSuccess {
  ok: true;
  action: 'syncDirectory';
  /** Providers written, and how many of them are switched off. */
  practitioners: { wrote: number; disabled: number };
  /** Offices written, and how many of them are switched off. */
  locations: { wrote: number; disabled: number };
}

/** How many resources of each kind were written, per import run. */
export interface ImportCounts {
  /** Practice-wide providers written as Practitioner. */
  practitioners: number;
  /** Practice offices written as Location. */
  locations: number;
  /** Insurance rows written as Coverage. */
  coverages: number;
  /** Allergy rows written as AllergyIntolerance. */
  allergies: number;
  /** Medication rows written as MedicationRequest. */
  medications: number;
  /** Problem-list rows written as Condition. */
  conditions: number;
  /** Procedure rows written as Procedure. */
  procedures: number;
  /** Vaccine records written as Immunization. */
  immunizations: number;
  /** Family history rows written as FamilyMemberHistory. */
  familyHistories: number;
  /** Social history rows written as Observation. */
  socialHistoryObs: number;
  /** Lab orders written as ServiceRequest. */
  labOrders: number;
  /** Lab results written as DiagnosticReport. */
  labReports: number;
  /** Lab results written as Observation. */
  labObservations: number;
  /** Lab PDFs / HL7 messages written as DocumentReference. */
  labDocuments: number;
  /** Visits written as Encounter. */
  appointments: number;
  /** Scheduling slots written as Slot. */
  slots: number;
  /** Scheduling records written as Appointment. */
  appointmentResources: number;
  /** Chart documents written as DocumentReference. */
  documents: number;
  /** Vital signs written as Observation. */
  observations: number;
  /** Locked/unlocked visit notes written as DocumentReference. */
  clinicalNotes: number;
  /** Inbox messages written as Communication. */
  communications: number;
  /** DrChrono tasks written as Task. */
  tasks: number;
}

/** Returned when the import ran to completion. */
export interface ImportSuccess {
  /** Always true. */
  ok: true;
  /** Medplum id of the imported Patient. */
  medplumPatientId: string;
  /** Per-resource-type write tallies. */
  counts: ImportCounts;
  /** Medplum id of the tracking Task. */
  taskId: string;
  /** Wall-clock duration of the run. */
  durationMs: number;
}

/** Returned instead of throwing, so the caller sees a cause rather than a 500. */
export interface ImportFailure {
  /** Always false. */
  ok: false;
  /** Human-readable cause. */
  error: string;
  /** Tracking Task id, when one was created before the failure. */
  taskId?: string;
  /** What had been written when the run gave up. */
  counts?: ImportCounts;
  /** Wall-clock duration up to the failure. */
  durationMs?: number;
}

// ─── Identifier systems and tags ─────────────────────────────────────────────

/**
 * Business-identifier systems, one per DrChrono endpoint.
 *
 * These are the dedup keys: every conditional `PUT` matches on
 * `<system>|<DrChrono row id>`, which is what makes the import idempotent.
 * Changing a value here orphans everything previously written under it.
 */
export const IDENTIFIER_SYSTEMS = {
  /** DrChrono patient id. */
  patient: 'https://drchrono.com/patients',
  /** DrChrono chart id (the human-facing MRN). */
  chartId: 'https://drchrono.com/chart-ids',
  /** DrChrono allergy row id. */
  allergy: 'https://drchrono.com/allergies',
  /** DrChrono medication row id. */
  medication: 'https://drchrono.com/medications',
  /** DrChrono problem row id. */
  condition: 'https://drchrono.com/problems',
  /** DrChrono appointment id, as the clinical Encounter. */
  encounter: 'https://drchrono.com/appointments',
  /** DrChrono appointment id, as the scheduling Appointment. */
  appointment: 'https://drchrono.com/fhir-appointments',
  /** DrChrono appointment id, as the Slot it occupies. */
  slot: 'https://drchrono.com/slots',
  /** The practice-wide Schedule the Slots hang off. */
  schedule: 'https://drchrono.com/schedules',
  /** DrChrono document id. */
  document: 'https://drchrono.com/documents',
  /** Vital-sign Observations, keyed `<appointment>-<LOINC>`. */
  observation: 'https://drchrono.com/observations',
  /** Visit note PDFs, keyed on the appointment id. */
  clinicalNote: 'https://drchrono.com/clinical-notes',
  /** DrChrono procedure row id. */
  procedure: 'https://drchrono.com/procedures',
  /** DrChrono doctor id. */
  practitioner: 'https://drchrono.com/doctors',
  /** DrChrono office id. */
  location: 'https://drchrono.com/offices',
  /** DrChrono insurance row id. */
  coverage: 'https://drchrono.com/insurances',
  /** DrChrono vaccine record id. */
  immunization: 'https://drchrono.com/immunizations',
  /** DrChrono lab order id. */
  labOrder: 'https://drchrono.com/lab-orders',
  /** Lab accession number, when the order carries one. */
  labAccession: 'https://drchrono.com/lab-accession-numbers',
  /** Lab requisition id, when the order carries one. */
  labRequisition: 'https://drchrono.com/lab-requisition-ids',
  /** DrChrono lab result id, as a DiagnosticReport. */
  labReport: 'https://drchrono.com/lab-results',
  /** DrChrono lab result id, as an Observation. */
  labObservation: 'https://drchrono.com/lab-observations',
  /** DrChrono lab document id. */
  labDocument: 'https://drchrono.com/lab-documents',
  /** DrChrono family history row id. */
  familyHistory: 'https://drchrono.com/family-history',
  /** Social history Observations, keyed `<row>-<topic>`. */
  socialHistory: 'https://drchrono.com/social-history',
  /** DrChrono message id. */
  communication: 'https://drchrono.com/messages',
  /** DrChrono task id. */
  task: 'https://drchrono.com/tasks',
  /** The tracking Task for one import run. */
  syncJob: 'https://lyfe.health/sync-jobs',
  /** Payer ids as DrChrono's clearinghouse reports them. */
  payer: 'https://drchrono.com/payer-ids',
  /** DrChrono's own lab test codes, when no LOINC is supplied. */
  labTestCode: 'https://drchrono.com/lab-test-codes',
  /** DrChrono message type, used as a Communication category. */
  messageType: 'https://drchrono.com/message-types',
  /** Identifies this bot as the agent on Provenance and AuditEvent. */
  agent: 'https://lyfe.health/agents',
};

/** Marks every resource this bot writes, so a DrChrono-sourced chart is separable. */
/**
 * Re-exported from {@link DRCHRONO_SOURCE_TAG} so there is one definition.
 * This constant previously carried its own literal, which drifted from the one
 * the app searches on — see `shared/source.ts`.
 */
export const SOURCE_TAG = DRCHRONO_SOURCE_TAG;

/** US Core profile and extension URLs. Conformance depends on the exact strings. */
const US_CORE = {
  race: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
  ethnicity: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
  birthSex: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex',
  patientProfile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
};

// ─── DrChrono payload shapes ─────────────────────────────────────────────────

interface DrPatient {
  id: number;
  first_name: string;
  middle_name?: string;
  last_name: string;
  suffix?: string;
  /** Older accounts spell this `nickname`; current ones use `nick_name`. */
  nickname?: string;
  nick_name?: string;
  date_of_birth?: string;
  gender?: string;
  social_security_number?: string;
  race?: string;
  ethnicity?: string;
  preferred_language?: string;
  marital_status?: string;
  email?: string;
  cell_phone?: string;
  home_phone?: string;
  office_phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  emergency_contact_relation?: string;
  doctor?: number;
  patient_photo?: string;
  chart_id?: string;
  /** YYYY-MM-DD. Used as the appointment lookback floor. */
  date_of_first_appointment?: string;
}

interface DrAllergy {
  id: number;
  name?: string;
  description?: string;
  reaction?: string;
  severity?: string;
  status?: string;
  onset_date?: string;
  snomed_code?: string;
  rxnorm?: string;
  notes?: string;
}

interface DrMedication {
  id: number;
  name: string;
  generic_name?: string;
  dosage?: string;
  dosage_quantity?: string;
  dosage_units?: string;
  route?: string;
  frequency?: string;
  status?: string;
  ndc?: string;
  rxnorm?: string;
  rxcui?: string;
  date_prescribed?: string;
  date_started_taking?: string;
  start_date?: string;
  indication?: string;
  /** DrChrono links some medications to the visit they were prescribed at. */
  appointment?: number | null;
  doctor?: number;
  number_refills?: number;
  dispense_quantity?: string;
  notes?: string;
}

interface DrProblem {
  id: number;
  name: string;
  description?: string;
  icd_code?: string;
  icd10_code?: string;
  snomed_ct_code?: string;
  status?: string;
  verification_status?: string;
  category?: string;
  date_onset?: string;
  date_diagnosis?: string;
  date_changed?: string;
  date_resolved?: string;
  abatement_date?: string;
  appointment?: number | null;
  doctor?: number;
  notes?: string;
}

interface DrVitals {
  height?: string;
  height_units?: string;
  weight?: string;
  weight_units?: string;
  bmi?: string;
  blood_pressure_1?: number;
  blood_pressure_2?: number;
  temperature?: string;
  temperature_units?: string;
  pulse?: number;
  respiratory_rate?: number;
  oxygen_saturation?: number;
}

interface DrAppointment {
  id: number;
  scheduled_time?: string;
  duration?: number;
  status?: string;
  reason?: string;
  notes?: string;
  doctor?: number;
  office?: number;
  vitals?: DrVitals;
  clinical_note?: { locked?: boolean; pdf?: string };
}

interface DrDocument {
  id: number;
  description?: string;
  date?: string;
  document?: string;
  metatags?: string[];
}

interface DrProcedure {
  id: number;
  patient: number;
  appointment?: number | null;
  doctor?: number | null;
  code?: string | null;
  description?: string;
  status?: string;
  date?: string;
}

interface DrDoctor {
  id: number;
  first_name: string;
  last_name: string;
  suffix?: string;
  specialty?: string;
  npi?: string;
  /** Some DrChrono accounts use this field name instead of `npi`. */
  npi_number?: string;
  email?: string;
  office_phone?: string;
  cell_phone?: string;
  /** DrChrono's own retirement flag for a provider. */
  is_account_suspended?: boolean;
  /** IANA zone the provider's naive timestamps are wall-clock in. */
  timezone?: string;
}

interface DrOffice {
  id: number;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  phone_number?: string;
  fax_number?: string;
  /** DrChrono's own retirement flag for an office. */
  archived?: boolean;
}

interface DrInsurance {
  id: number;
  patient: number;
  payer_type?: string;
  payer_name?: string;
  insurance_company?: string;
  insurance_plan_name?: string;
  insurance_group_number?: string;
  insurance_id_number?: string;
  insurance_payer_id?: string;
  member_id?: string;
  group_number?: string;
  plan_name?: string;
  effective_date?: string;
  expiration_date?: string;
  is_subscriber_the_patient?: boolean;
  subscriber_relation?: string;
}

interface DrImmunization {
  id: number;
  patient: number;
  doctor?: number;
  name?: string;
  vaccine_name?: string;
  cvx_code?: string;
  ndc_code?: string;
  administered_date?: string;
  administration_date?: string;
  lot_number?: string;
  expiration_date?: string;
  manufacturer?: string;
  route?: string;
  site?: string;
  dose?: string;
  dose_units?: string;
  status?: string;
  notes?: string;
  reaction?: string;
  reason_not_given?: string;
}

interface DrLabOrder {
  id: number;
  patient: number;
  doctor?: number;
  appointment?: number;
  accession_number?: string;
  requisition_id?: string;
  status?: string;
  icd10_codes?: string[];
  priority?: string;
  notes?: string;
  timestamp?: string;
  created_at?: string;
}

interface DrLabResult {
  id: number;
  lab_order: number;
  test_name?: string;
  test_code?: string;
  loinc_code?: string;
  observation_description?: string;
  value?: string;
  result_value?: string;
  units?: string;
  result_units?: string;
  reference_range?: string;
  normal_range?: string;
  abnormal_flag?: string;
  abnormal_status?: string;
  is_abnormal?: boolean;
  date_collected?: string;
  date_resulted?: string;
  status?: string;
  comments?: string;
}

/**
 * A row from `/lab_documents`: the lab PDF plus the raw HL7 v2 result message.
 *
 * This endpoint exists in the import because `/lab_results` returns malformed
 * JSON for practices with many results, a DrChrono server-side bug. The HL7 body
 * carries the full structured result, so storing it inline keeps the data even
 * when the structured endpoint is unusable.
 */
interface DrLabDocument {
  id: number;
  lab_order: number;
  /** S3 presigned URL for the PDF. */
  document?: string;
  /** `REQ` = requisition, `RES` = result. */
  type?: string;
  timestamp?: string;
  /** Raw HL7 v2 ORU^R01 message, present when `type === 'RES'`. */
  hl7?: string | null;
}

interface DrFamilyHistory {
  id: number;
  patient: number;
  relationship?: string;
  member_name?: string;
  condition?: string;
  icd10_code?: string;
  date_of_onset?: string;
  notes?: string;
}

interface DrSocialHistory {
  id: number;
  patient: number;
  smoking_status?: string;
  smoking_status_code?: string;
  alcohol_use?: string;
  recorded_date?: string;
}

interface DrMessage {
  id: number;
  patient?: number;
  title?: string;
  type?: string;
  read?: boolean;
  archived?: boolean;
  received_at?: string;
  updated_at?: string;
}

interface DrTask {
  id: number;
  title?: string;
  due_date?: string;
  notes?: string;
  assignee?: number;
  associated_items?: { type: string; value: number }[];
  created_at?: string;
}

/** One page of a DrChrono list endpoint. */
interface DrPage<T> {
  results?: T[];
  next?: string | null;
}

// ─── DrChrono transport ──────────────────────────────────────────────────────

/** Per-request wall-clock cap. `/lab_results` routinely takes 10-20s. */
const DRCHRONO_REQUEST_TIMEOUT_MS = 60_000;

/** Hard cap on pages, so a pagination loop cannot run forever. */
const DRCHRONO_MAX_PAGES = 100;

/** Per-section watchdog. Whatever was collected before it fires is kept. */
const DRCHRONO_SECTION_TIMEOUT_MS = 300_000;

/** Smaller pages keep individual responses fast enough to avoid edge timeouts. */
const DRCHRONO_PAGE_SIZE = '50';

/** Backoffs for a retryable status. Worst case ~37s of sleeping per request. */
const DRCHRONO_RETRY_BACKOFFS_MS = [2_000, 5_000, 10_000, 20_000];

/** Politeness pause between pages of the same endpoint. */
const DRCHRONO_INTER_PAGE_DELAY_MS = 200;

/**
 * DrChrono rejects a `date_range` wider than ~190 days unless the entire range
 * is in the past, and a range ending today or yesterday does not count as past.
 * It answers with an empty result set rather than an error, so an over-wide
 * range reads as "this patient has no appointments". 180 stays clear of it.
 */
const APPOINTMENT_CHUNK_DAYS = 180;

const DAY_MS = 86_400_000;

/** Lookback used when DrChrono reports no first-appointment date. */
const DEFAULT_LOOKBACK_YEARS = 3;

/** How far ahead to look for booked visits. */
const FUTURE_WINDOW_DAYS = 180;

/**
 * Race a promise against a timer that rejects.
 *
 * Node's `fetch` honours an AbortController for the headers but not reliably for
 * a chunked body read, so a hung response can outlive its own abort. This is the
 * backstop.
 * @param promise - The work to bound.
 * @param ms - How long to allow before rejecting.
 * @param label - Included in the timeout message.
 * @returns The promise's value, or a rejection once `ms` elapses.
 */
function withHardTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof nodeSetTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = nodeSetTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    nodeClearTimeout(timer);
  });
}

/**
 * Issue one authenticated DrChrono request, retrying transient failures.
 *
 * DrChrono 500s individual pages under load on endpoints that are otherwise
 * healthy, and 429s when a bulk backfill runs several charts back to back. Both
 * are retried with exponential backoff; `Retry-After` is honoured when sent.
 * Authentication and token rotation are the client's job, not this function's.
 * @param client - The clinic-scoped DrChrono client.
 * @param path - Absolute URL, or a path relative to the clinic's API base.
 * @returns The final response, retryable statuses already exhausted.
 */
async function drchronoGet(client: DrChronoClient, path: string): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= DRCHRONO_RETRY_BACKOFFS_MS.length; attempt++) {
    const res = await withHardTimeout(client.fetch(path), DRCHRONO_REQUEST_TIMEOUT_MS, `GET ${path}`);
    const retryable = res.status >= 500 || res.status === 429;
    if (!retryable || attempt === DRCHRONO_RETRY_BACKOFFS_MS.length) {
      return res;
    }
    lastStatus = res.status;

    const retryAfterRaw = res.headers.get('retry-after');
    const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : Number.NaN;
    const useRetryAfter = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
    const backoff = useRetryAfter ? Math.min(60_000, retryAfterMs) : DRCHRONO_RETRY_BACKOFFS_MS[attempt];

    // Drain the body so the socket can be reused for the retry.
    await res.text().catch(() => null);
    console.warn(`[drchrono-import] ${res.status} on ${path} — backoff ${backoff}ms (retry ${attempt + 1})`);
    await sleep(backoff);
  }
  throw new Error(`DrChrono exhausted retries on ${path} (last status ${lastStatus})`);
}

/** Bounds on one paginated pull. */
interface PaginationOptions {
  /** Stop after this many records. */
  maxRecords?: number;
  /** Abandon the section after this long, keeping what was collected. */
  sectionTimeoutMs?: number;
}

/**
 * Walk a DrChrono list endpoint to exhaustion, degrading rather than failing.
 *
 * Two deliberate behaviours, both from production:
 *
 * 1. `results` lives outside the inner loop, so a page that fails after its
 *    retries — or a section watchdog firing — still returns everything collected
 *    up to that point. DrChrono flakes mid-pagination often enough that
 *    discarding a successful 40 pages over a failed 41st loses real data.
 * 2. A non-JSON content type is treated as a failure rather than parsed.
 *    DrChrono occasionally answers `200 text/html` from its edge layer, and
 *    `JSON.parse` on that produces a confusing error far from the cause.
 * @param client - The clinic-scoped DrChrono client.
 * @param endpoint - Path such as `/allergies`.
 * @param params - Query parameters, merged over the default page size.
 * @param options - Record cap and section timeout.
 * @returns Every record collected, which may be a partial set.
 */
async function drchronoPaginated<T>(
  client: DrChronoClient,
  endpoint: string,
  params: Record<string, string> = {},
  options: PaginationOptions = {}
): Promise<T[]> {
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
  const sectionTimeoutMs = options.sectionTimeoutMs ?? DRCHRONO_SECTION_TIMEOUT_MS;
  const results: T[] = [];

  const inner = async (): Promise<T[]> => {
    const qs = new URLSearchParams({ page_size: DRCHRONO_PAGE_SIZE, ...params }).toString();
    let url: string | null = `${endpoint}?${qs}`;
    let pages = 0;

    while (url) {
      pages++;
      if (pages > DRCHRONO_MAX_PAGES) {
        console.warn(`[drchrono-import] pagination cap (${DRCHRONO_MAX_PAGES}) hit on ${endpoint}`);
        break;
      }

      let page: DrPage<T>;
      try {
        const res = await drchronoGet(client, url);
        if (!res.ok) {
          const body = await withHardTimeout(res.text(), DRCHRONO_REQUEST_TIMEOUT_MS, `body ${endpoint}`);
          throw new Error(`DrChrono ${res.status} on ${endpoint}: ${body.slice(0, 200)}`);
        }
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          throw new Error(`DrChrono ${endpoint} answered content-type "${contentType}"`);
        }
        page = (await withHardTimeout(res.json(), DRCHRONO_REQUEST_TIMEOUT_MS, `json ${endpoint}`)) as DrPage<T>;
      } catch (err) {
        console.warn(
          `[drchrono-import] ${endpoint} page ${pages} failed, keeping ${results.length} prior records: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
        return results;
      }

      results.push(...(page.results ?? []));
      if (results.length >= maxRecords) {
        results.length = maxRecords;
        break;
      }

      url = page.next ?? null;
      if (url) {
        await sleep(DRCHRONO_INTER_PAGE_DELAY_MS);
      }
    }
    return results;
  };

  try {
    return await withHardTimeout(inner(), sectionTimeoutMs, `paginate ${endpoint}`);
  } catch (err) {
    console.warn(
      `[drchrono-import] ${endpoint} watchdog fired, keeping ${results.length} records: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return results;
  }
}

/**
 * Run a paginated pull that is allowed to come back empty.
 *
 * Several endpoints are not enabled for every practice and answer 403 or 404.
 * That is not a reason to fail the whole chart.
 * @param client - The clinic-scoped DrChrono client.
 * @param endpoint - Path such as `/social_history`.
 * @param params - Query parameters.
 * @param options - Record cap and section timeout.
 * @returns Records, or an empty array when the endpoint is unavailable.
 */
async function drchronoOptional<T>(
  client: DrChronoClient,
  endpoint: string,
  params: Record<string, string> = {},
  options: PaginationOptions = {}
): Promise<T[]> {
  try {
    return await drchronoPaginated<T>(client, endpoint, params, options);
  } catch (err) {
    console.warn(`[drchrono-import] ${endpoint} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── Small shared helpers ────────────────────────────────────────────────────

/**
 * Normalise a DrChrono timestamp into a FHIR `instant`.
 *
 * DrChrono returns at least four shapes for the same concept: `YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:mm:ss` with no zone, the same with a space instead of the `T`,
 * and occasionally junk. FHIR `instant` accepts only a full ISO 8601 timestamp
 * with a zone, so an un-normalised value 400s the whole batch entry it sits in.
 * @param value - The raw DrChrono value.
 * @param timeZone - The zone a naive value is wall-clock in. Defaults to the
 *   practice zone; ignored when the value already carries an offset.
 * @returns A full ISO 8601 instant, or undefined when the value is unusable.
 */
function toInstant(value: string | undefined | null, timeZone?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const withT = value.includes('T') ? value : value.replace(' ', 'T');
  const dated = withT.includes('T') ? withT : `${withT}T00:00:00`;

  // Already carries an offset: trust it.
  if (/[Zz]|[+-]\d\d:?\d\d$/.test(dated)) {
    const parsed = new Date(dated);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  // Naive, which is everything DrChrono sends. `scheduled_time` is the
  // practice's WALL CLOCK — "2026-09-14T09:15:00" means quarter past nine in
  // the clinic — and carries no offset at all.
  //
  // This used to append `Z`, which declares that wall clock to be UTC. Every
  // appointment, encounter, vital and document was therefore stored seven or
  // eight hours from when it happened, and a 9:15am visit rendered as 2:15pm
  // for a reader in another zone. Nothing errored; the times were simply
  // wrong, consistently, everywhere.
  const parsedLocal = zonedWallClockToInstant(dated, timeZone ?? DEFAULT_PRACTICE_TIME_ZONE);
  return parsedLocal ?? fallbackAsUtc(dated);
}

/**
 * Parse a naive timestamp as UTC, which is what this did before time zones
 * were handled. Reached only when the runtime cannot resolve a zone.
 * @param dated - A naive ISO timestamp.
 * @returns The instant, or undefined when unparseable.
 */
function fallbackAsUtc(dated: string): string | undefined {
  const parsed = new Date(`${dated}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * How far ahead of UTC a zone is at a given instant, in milliseconds.
 * @param instant - The moment to measure at, since the offset moves with DST.
 * @param timeZone - An IANA zone name.
 * @returns The offset, or undefined when the runtime cannot resolve the zone.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .reduce<Record<string, string>>((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    return asUtc - instant.getTime();
  } catch {
    // A runtime built without full ICU rejects the zone name outright.
    return undefined;
  }
}

/**
 * Read a naive timestamp as wall-clock time in a zone, and return the instant.
 *
 * Two passes, because the offset depends on the instant we are trying to find.
 * The first pass guesses with the offset in force at the naive time read as
 * UTC; the second re-reads the offset at that candidate and corrects it. That
 * matters only within an hour of a DST change, which is exactly when a silent
 * one-hour error would be hardest to notice.
 * @param dated - A naive ISO timestamp, no offset.
 * @param timeZone - The zone the timestamp is wall-clock in.
 * @returns The UTC instant, or undefined when the zone cannot be resolved.
 */
function zonedWallClockToInstant(dated: string, timeZone: string): string | undefined {
  const guess = new Date(`${dated}Z`);
  if (Number.isNaN(guess.getTime())) {
    return undefined;
  }
  const firstOffset = zoneOffsetMs(guess, timeZone);
  if (firstOffset === undefined) {
    return undefined;
  }
  const candidate = new Date(guess.getTime() - firstOffset);
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  const corrected =
    secondOffset === undefined || secondOffset === firstOffset ? candidate : new Date(guess.getTime() - secondOffset);
  return corrected.toISOString();
}

/**
 * Offset an instant by a number of minutes.
 * @param instant - A full ISO 8601 instant.
 * @param minutes - Minutes to add.
 * @returns The shifted instant.
 */
function addMinutes(instant: string, minutes: number): string {
  return new Date(new Date(instant).getTime() + minutes * 60_000).toISOString();
}

/**
 * Format a date as `YYYY-MM-DD` in UTC, the shape DrChrono's filters expect.
 * @param date - The date to format.
 * @returns The date portion of its ISO form.
 */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Join the non-empty pieces of a list with a separator.
 * @param parts - Candidate strings, any of which may be empty or undefined.
 * @param separator - What to place between the surviving pieces.
 * @returns The joined string, or undefined when nothing survived.
 */
function joinDefined(parts: (string | undefined | null)[], separator: string): string | undefined {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(separator) : undefined;
}

/**
 * Build the `meta` every written resource carries.
 *
 * `meta.account` is the whole reason this exists. Medplum's compartment
 * filtering is what a clinic AccessPolicy matches on, so a resource written
 * without it is accepted by the server and then invisible to every user at the
 * clinic that owns it — a silent data loss that looks like a failed import.
 * `accounts` is the current field and `account` the one it is normalised from;
 * both are set, matching what `shared/credentials.ts` already does.
 *
 * Note that Medplum only honours a caller-supplied account when the writer is a
 * project admin, which is why `deploy.ts` gives this bot an admin membership.
 * @param organization - The calling clinic.
 * @returns Meta carrying the source tag and the compartment.
 */
export function buildMeta(organization: Reference<Organization>): Meta {
  return {
    tag: [SOURCE_TAG],
    account: organization,
    accounts: [organization],
  };
}

/**
 * An empty tally, used as the starting point and as the failure-path value.
 * @returns Every count at zero.
 */
function emptyCounts(): ImportCounts {
  return {
    practitioners: 0,
    locations: 0,
    coverages: 0,
    allergies: 0,
    medications: 0,
    conditions: 0,
    procedures: 0,
    immunizations: 0,
    familyHistories: 0,
    socialHistoryObs: 0,
    labOrders: 0,
    labReports: 0,
    labObservations: 0,
    labDocuments: 0,
    appointments: 0,
    slots: 0,
    appointmentResources: 0,
    documents: 0,
    observations: 0,
    clinicalNotes: 0,
    communications: 0,
    tasks: 0,
  };
}

/**
 * Write a set of resources, skipping the round trip when there is nothing to do.
 * @param medplum - Bot-scoped client.
 * @param entries - Resources plus the identifier each is keyed on.
 * @param label - Prefix for any warning the batch logs.
 * @returns Per-entry ids and statuses plus write tallies.
 */
async function write(medplum: MedplumClient, entries: UpsertEntry[], label: string): Promise<BatchResult> {
  if (entries.length === 0) {
    return { ids: [], statuses: [], wrote: 0, failed: 0, rateLimited: false };
  }
  return upsertBatch(medplum, entries, { label: `drchrono-import:${label}` });
}

// ─── RxNorm lookup ───────────────────────────────────────────────────────────

/**
 * Resolve an RxNorm concept id to its display name.
 *
 * DrChrono returns the code but frequently not the name on `/allergies`, and an
 * AllergyIntolerance whose `code.text` reads "Unknown Allergen" is useless on a
 * chart. RxNav is public and unauthenticated. Failure is not fatal: the caller
 * falls back to whatever DrChrono did supply.
 * @param rxnorm - The RxNorm concept id.
 * @param cache - Shared per-run memo, so a repeated code costs one call.
 * @returns The concept name, or undefined when it cannot be resolved.
 */
async function resolveRxNormName(rxnorm: string | undefined, cache: Map<string, string>): Promise<string | undefined> {
  if (!rxnorm) {
    return undefined;
  }
  const cached = cache.get(rxnorm);
  if (cached) {
    return cached;
  }
  try {
    const res = await withHardTimeout(
      fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxnorm)}/properties.json`),
      15_000,
      `rxnav ${rxnorm}`
    );
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as { properties?: { name?: string } };
    const name = body.properties?.name;
    if (name) {
      cache.set(rxnorm, name);
    }
    return name;
  } catch {
    return undefined;
  }
}

// ─── Patient ─────────────────────────────────────────────────────────────────

/** OMB race categories, as US Core requires them coded. */
const RACE_OMB: Record<string, { code: string; display: string }> = {
  'american indian or alaska native': { code: '1002-5', display: 'American Indian or Alaska Native' },
  asian: { code: '2028-9', display: 'Asian' },
  'black or african american': { code: '2054-5', display: 'Black or African American' },
  'native hawaiian or other pacific islander': { code: '2076-8', display: 'Native Hawaiian or Other Pacific Islander' },
  white: { code: '2106-3', display: 'White' },
  'other race': { code: '2131-1', display: 'Other Race' },
};

/** OMB ethnicity categories. */
const ETHNICITY_OMB: Record<string, { code: string; display: string }> = {
  'hispanic or latino': { code: '2135-2', display: 'Hispanic or Latino' },
  'not hispanic or latino': { code: '2186-5', display: 'Not Hispanic or Latino' },
};

/** HL7 v3 marital status codes. */
const MARITAL_V3: Record<string, { code: string; display: string }> = {
  single: { code: 'S', display: 'Never Married' },
  married: { code: 'M', display: 'Married' },
  divorced: { code: 'D', display: 'Divorced' },
  widowed: { code: 'W', display: 'Widowed' },
  separated: { code: 'L', display: 'Legally Separated' },
};

/** The OID the OMB race and ethnicity code systems are published under. */
const OMB_SYSTEM = 'urn:oid:2.16.840.1.113883.6.238';

/** DrChrono gender values mapped onto the FHIR administrative gender value set. */
const GENDER_MAP: Record<string, Patient['gender']> = {
  Male: 'male',
  Female: 'female',
  Other: 'other',
  UNK: 'unknown',
  ASKU: 'unknown',
};

/** DrChrono gender values that imply a US Core birth sex code. */
const BIRTH_SEX_MAP: Record<string, string> = { Male: 'M', Female: 'F' };

/**
 * Build the US Core race extension.
 * @param race - DrChrono's free-text race value.
 * @returns The extension, or undefined when no race was recorded.
 */
function buildRaceExtension(race: string | undefined): Extension | undefined {
  if (!race) {
    return undefined;
  }
  const omb = RACE_OMB[race.toLowerCase()];
  return {
    url: US_CORE.race,
    extension: [
      ...(omb ? [{ url: 'ombCategory', valueCoding: { system: OMB_SYSTEM, ...omb } }] : []),
      { url: 'text', valueString: race },
    ],
  };
}

/**
 * Build the US Core ethnicity extension.
 * @param ethnicity - DrChrono's free-text ethnicity value.
 * @returns The extension, or undefined when no ethnicity was recorded.
 */
function buildEthnicityExtension(ethnicity: string | undefined): Extension | undefined {
  if (!ethnicity) {
    return undefined;
  }
  const omb = ETHNICITY_OMB[ethnicity.toLowerCase()];
  return {
    url: US_CORE.ethnicity,
    extension: [
      ...(omb ? [{ url: 'ombCategory', valueCoding: { system: OMB_SYSTEM, ...omb } }] : []),
      { url: 'text', valueString: ethnicity },
    ],
  };
}

/**
 * Build the US Core birth sex extension.
 *
 * DrChrono has one gender field, so administrative gender is the only source
 * for birth sex. Anything other than Male or Female produces no extension
 * rather than a guess.
 * @param gender - DrChrono's gender value.
 * @returns The extension, or undefined when it cannot be derived.
 */
function buildBirthSexExtension(gender: string | undefined): Extension | undefined {
  const code = gender ? BIRTH_SEX_MAP[gender] : undefined;
  return code ? { url: US_CORE.birthSex, valueCode: code } : undefined;
}

/**
 * Map a DrChrono patient onto a US Core Patient.
 * @param p - The DrChrono patient payload.
 * @param organization - The calling clinic.
 * @returns The Patient resource, without `generalPractitioner`.
 */
function mapPatient(p: DrPatient, organization: Reference<Organization>): Patient {
  const identifier: Patient['identifier'] = [
    {
      use: 'usual',
      system: IDENTIFIER_SYSTEMS.patient,
      value: String(p.id),
      type: {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical Record Number' },
        ],
      },
    },
  ];
  if (p.chart_id) {
    identifier.push({
      use: 'secondary',
      system: IDENTIFIER_SYSTEMS.chartId,
      value: p.chart_id,
      type: {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical Record Number' },
        ],
      },
    });
  }
  if (p.social_security_number) {
    identifier.push({
      use: 'official',
      system: 'http://hl7.org/fhir/sid/us-ssn',
      value: p.social_security_number,
      type: {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'SS', display: 'Social Security Number' },
        ],
      },
    });
  }

  const name: Patient['name'] = [
    {
      use: 'official',
      family: p.last_name,
      given: [p.first_name, ...(p.middle_name ? [p.middle_name] : [])],
      ...(p.suffix ? { suffix: [p.suffix] } : {}),
    },
  ];
  const nickname = p.nickname || p.nick_name;
  if (nickname) {
    name.push({ use: 'nickname', given: [nickname] });
  }

  const telecom: Patient['telecom'] = [];
  if (p.cell_phone) {
    telecom.push({ system: 'phone', value: p.cell_phone, use: 'mobile', rank: 1 });
  }
  if (p.home_phone) {
    telecom.push({ system: 'phone', value: p.home_phone, use: 'home', rank: 2 });
  }
  if (p.office_phone) {
    telecom.push({ system: 'phone', value: p.office_phone, use: 'work', rank: 3 });
  }
  if (p.email) {
    telecom.push({ system: 'email', value: p.email });
  }

  const extension = [
    buildRaceExtension(p.race),
    buildEthnicityExtension(p.ethnicity),
    buildBirthSexExtension(p.gender),
  ].filter((x): x is Extension => Boolean(x));

  const marital = p.marital_status ? MARITAL_V3[p.marital_status.toLowerCase()] : undefined;

  return {
    resourceType: 'Patient',
    active: true,
    meta: { ...buildMeta(organization), profile: [US_CORE.patientProfile] },
    managingOrganization: organization,
    identifier,
    name,
    birthDate: p.date_of_birth || undefined,
    gender: GENDER_MAP[p.gender ?? ''] ?? 'unknown',
    telecom: telecom.length > 0 ? telecom : undefined,
    address: p.address
      ? [{ use: 'home', line: [p.address], city: p.city, state: p.state, postalCode: p.zip_code, country: 'USA' }]
      : undefined,
    extension: extension.length > 0 ? extension : undefined,
    communication: p.preferred_language
      ? [
          {
            language: {
              coding: [
                {
                  system: 'urn:ietf:bcp:47',
                  code: p.preferred_language.toLowerCase().slice(0, 2),
                  display: p.preferred_language,
                },
              ],
              text: p.preferred_language,
            },
            preferred: true,
          },
        ]
      : undefined,
    maritalStatus: marital
      ? {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', ...marital }],
          text: p.marital_status,
        }
      : undefined,
    contact: p.emergency_contact_name
      ? [
          {
            relationship: [
              {
                coding: [
                  { system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'C', display: 'Emergency Contact' },
                ],
                text: p.emergency_contact_relation || 'Emergency Contact',
              },
            ],
            name: { text: p.emergency_contact_name },
            telecom: p.emergency_contact_phone ? [{ system: 'phone', value: p.emergency_contact_phone }] : undefined,
          },
        ]
      : undefined,
    photo: p.patient_photo ? [{ url: p.patient_photo, contentType: 'image/jpeg' }] : undefined,
  };
}

// ─── Practitioner / Location / Coverage ──────────────────────────────────────

/**
 * Map a DrChrono doctor onto a Practitioner.
 * @param d - The DrChrono doctor payload.
 * @param organization - The calling clinic.
 * @param enabled - Whether this clinic has the provider switched on.
 * @returns The Practitioner resource.
 */
function mapPractitioner(d: DrDoctor, organization: Reference<Organization>, enabled: boolean): Practitioner {
  const telecom: Practitioner['telecom'] = [];
  if (d.cell_phone) {
    telecom.push({ system: 'phone', value: d.cell_phone, use: 'mobile' });
  }
  if (d.office_phone) {
    telecom.push({ system: 'phone', value: d.office_phone, use: 'work' });
  }
  if (d.email) {
    telecom.push({ system: 'email', value: d.email });
  }
  // DrChrono inconsistently uses `npi` or `npi_number` depending on account age.
  const npi = d.npi || d.npi_number;
  return {
    resourceType: 'Practitioner',
    meta: buildMeta(organization),
    identifier: [
      { system: IDENTIFIER_SYSTEMS.practitioner, value: String(d.id) },
      ...(npi ? [{ system: 'http://hl7.org/fhir/sid/us-npi', value: npi }] : []),
    ],
    active: enabled,
    name: [{ use: 'official', family: d.last_name, given: [d.first_name], suffix: d.suffix ? [d.suffix] : undefined }],
    telecom: telecom.length > 0 ? telecom : undefined,
    qualification: d.specialty ? [{ code: { text: d.specialty } }] : undefined,
  };
}

/**
 * Map a DrChrono office onto a Location.
 * @param o - The DrChrono office payload.
 * @param organization - The calling clinic.
 * @param enabled - Whether this clinic has the office switched on.
 * @param zusEnabled - Whether patients seen here may be enrolled in Zus.
 * @returns The Location resource.
 */
function mapLocation(
  o: DrOffice,
  organization: Reference<Organization>,
  enabled: boolean,
  zusEnabled: boolean
): Location {
  const telecom: Location['telecom'] = [];
  if (o.phone_number) {
    telecom.push({ system: 'phone', value: o.phone_number, use: 'work' });
  }
  if (o.fax_number) {
    telecom.push({ system: 'fax', value: o.fax_number });
  }
  return {
    resourceType: 'Location',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.location, value: String(o.id) }],
    status: enabled ? 'active' : 'suspended',
    // Always written, never omitted when false: an absent extension and an
    // explicit `false` must not be distinguishable, or a re-pull would look
    // like a change and the value would drift.
    extension: [{ url: ZUS_ENROLMENT_EXTENSION, valueBoolean: zusEnabled }],
    name: o.name,
    telecom: telecom.length > 0 ? telecom : undefined,
    address: o.address
      ? { line: [o.address], city: o.city, state: o.state, postalCode: o.zip_code, country: 'USA' }
      : undefined,
    managingOrganization: organization,
  };
}

/** DrChrono payer types mapped onto HL7 v3 ActCode coverage types. */
const COVERAGE_TYPE_MAP: Record<string, string> = {
  primary: 'EHCPOL',
  secondary: 'EHCPOL',
  tertiary: 'EHCPOL',
  workers_comp: 'WCBPOL',
  auto_accident: 'pubpol',
};

/** DrChrono payer types mapped onto `Coverage.order`. */
const COVERAGE_ORDER_MAP: Record<string, number> = { primary: 1, secondary: 2, tertiary: 3 };

/**
 * Map a DrChrono insurance row onto a Coverage.
 * @param c - The DrChrono insurance payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @returns The Coverage resource.
 */
function mapCoverage(c: DrInsurance, patient: Reference<Patient>, organization: Reference<Organization>): Coverage {
  const expired = Boolean(c.expiration_date) && new Date(c.expiration_date as string) < new Date();
  const group = c.group_number || c.insurance_group_number;
  const plan = c.plan_name || c.insurance_plan_name;

  let relationship: Coverage['relationship'];
  if (c.is_subscriber_the_patient) {
    relationship = {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'self' }],
    };
  } else if (c.subscriber_relation) {
    relationship = { text: c.subscriber_relation };
  }

  return {
    resourceType: 'Coverage',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.coverage, value: String(c.id) }],
    status: expired ? 'cancelled' : 'active',
    type: c.payer_type
      ? {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: COVERAGE_TYPE_MAP[c.payer_type] ?? 'EHCPOL',
            },
          ],
        }
      : undefined,
    subscriberId: c.member_id || c.insurance_id_number,
    beneficiary: patient,
    relationship,
    period: { start: c.effective_date || undefined, end: c.expiration_date || undefined },
    payor: [
      {
        display: c.payer_name || c.insurance_company || 'Unknown Payer',
        ...(c.insurance_payer_id
          ? { identifier: { system: IDENTIFIER_SYSTEMS.payer, value: c.insurance_payer_id } }
          : {}),
      },
    ],
    class: [
      ...(group
        ? [
            {
              type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] },
              value: group,
            },
          ]
        : []),
      ...(plan
        ? [
            {
              type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'plan' }] },
              value: plan,
            },
          ]
        : []),
    ],
    order: c.payer_type ? COVERAGE_ORDER_MAP[c.payer_type] : undefined,
  };
}

// ─── Allergy ─────────────────────────────────────────────────────────────────

/** DrChrono allergy statuses mapped onto the FHIR clinical status value set. */
const ALLERGY_STATUS_MAP: Record<string, string> = { active: 'active', inactive: 'inactive', resolved: 'resolved' };

/** DrChrono severities mapped onto FHIR criticality. */
const ALLERGY_CRITICALITY_MAP: Record<string, AllergyIntolerance['criticality']> = {
  mild: 'low',
  moderate: 'low',
  severe: 'high',
  'life-threatening': 'high',
};

/**
 * Map a DrChrono severity onto a reaction severity.
 * @param severity - DrChrono's free-text severity.
 * @returns The FHIR reaction severity.
 */
function reactionSeverity(severity: string | undefined): 'mild' | 'moderate' | 'severe' {
  const lowered = (severity ?? '').toLowerCase();
  if (lowered === 'severe' || lowered === 'life-threatening') {
    return 'severe';
  }
  if (lowered === 'moderate') {
    return 'moderate';
  }
  return 'mild';
}

/**
 * Infer an allergy category from which code DrChrono supplied.
 *
 * DrChrono has no category field. An RxNorm code means a drug; a SNOMED code
 * with no RxNorm is, in practice, an environmental or food allergen. Neither
 * code produces no category rather than a guess.
 * @param a - The DrChrono allergy payload.
 * @returns The category list, or undefined.
 */
function allergyCategory(a: DrAllergy): AllergyIntolerance['category'] {
  if (a.rxnorm) {
    return ['medication'];
  }
  if (a.snomed_code) {
    return ['environment'];
  }
  return undefined;
}

/**
 * Map a DrChrono allergy onto an AllergyIntolerance.
 * @param a - The DrChrono allergy payload.
 * @param patient - Reference to the imported patient.
 * @param resolvedName - Display text, already resolved from RxNorm when needed.
 * @param organization - The calling clinic.
 * @returns The AllergyIntolerance resource.
 */
function mapAllergy(
  a: DrAllergy,
  patient: Reference<Patient>,
  resolvedName: string | undefined,
  organization: Reference<Organization>
): AllergyIntolerance {
  const displayText = resolvedName || 'Unknown Allergen';
  return {
    resourceType: 'AllergyIntolerance',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.allergy, value: String(a.id) }],
    patient,
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          code: ALLERGY_STATUS_MAP[a.status?.toLowerCase() ?? ''] ?? 'active',
        },
      ],
    },
    // US Core requires verificationStatus and DrChrono does not expose it. These
    // rows come off a reconciled allergy list, so `confirmed` is the honest default.
    verificationStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
          code: 'confirmed',
          display: 'Confirmed',
        },
      ],
    },
    type: 'allergy',
    category: allergyCategory(a),
    criticality: a.severity ? (ALLERGY_CRITICALITY_MAP[a.severity.toLowerCase()] ?? 'unable-to-assess') : undefined,
    code: {
      coding: [
        ...(a.snomed_code ? [{ system: 'http://snomed.info/sct', code: a.snomed_code, display: displayText }] : []),
        ...(a.rxnorm
          ? [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: a.rxnorm, display: displayText }]
          : []),
      ],
      text: displayText,
    },
    onsetDateTime: a.onset_date || undefined,
    reaction: a.reaction
      ? [{ manifestation: [{ coding: [], text: a.reaction }], severity: reactionSeverity(a.severity) }]
      : undefined,
    note: a.notes ? [{ text: a.notes }] : undefined,
  };
}

// ─── Medication ──────────────────────────────────────────────────────────────

/** DrChrono medication statuses mapped onto MedicationRequest status. */
const MEDICATION_STATUS_MAP: Record<string, MedicationRequest['status']> = {
  active: 'active',
  inactive: 'stopped',
  resolved: 'completed',
};

/**
 * Build `MedicationRequest.dispenseRequest`, omitting it when empty.
 *
 * `numberOfRepeatsAllowed` is a FHIR `unsignedInt`: zero is meaningful and null
 * is invalid, so the field is omitted rather than nulled when DrChrono has no
 * value. An emitted null 400s the batch entry.
 * @param m - The DrChrono medication payload.
 * @returns The dispenseRequest, or undefined.
 */
function buildDispenseRequest(m: DrMedication): MedicationRequest['dispenseRequest'] {
  const refills = typeof m.number_refills === 'number' ? m.number_refills : undefined;
  const parsed = m.dispense_quantity ? parseFloat(m.dispense_quantity) : Number.NaN;
  const quantity = Number.isFinite(parsed) ? { value: parsed } : undefined;
  if (refills === undefined && !quantity) {
    return undefined;
  }
  return {
    ...(refills === undefined ? {} : { numberOfRepeatsAllowed: refills }),
    ...(quantity ? { quantity } : {}),
  };
}

/**
 * Map a DrChrono medication onto a MedicationRequest.
 * @param m - The DrChrono medication payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param practitioners - DrChrono doctor id to Practitioner reference.
 * @param encounters - DrChrono appointment id to Encounter reference.
 * @returns The MedicationRequest resource.
 */
function mapMedication(
  m: DrMedication,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  practitioners: Map<string, Reference<Practitioner>>,
  encounters: Map<string, Reference<Encounter>>
): MedicationRequest {
  const dosageParts = [m.dosage || joinDefined([m.dosage_quantity, m.dosage_units], ' '), m.frequency, m.route];
  const dosageText = joinDefined(dosageParts, ' ');
  const medicationNote = joinDefined([m.indication, m.notes], ' — ');
  return {
    resourceType: 'MedicationRequest',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.medication, value: String(m.id) }],
    status: MEDICATION_STATUS_MAP[m.status?.toLowerCase() ?? ''] ?? 'active',
    intent: 'order',
    subject: patient,
    encounter: m.appointment ? lookup(encounters, m.appointment) : undefined,
    requester: m.doctor ? lookup(practitioners, m.doctor) : undefined,
    medicationCodeableConcept: {
      coding: [
        ...(m.ndc ? [{ system: 'http://hl7.org/fhir/sid/ndc', code: m.ndc, display: m.name }] : []),
        ...(m.rxnorm
          ? [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: m.rxnorm, display: m.name }]
          : []),
        ...(m.rxcui && m.rxcui !== m.rxnorm
          ? [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: m.rxcui }]
          : []),
      ],
      text: m.name || m.generic_name || 'Unknown Medication',
    },
    dosageInstruction: dosageText ? [{ text: dosageText, route: m.route ? { text: m.route } : undefined }] : undefined,
    authoredOn: m.date_prescribed || m.start_date || m.date_started_taking || undefined,
    note: medicationNote ? [{ text: medicationNote }] : undefined,
    dispenseRequest: buildDispenseRequest(m),
  };
}

// ─── Condition ───────────────────────────────────────────────────────────────

/**
 * DrChrono problem statuses mapped onto the FHIR clinical status value set.
 *
 * Note what is absent: "chronic". DrChrono's `is_chronic` is a separate concept
 * and is not a clinical status, so writing it as one produces an invalid
 * Condition.
 */
const CONDITION_STATUS_MAP: Record<string, string> = { active: 'active', resolved: 'resolved', inactive: 'inactive' };

/** DrChrono verification statuses mapped onto the FHIR value set. */
const CONDITION_VERIFICATION_MAP: Record<string, string> = {
  confirmed: 'confirmed',
  provisional: 'provisional',
  differential: 'differential',
  refuted: 'refuted',
  'entered-in-error': 'entered-in-error',
};

/**
 * Map a DrChrono problem onto a Condition.
 * @param p - The DrChrono problem payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param encounters - DrChrono appointment id to Encounter reference.
 * @returns The Condition resource.
 */
function mapCondition(
  p: DrProblem,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  encounters: Map<string, Reference<Encounter>>
): Condition {
  const icdCode = p.icd10_code || p.icd_code;
  // These rows come from /problems, so problem-list-item is the right default;
  // only an explicit encounter-diagnosis from DrChrono overrides it.
  const categoryCode = p.category === 'encounter-diagnosis' ? 'encounter-diagnosis' : 'problem-list-item';
  return {
    resourceType: 'Condition',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.condition, value: String(p.id) }],
    subject: patient,
    encounter: p.appointment ? lookup(encounters, p.appointment) : undefined,
    clinicalStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
          code: CONDITION_STATUS_MAP[p.status?.toLowerCase() ?? ''] ?? 'active',
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
          code: CONDITION_VERIFICATION_MAP[p.verification_status?.toLowerCase() ?? ''] ?? 'confirmed',
        },
      ],
    },
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/condition-category',
            code: categoryCode,
            display: categoryCode === 'encounter-diagnosis' ? 'Encounter Diagnosis' : 'Problem List Item',
          },
        ],
      },
    ],
    code: {
      coding: [
        ...(icdCode ? [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: icdCode, display: p.name }] : []),
        ...(p.snomed_ct_code ? [{ system: 'http://snomed.info/sct', code: p.snomed_ct_code, display: p.name }] : []),
      ],
      text: p.name || p.description || icdCode || 'Unknown Condition',
    },
    onsetDateTime: p.date_onset || undefined,
    recordedDate: p.date_diagnosis || p.date_changed || undefined,
    abatementDateTime: p.date_resolved || p.abatement_date || undefined,
    note: p.notes ? [{ text: p.notes }] : undefined,
  };
}

// ─── Procedure ───────────────────────────────────────────────────────────────

/** DrChrono procedure statuses mapped onto the FHIR value set. */
const PROCEDURE_STATUS_MAP: Record<string, Procedure['status']> = {
  completed: 'completed',
  'in progress': 'in-progress',
  'in-progress': 'in-progress',
  stopped: 'stopped',
  cancelled: 'stopped',
  canceled: 'stopped',
};

/**
 * Map a DrChrono procedure onto a Procedure.
 * @param p - The DrChrono procedure payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param practitioners - DrChrono doctor id to Practitioner reference.
 * @param encounters - DrChrono appointment id to Encounter reference.
 * @returns The Procedure resource.
 */
function mapProcedure(
  p: DrProcedure,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  practitioners: Map<string, Reference<Practitioner>>,
  encounters: Map<string, Reference<Encounter>>
): Procedure {
  const performer = p.doctor ? lookup(practitioners, p.doctor) : undefined;
  return {
    resourceType: 'Procedure',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.procedure, value: String(p.id) }],
    status: PROCEDURE_STATUS_MAP[(p.status ?? '').toLowerCase()] ?? 'unknown',
    subject: patient,
    encounter: p.appointment ? lookup(encounters, p.appointment) : undefined,
    code: {
      coding: p.code ? [{ system: 'http://www.ama-assn.org/go/cpt', code: p.code, display: p.description }] : [],
      text: p.description || (p.code ? `CPT ${p.code}` : 'Unknown procedure'),
    },
    performedDateTime: p.date || undefined,
    performer: performer ? [{ actor: performer }] : undefined,
  };
}

// ─── Scheduling: Slot, Appointment, Encounter ────────────────────────────────

/** DrChrono appointment statuses mapped onto Encounter status. */
const ENCOUNTER_STATUS_MAP: Record<string, Encounter['status']> = {
  Complete: 'finished',
  Arrived: 'arrived',
  'In Session': 'in-progress',
  Scheduled: 'planned',
  Confirmed: 'planned',
  'Not Confirmed': 'planned',
  Cancelled: 'cancelled',
  'No Show': 'cancelled',
};

/** DrChrono appointment statuses mapped onto Slot status. */
const SLOT_STATUS_MAP: Record<string, Slot['status']> = {
  Complete: 'busy',
  'NOTE COMPLETE': 'busy',
  Arrived: 'busy',
  'Checked In': 'busy',
  'In Room': 'busy',
  'In Session': 'busy',
  Scheduled: 'busy-tentative',
  Confirmed: 'busy-tentative',
  'Not Confirmed': 'busy-tentative',
  Cancelled: 'free',
  Rescheduled: 'free',
  'No Show': 'free',
};

/**
 * DrChrono appointment statuses mapped onto Appointment status.
 *
 * Two of these are easy to miss and were, which left 8 of the pilot patient's
 * 17 visits reported as still "booked":
 *
 *   NOTE COMPLETE — the visit happened and its note is signed. This is the
 *     status a finished visit actually ends up in for practices that sign
 *     notes, so treating it as anything other than `fulfilled` understates
 *     every completed appointment.
 *   Rescheduled — this slot did not happen; a different appointment replaced
 *     it. FHIR has no "rescheduled", and `cancelled` is the honest reading.
 *     It also matches how the bulk-import preview already treats it.
 *
 * Anything unmapped falls back to `booked` and is reported by
 * {@link warnOnUnmappedStatuses}, because DrChrono lets a practice define its
 * own statuses and a silent fallback turns that into wrong data rather than a
 * visible gap.
 */
const APPOINTMENT_STATUS_MAP: Record<string, Appointment['status']> = {
  Complete: 'fulfilled',
  'NOTE COMPLETE': 'fulfilled',
  Arrived: 'arrived',
  'Checked In': 'checked-in',
  'In Room': 'arrived',
  'In Session': 'arrived',
  Scheduled: 'booked',
  Confirmed: 'booked',
  Cancelled: 'cancelled',
  Rescheduled: 'cancelled',
  'No Show': 'noshow',
  'Not Confirmed': 'pending',
};

/**
 * Log any DrChrono status this importer has no mapping for.
 *
 * A practice can define its own appointment statuses, so the map can never be
 * exhaustive. Reporting the distinct unknown values once per import makes a
 * new one a one-line fix instead of a silent drift to `booked`.
 * @param appointments - The appointments about to be written.
 */
function warnOnUnmappedStatuses(appointments: DrAppointment[]): void {
  const unknown = new Set<string>();
  for (const a of appointments) {
    const status = a.status ?? '';
    if (status && !(status in APPOINTMENT_STATUS_MAP)) {
      unknown.add(status);
    }
  }
  if (unknown.size > 0) {
    log(`unmapped DrChrono appointment status(es), defaulted to "booked": ${[...unknown].join(', ')}`);
  }
}

/**
 * The zone DrChrono's naive timestamps are wall-clock in, when the record
 * itself does not say.
 *
 * DrChrono reports a `timezone` per doctor — this practice has 11 on
 * `US/Pacific` and 2 on `US/Eastern` — so an appointment with a known doctor
 * uses theirs. This is the fallback for the rest, and for a practice whose
 * doctors report nothing.
 */
const DEFAULT_PRACTICE_TIME_ZONE = 'US/Pacific';

/**
 * The zone DrChrono's naive timestamps are wall-clock in for this practice.
 *
 * Deliberately a practice-wide value rather than the individual provider's.
 * DrChrono reports a `timezone` per doctor, and using it looked more precise
 * until it was tested: this practice has two doctors set to `US/Eastern`, and
 * their clinics are in Anaheim. A 9:30am visit at Anaheim Main Office came out
 * as 6:30am Pacific, because the provider's account setting is where *they*
 * are, not where the visit is. `scheduled_time` is the clinic's wall clock.
 *
 * Offices carry no zone of their own, so the practice zone is taken as the
 * most common one across its providers — the eleven Californian doctors
 * outvote the two remote ones — falling back to Pacific when nothing is set.
 * @param zones - Doctor id to IANA zone, collected from the directory.
 * @returns The zone to read every naive timestamp in.
 */
function practiceZone(zones: Map<string, string>): string {
  const tally = new Map<string, number>();
  for (const zone of zones.values()) {
    tally.set(zone, (tally.get(zone) ?? 0) + 1);
  }
  let best = DEFAULT_PRACTICE_TIME_ZONE;
  let bestCount = 0;
  for (const [zone, count] of tally) {
    if (count > bestCount) {
      best = zone;
      bestCount = count;
    }
  }
  return best;
}

/** DrChrono's default visit length, used when the appointment carries none. */
const DEFAULT_VISIT_MINUTES = 30;

/**
 * Map a DrChrono appointment onto the clinical Encounter.
 * @param a - The DrChrono appointment payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param practitioners - DrChrono doctor id to Practitioner reference.
 * @param locations - DrChrono office id to Location reference.
 * @param appointmentRef - The scheduling Appointment, when it was written.
 * @param timeZone - The zone the appointment's naive times are wall-clock in.
 * @returns The Encounter resource.
 */
function mapEncounter(
  a: DrAppointment,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  practitioners: Map<string, Reference<Practitioner>>,
  locations: Map<string, Reference<Location>>,
  appointmentRef: Reference<Appointment> | undefined,
  timeZone: string
): Encounter {
  const start = toInstant(a.scheduled_time, timeZone);
  const minutes = a.duration ?? DEFAULT_VISIT_MINUTES;
  const practitioner = a.doctor ? lookup(practitioners, a.doctor) : undefined;
  const location = a.office ? lookup(locations, a.office) : undefined;
  return {
    resourceType: 'Encounter',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.encounter, value: String(a.id) }],
    status: ENCOUNTER_STATUS_MAP[a.status ?? ''] ?? 'unknown',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Ambulatory' },
    subject: patient,
    appointment: appointmentRef ? [appointmentRef] : undefined,
    period: start ? { start, end: addMinutes(start, minutes) } : undefined,
    length: { value: minutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' },
    // `type` as well as `reasonCode`, from the same DrChrono `reason`.
    //
    // They answer different questions in FHIR — type is "what kind of visit",
    // reasonCode is "why" — and DrChrono has only the one free-text field for
    // both. Writing it to reasonCode alone is more literally correct and was
    // what this did, but every reader that names a visit reads `type` first:
    // Medplum's own visit list falls back to the literal word "Visit" without
    // it, so a chart of "fatty liver" and "EGD procedure results" visits
    // rendered as eleven rows all called "Visit". Populating both keeps the
    // precise meaning and gives every reader something to title the row with.
    type: a.reason ? [{ text: a.reason }] : undefined,
    reasonCode: a.reason ? [{ text: a.reason }] : undefined,
    participant: practitioner
      ? [
          {
            type: [
              {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                    code: 'PPRF',
                    display: 'primary performer',
                  },
                ],
              },
            ],
            individual: practitioner,
          },
        ]
      : undefined,
    location: location ? [{ location, status: 'active' }] : undefined,
    serviceProvider: organization,
  };
}

/**
 * Map a DrChrono appointment onto the Slot it occupies.
 * @param a - The DrChrono appointment payload.
 * @param start - The appointment start, already normalised to an instant.
 * @param schedule - The practice-wide Schedule.
 * @param organization - The calling clinic.
 * @returns The Slot resource.
 */
function mapSlot(
  a: DrAppointment,
  start: string,
  schedule: Reference<Schedule>,
  organization: Reference<Organization>
): Slot {
  return {
    resourceType: 'Slot',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.slot, value: String(a.id) }],
    schedule,
    status: SLOT_STATUS_MAP[a.status ?? ''] ?? 'busy-tentative',
    start,
    end: addMinutes(start, a.duration ?? DEFAULT_VISIT_MINUTES),
    comment: a.reason || undefined,
  };
}

/**
 * Map a DrChrono appointment onto the scheduling Appointment.
 * @param a - The DrChrono appointment payload.
 * @param start - The appointment start, already normalised to an instant.
 * @param slot - The Slot this appointment occupies.
 * @param patient - Reference to the imported patient.
 * @param practitioner - The attending provider, when known.
 * @param location - The office the visit is booked at, when known.
 * @param organization - The calling clinic.
 * @returns The Appointment resource.
 */
function mapAppointment(
  a: DrAppointment,
  start: string,
  slot: Reference<Slot>,
  patient: Reference<Patient>,
  practitioner: Reference<Practitioner> | undefined,
  location: Reference<Location> | undefined,
  organization: Reference<Organization>
): Appointment {
  const minutes = a.duration ?? DEFAULT_VISIT_MINUTES;
  return {
    resourceType: 'Appointment',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.appointment, value: String(a.id) }],
    status: APPOINTMENT_STATUS_MAP[a.status ?? ''] ?? 'booked',
    description: a.reason || 'Visit',
    slot: [slot],
    start,
    end: addMinutes(start, minutes),
    minutesDuration: minutes,
    // The office is carried as a participant actor, which is where FHIR puts
    // it and where every reader looks for it — including Medplum's own
    // scheduling views, whose Location filter is built from exactly this.
    // Putting it only on the Encounter, as this importer first did, leaves the
    // calendar unable to say where any appointment is.
    participant: [
      { actor: patient, status: 'accepted' },
      ...(practitioner ? [{ actor: practitioner, status: 'accepted' as const }] : []),
      ...(location ? [{ actor: location, status: 'accepted' as const }] : []),
    ],
    comment: joinDefined([a.reason, a.notes], '; '),
  };
}

// ─── Vitals ──────────────────────────────────────────────────────────────────

/**
 * The scalar vital signs, with the unit conversion each one needs.
 *
 * DrChrono stores whatever the practice entered, so height can arrive in cm and
 * temperature in Celsius. These are normalised to the US customary units the
 * rest of the chart uses, which keeps a trend line comparable across visits.
 */
const VITALS: {
  code: string;
  name: string;
  unit: string;
  ucum: string;
  get: (v: DrVitals) => number | null;
}[] = [
  {
    code: '8302-2',
    name: 'Body height',
    unit: 'in',
    ucum: '[in_i]',
    get: (v) => {
      if (!v.height) {
        return null;
      }
      return v.height_units?.startsWith('cm') ? Number(v.height) / 2.54 : Number(v.height);
    },
  },
  {
    code: '29463-7',
    name: 'Body weight',
    unit: 'lbs',
    ucum: '[lb_av]',
    get: (v) => {
      if (!v.weight) {
        return null;
      }
      return v.weight_units?.startsWith('kg') ? Number(v.weight) * 2.205 : Number(v.weight);
    },
  },
  {
    code: '39156-5',
    name: 'Body mass index',
    unit: 'kg/m2',
    ucum: 'kg/m2',
    get: (v) => (v.bmi ? Number(v.bmi) : null),
  },
  { code: '8867-4', name: 'Heart rate', unit: 'beats/min', ucum: '/min', get: (v) => v.pulse ?? null },
  {
    code: '8310-5',
    name: 'Body temperature',
    unit: '°F',
    ucum: '[degF]',
    get: (v) => {
      if (!v.temperature) {
        return null;
      }
      return v.temperature_units === 'C' ? (Number(v.temperature) * 9) / 5 + 32 : Number(v.temperature);
    },
  },
  {
    code: '9279-1',
    name: 'Respiratory rate',
    unit: 'breaths/min',
    ucum: '/min',
    get: (v) => v.respiratory_rate ?? null,
  },
  { code: '59408-5', name: 'Oxygen saturation', unit: '%', ucum: '%', get: (v) => v.oxygen_saturation ?? null },
];

/** The observation category every vital sign carries. */
const VITAL_SIGNS_CATEGORY = {
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/observation-category',
      code: 'vital-signs',
      display: 'Vital Signs',
    },
  ],
};

/**
 * Map one visit's vitals onto Observations.
 *
 * Blood pressure is emitted as the LOINC 55284-4 panel with systolic and
 * diastolic components rather than two loose Observations, which is what US
 * Core and every chart renderer expect.
 * @param vitals - The vitals block from the appointment.
 * @param appointmentId - DrChrono appointment id, part of each identifier.
 * @param effectiveDateTime - When the vitals were taken, as an instant.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @returns One Observation per recorded vital.
 */
function mapVitals(
  vitals: DrVitals,
  appointmentId: number,
  effectiveDateTime: string,
  patient: Reference<Patient>,
  organization: Reference<Organization>
): Observation[] {
  const out: Observation[] = [];

  for (const vital of VITALS) {
    const value = vital.get(vitals);
    if (value === null || !Number.isFinite(value)) {
      continue;
    }
    out.push({
      resourceType: 'Observation',
      meta: buildMeta(organization),
      identifier: [{ system: IDENTIFIER_SYSTEMS.observation, value: `${appointmentId}-${vital.code}` }],
      status: 'final',
      category: [VITAL_SIGNS_CATEGORY],
      code: { coding: [{ system: 'http://loinc.org', code: vital.code, display: vital.name }], text: vital.name },
      subject: patient,
      effectiveDateTime,
      valueQuantity: {
        value: Math.round(value * 100) / 100,
        unit: vital.unit,
        system: 'http://unitsofmeasure.org',
        code: vital.ucum,
      },
    });
  }

  const systolic = vitals.blood_pressure_1;
  const diastolic = vitals.blood_pressure_2;
  if (typeof systolic === 'number' && typeof diastolic === 'number') {
    out.push({
      resourceType: 'Observation',
      meta: buildMeta(organization),
      identifier: [{ system: IDENTIFIER_SYSTEMS.observation, value: `${appointmentId}-55284-4` }],
      status: 'final',
      category: [VITAL_SIGNS_CATEGORY],
      code: {
        coding: [{ system: 'http://loinc.org', code: '55284-4', display: 'Blood pressure systolic and diastolic' }],
        text: 'Blood Pressure',
      },
      subject: patient,
      effectiveDateTime,
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] },
          valueQuantity: { value: systolic, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
        },
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] },
          valueQuantity: { value: diastolic, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
        },
      ],
    });
  }

  return out;
}

// ─── Immunization ────────────────────────────────────────────────────────────

/** DrChrono vaccine statuses mapped onto the FHIR value set. */
const IMMUNIZATION_STATUS_MAP: Record<string, Immunization['status']> = {
  administered: 'completed',
  completed: 'completed',
  'not given': 'not-done',
  'not-administered': 'not-done',
};

/**
 * Map a DrChrono vaccine record onto an Immunization.
 * @param i - The DrChrono vaccine payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param practitioners - DrChrono doctor id to Practitioner reference.
 * @returns The Immunization resource.
 */
function mapImmunization(
  i: DrImmunization,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  practitioners: Map<string, Reference<Practitioner>>
): Immunization {
  const display = i.vaccine_name || i.name || 'Vaccine';
  const performer = i.doctor ? lookup(practitioners, i.doctor) : undefined;
  const doseValue = i.dose ? parseFloat(i.dose) : Number.NaN;
  const immunizationNote = joinDefined([i.notes, i.reaction ? `Reaction: ${i.reaction}` : undefined], '; ');
  return {
    resourceType: 'Immunization',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.immunization, value: String(i.id) }],
    status: IMMUNIZATION_STATUS_MAP[(i.status || 'completed').toLowerCase()] ?? 'completed',
    vaccineCode: {
      coding: [
        ...(i.cvx_code ? [{ system: 'http://hl7.org/fhir/sid/cvx', code: i.cvx_code, display }] : []),
        ...(i.ndc_code ? [{ system: 'http://hl7.org/fhir/sid/ndc', code: i.ndc_code, display }] : []),
      ],
      text: display,
    },
    patient,
    occurrenceDateTime: i.administered_date || i.administration_date,
    lotNumber: i.lot_number,
    expirationDate: i.expiration_date,
    manufacturer: i.manufacturer ? { display: i.manufacturer } : undefined,
    site: i.site ? { text: i.site } : undefined,
    route: i.route ? { text: i.route } : undefined,
    doseQuantity: Number.isFinite(doseValue)
      ? { value: doseValue, unit: i.dose_units || 'mL', system: 'http://unitsofmeasure.org' }
      : undefined,
    performer: performer ? [{ actor: performer }] : undefined,
    note: immunizationNote ? [{ text: immunizationNote }] : undefined,
    statusReason: i.reason_not_given ? { text: i.reason_not_given } : undefined,
  };
}

// ─── Labs ────────────────────────────────────────────────────────────────────

/** DrChrono lab order statuses mapped onto ServiceRequest status. */
const LAB_ORDER_STATUS_MAP: Record<string, ServiceRequest['status']> = {
  pending: 'active',
  sent: 'active',
  received: 'completed',
  completed: 'completed',
  cancelled: 'revoked',
  canceled: 'revoked',
};

/** DrChrono lab priorities mapped onto ServiceRequest priority. */
const LAB_PRIORITY_MAP: Record<string, ServiceRequest['priority']> = {
  routine: 'routine',
  urgent: 'urgent',
  asap: 'asap',
  stat: 'stat',
};

/** DrChrono lab result statuses mapped onto DiagnosticReport status. */
const LAB_REPORT_STATUS_MAP: Record<string, DiagnosticReport['status']> = {
  final: 'final',
  preliminary: 'preliminary',
  amended: 'amended',
  corrected: 'corrected',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/**
 * Map a DrChrono lab order onto a ServiceRequest.
 * @param l - The DrChrono lab order payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param practitioners - DrChrono doctor id to Practitioner reference.
 * @param encounters - DrChrono appointment id to Encounter reference.
 * @returns The ServiceRequest resource.
 */
function mapLabOrder(
  l: DrLabOrder,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  practitioners: Map<string, Reference<Practitioner>>,
  encounters: Map<string, Reference<Encounter>>
): ServiceRequest {
  return {
    resourceType: 'ServiceRequest',
    meta: buildMeta(organization),
    identifier: [
      { system: IDENTIFIER_SYSTEMS.labOrder, value: String(l.id) },
      ...(l.accession_number ? [{ system: IDENTIFIER_SYSTEMS.labAccession, value: l.accession_number }] : []),
      ...(l.requisition_id ? [{ system: IDENTIFIER_SYSTEMS.labRequisition, value: l.requisition_id }] : []),
    ],
    status: LAB_ORDER_STATUS_MAP[(l.status || 'active').toLowerCase()] ?? 'active',
    intent: 'order',
    category: [
      {
        coding: [{ system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory procedure' }],
        text: 'Laboratory',
      },
    ],
    priority: LAB_PRIORITY_MAP[(l.priority || 'routine').toLowerCase()] ?? 'routine',
    subject: patient,
    encounter: l.appointment ? lookup(encounters, l.appointment) : undefined,
    requester: l.doctor ? lookup(practitioners, l.doctor) : undefined,
    authoredOn: l.timestamp || l.created_at,
    reasonCode: l.icd10_codes?.length
      ? l.icd10_codes.map((code) => ({ coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code }] }))
      : undefined,
    note: l.notes ? [{ text: l.notes }] : undefined,
  };
}

/**
 * Build the `value[x]` for a lab Observation.
 *
 * A numeric result becomes a Quantity so it is trendable and comparable against
 * its reference range; anything else is kept verbatim as a string rather than
 * coerced to NaN.
 * @param value - The raw DrChrono result value.
 * @param unit - The result unit, if any.
 * @returns A partial Observation carrying exactly one `value[x]`, or nothing.
 */
function labObservationValue(value: string | undefined, unit: string): Partial<Observation> {
  if (!value) {
    return {};
  }
  const numeric = parseFloat(value);
  if (Number.isFinite(numeric)) {
    return { valueQuantity: { value: numeric, unit, system: 'http://unitsofmeasure.org' } };
  }
  return { valueString: value };
}

/**
 * Derive the HL7 interpretation code for a lab result.
 * @param r - The DrChrono lab result payload.
 * @returns The interpretation coding, or undefined when the result is normal.
 */
function labInterpretation(r: DrLabResult): Observation['interpretation'] {
  const isHigh = r.abnormal_flag === 'H' || r.abnormal_status?.toLowerCase() === 'high';
  const isLow = r.abnormal_flag === 'L' || r.abnormal_status?.toLowerCase() === 'low';
  if (!r.is_abnormal && !isHigh && !isLow) {
    return undefined;
  }
  let code = 'A';
  let display = 'Abnormal';
  if (isHigh) {
    code = 'H';
    display = 'High';
  } else if (isLow) {
    code = 'L';
    display = 'Low';
  }
  return [
    { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code, display }] },
  ];
}

/**
 * Map a DrChrono lab result onto an Observation.
 * @param r - The DrChrono lab result payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @returns The Observation resource.
 */
function mapLabObservation(
  r: DrLabResult,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  timeZone: string
): Observation {
  const display = r.test_name || r.observation_description || 'Lab Test';
  return {
    resourceType: 'Observation',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.labObservation, value: String(r.id) }],
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'laboratory',
            display: 'Laboratory',
          },
        ],
      },
    ],
    code: {
      coding: [
        ...(r.loinc_code ? [{ system: 'http://loinc.org', code: r.loinc_code, display }] : []),
        ...(r.test_code ? [{ system: IDENTIFIER_SYSTEMS.labTestCode, code: r.test_code, display }] : []),
      ],
      text: display,
    },
    subject: patient,
    effectiveDateTime: r.date_collected || r.date_resulted,
    issued: toInstant(r.date_resulted, timeZone),
    ...labObservationValue(r.value || r.result_value, r.units || r.result_units || ''),
    referenceRange: r.reference_range || r.normal_range ? [{ text: r.reference_range || r.normal_range }] : undefined,
    interpretation: labInterpretation(r),
    note: r.comments ? [{ text: r.comments }] : undefined,
  };
}

/**
 * Map a DrChrono lab result onto a DiagnosticReport.
 *
 * DrChrono returns one row per analyte rather than one per panel, so this is a
 * report per result. That mirrors the source system exactly, which is what keeps
 * the identifier stable across re-imports.
 * @param r - The DrChrono lab result payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param labOrders - DrChrono lab order id to ServiceRequest reference.
 * @param results - Observations this report summarises.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @returns The DiagnosticReport resource.
 */
function mapLabReport(
  r: DrLabResult,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  labOrders: Map<string, Reference<ServiceRequest>>,
  results: Reference<Observation>[],
  timeZone: string
): DiagnosticReport {
  const display = r.test_name || r.observation_description || 'Lab Test';
  const basedOn = lookup(labOrders, r.lab_order);
  return {
    resourceType: 'DiagnosticReport',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.labReport, value: String(r.id) }],
    status: LAB_REPORT_STATUS_MAP[(r.status || 'final').toLowerCase()] ?? 'final',
    category: [
      { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] },
    ],
    code: {
      coding: [
        ...(r.loinc_code ? [{ system: 'http://loinc.org', code: r.loinc_code, display }] : []),
        ...(r.test_code ? [{ system: IDENTIFIER_SYSTEMS.labTestCode, code: r.test_code, display }] : []),
      ],
      text: display,
    },
    subject: patient,
    effectiveDateTime: r.date_collected || r.date_resulted,
    issued: toInstant(r.date_resulted, timeZone),
    basedOn: basedOn ? [basedOn] : undefined,
    result: results.length > 0 ? results : undefined,
    conclusion: r.comments || undefined,
  };
}

/**
 * Map a DrChrono lab document onto a DocumentReference.
 *
 * Two attachments where both are available: the PDF by reference, because
 * re-uploading multi-megabyte binaries on every run is wasteful when DrChrono
 * already hosts them; and the raw HL7 v2 message inline as base64, because that
 * is the only machine-readable copy of the result when `/lab_results` is
 * unusable for the practice. A later pass can parse its OBX segments without
 * going back to DrChrono.
 * @param d - The DrChrono lab document payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param labOrders - DrChrono lab order id to ServiceRequest reference.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @param file - The PDF re-hosted in Medplum, when it could be copied; otherwise DrChrono's link is kept.
 * @returns The DocumentReference resource.
 */
function mapLabDocument(
  d: DrLabDocument,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  labOrders: Map<string, Reference<ServiceRequest>>,
  timeZone: string,
  file?: Attachment
): DocumentReference {
  const isResult = (d.type ?? '').toUpperCase() === 'RES';
  const typeCode = isResult
    ? { system: 'http://loinc.org', code: '11502-2', display: 'Laboratory report' }
    : { system: 'http://loinc.org', code: '11488-4', display: 'Consultation note' };
  const labOrder = lookup(labOrders, d.lab_order);
  const date = toInstant(d.timestamp, timeZone);
  return {
    resourceType: 'DocumentReference',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.labDocument, value: String(d.id) }],
    status: 'current',
    docStatus: isResult ? 'final' : 'preliminary',
    type: { coding: [typeCode], text: isResult ? 'Lab Result Report' : 'Lab Requisition' },
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            code: isResult ? 'LAB' : 'ORD',
            display: isResult ? 'Laboratory' : 'Order',
          },
        ],
      },
    ],
    subject: patient,
    date,
    custodian: organization,
    context: labOrder ? { related: [labOrder] } : undefined,
    content: [
      ...(d.document
        ? [
            {
              attachment: {
                contentType: 'application/pdf',
                url: d.document,
                ...file,
                title: isResult ? `Lab Result ${date?.slice(0, 10) ?? ''}`.trim() : 'Lab Requisition',
              },
            },
          ]
        : []),
      ...(d.hl7
        ? [
            {
              attachment: {
                contentType: 'application/x-hl7-v2+er7',
                data: NodeBuffer.from(d.hl7).toString('base64'),
                title: 'HL7 v2 ORU result',
              },
              format: {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0529',
                code: 'urn:ihe:lab:lri-hl7v2',
                display: 'HL7 v2 Lab Result',
              },
            },
          ]
        : []),
    ],
  };
}

// ─── Documents, family and social history, messages, tasks ───────────────────

/**
 * Map a DrChrono chart document onto a DocumentReference.
 * @param d - The DrChrono document payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @param file - The file re-hosted in Medplum, when it could be copied. Otherwise DrChrono's link is
 *   kept, typed from its name where possible, so the document still lists and can be retried.
 * @returns The DocumentReference resource.
 */
function mapDocument(
  d: DrDocument,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  timeZone: string,
  file?: Attachment
): DocumentReference {
  const title = d.description || 'Document';
  return {
    resourceType: 'DocumentReference',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.document, value: String(d.id) }],
    status: 'current',
    subject: patient,
    date: toInstant(d.date, timeZone),
    description: d.description || undefined,
    custodian: organization,
    category: d.metatags?.length ? [{ text: d.metatags.join(', ') }] : undefined,
    content: [
      {
        attachment: file
          ? { ...file, title }
          : {
              contentType: contentTypeFromName(d.description) ?? contentTypeFromName(d.document),
              url: d.document,
              title,
            },
      },
    ],
  };
}

/** HL7 v3 RoleCode values for the family relationships DrChrono records. */
const FAMILY_RELATIONSHIP_MAP: Record<string, { code: string; display: string }> = {
  mother: { code: 'MTH', display: 'Mother' },
  father: { code: 'FTH', display: 'Father' },
  brother: { code: 'BRO', display: 'Brother' },
  sister: { code: 'SIS', display: 'Sister' },
  son: { code: 'SON', display: 'Son' },
  daughter: { code: 'DAU', display: 'Daughter' },
  grandfather: { code: 'GRFTH', display: 'Grandfather' },
  grandmother: { code: 'GRMTH', display: 'Grandmother' },
  aunt: { code: 'AUNT', display: 'Aunt' },
  uncle: { code: 'UNCLE', display: 'Uncle' },
};

/**
 * Map a DrChrono family history row onto a FamilyMemberHistory.
 * @param f - The DrChrono family history payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @returns The FamilyMemberHistory resource.
 */
function mapFamilyMemberHistory(
  f: DrFamilyHistory,
  patient: Reference<Patient>,
  organization: Reference<Organization>
): FamilyMemberHistory {
  const rel = f.relationship ? FAMILY_RELATIONSHIP_MAP[f.relationship.toLowerCase()] : undefined;
  return {
    resourceType: 'FamilyMemberHistory',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.familyHistory, value: String(f.id) }],
    status: 'completed',
    patient,
    name: f.member_name,
    relationship: rel
      ? {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: rel.code, display: rel.display },
          ],
          text: f.relationship,
        }
      : { text: f.relationship || 'Unknown' },
    condition: f.condition
      ? [
          {
            code: {
              coding: f.icd10_code
                ? [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: f.icd10_code, display: f.condition }]
                : [],
              text: f.condition,
            },
            onsetString: f.date_of_onset,
            note: f.notes ? [{ text: f.notes }] : undefined,
          },
        ]
      : undefined,
  };
}

/**
 * Map a DrChrono social history row onto one Observation per recorded topic.
 *
 * Smoking status is the one that matters for quality measures, so it carries the
 * LOINC code and the SNOMED answer coding when DrChrono supplies one.
 * @param s - The DrChrono social history payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @returns Zero, one or two Observations.
 */
function mapSocialHistory(
  s: DrSocialHistory,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  timeZone: string
): Observation[] {
  const category = {
    coding: [
      {
        system: 'http://terminology.hl7.org/CodeSystem/observation-category',
        code: 'social-history',
        display: 'Social History',
      },
    ],
  };
  const effectiveDateTime = toInstant(s.recorded_date, timeZone) ?? new Date().toISOString();
  const out: Observation[] = [];

  if (s.smoking_status) {
    out.push({
      resourceType: 'Observation',
      meta: buildMeta(organization),
      identifier: [{ system: IDENTIFIER_SYSTEMS.socialHistory, value: `${s.id}-smoking` }],
      status: 'final',
      category: [category],
      code: {
        coding: [{ system: 'http://loinc.org', code: '72166-2', display: 'Tobacco smoking status' }],
        text: 'Smoking Status',
      },
      subject: patient,
      effectiveDateTime,
      valueCodeableConcept: {
        coding: s.smoking_status_code
          ? [{ system: 'http://snomed.info/sct', code: s.smoking_status_code, display: s.smoking_status }]
          : [],
        text: s.smoking_status,
      },
    });
  }

  if (s.alcohol_use) {
    out.push({
      resourceType: 'Observation',
      meta: buildMeta(organization),
      identifier: [{ system: IDENTIFIER_SYSTEMS.socialHistory, value: `${s.id}-alcohol` }],
      status: 'final',
      category: [category],
      code: {
        coding: [{ system: 'http://loinc.org', code: '11331-6', display: 'Alcohol use [Reported]' }],
        text: 'Alcohol Use',
      },
      subject: patient,
      effectiveDateTime,
      valueString: s.alcohol_use,
    });
  }

  return out;
}

/**
 * Map a DrChrono inbox message onto a Communication.
 * @param m - The DrChrono message payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @returns The Communication resource.
 */
function mapCommunication(
  m: DrMessage,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  timeZone: string
): Communication {
  // FHIR has no "unread" status; an unread message is one still in progress.
  const status: Communication['status'] = m.archived || m.read ? 'completed' : 'in-progress';
  return {
    resourceType: 'Communication',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.communication, value: String(m.id) }],
    status,
    subject: patient,
    sent: toInstant(m.received_at, timeZone),
    received: m.read ? toInstant(m.updated_at, timeZone) : undefined,
    category: m.type
      ? [{ coding: [{ system: IDENTIFIER_SYSTEMS.messageType, code: m.type, display: m.type }] }]
      : undefined,
    payload: m.title ? [{ contentString: m.title }] : undefined,
  };
}

/**
 * Map a DrChrono task onto a FHIR Task.
 *
 * DrChrono's `status` is a numeric foreign key into a per-practice TaskStatus
 * table, so without a second lookup there is no way to tell open from done.
 * `requested` is the safe answer: it never marks outstanding work as finished.
 * @param t - The DrChrono task payload.
 * @param patient - Reference to the imported patient.
 * @param organization - The calling clinic.
 * @param practitioners - DrChrono doctor id to Practitioner reference.
 * @param encounters - DrChrono appointment id to Encounter reference.
 * @param timeZone - The zone naive DrChrono timestamps are wall-clock in.
 * @returns The Task resource.
 */
function mapDrTask(
  t: DrTask,
  patient: Reference<Patient>,
  organization: Reference<Organization>,
  practitioners: Map<string, Reference<Practitioner>>,
  encounters: Map<string, Reference<Encounter>>,
  timeZone: string
): Task {
  const appointmentLink = t.associated_items?.find((a) => a.type === 'appointment');
  return {
    resourceType: 'Task',
    meta: buildMeta(organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.task, value: String(t.id) }],
    status: 'requested',
    intent: 'order',
    description: t.title || t.notes || `DrChrono task ${t.id}`,
    for: patient,
    encounter: appointmentLink ? lookup(encounters, appointmentLink.value) : undefined,
    owner: t.assignee ? lookup(practitioners, t.assignee) : undefined,
    authoredOn: toInstant(t.created_at, timeZone),
    restriction: t.due_date ? { period: { end: t.due_date } } : undefined,
    note: t.notes && t.notes !== t.title ? [{ text: t.notes }] : undefined,
  };
}

// ─── Provenance and AuditEvent ───────────────────────────────────────────────

/**
 * Build a Provenance linking a group of resources back to this import run.
 *
 * Provenance answers "where did this row come from", which for imported PHI is
 * the difference between a chart a clinician can act on and one they cannot
 * trust. One per resource type is the conventional granularity.
 * @param targets - The resources this Provenance covers.
 * @param organization - The calling clinic.
 * @param taskId - The tracking Task for this run.
 * @param drchronoPatientId - The source patient in DrChrono.
 * @returns The Provenance resource.
 */
function buildProvenance(
  targets: Reference[],
  organization: Reference<Organization>,
  taskId: string,
  drchronoPatientId: string
): Provenance {
  return {
    resourceType: 'Provenance',
    meta: buildMeta(organization),
    target: targets,
    recorded: new Date().toISOString(),
    activity: {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
          code: 'CREATE',
          display: 'create',
        },
      ],
    },
    agent: [
      {
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
              code: 'assembler',
              display: 'Assembler',
            },
          ],
        },
        who: {
          display: 'Lyfe DrChrono import bot',
          identifier: { system: IDENTIFIER_SYSTEMS.agent, value: 'drchrono-import' },
        },
        onBehalfOf: organization,
      },
    ],
    entity: [
      {
        role: 'source',
        what: {
          identifier: { system: IDENTIFIER_SYSTEMS.patient, value: drchronoPatientId },
          display: `DrChrono Patient ${drchronoPatientId}`,
        },
      },
      { role: 'derivation', what: { reference: `Task/${taskId}` } },
    ],
  };
}

/**
 * Build the AuditEvent for the import operation itself.
 *
 * Distinct from Provenance on purpose: Provenance says who created a resource,
 * AuditEvent says the operation happened at all — including when it failed,
 * which is the case Provenance cannot record because nothing was created. That
 * is what 45 CFR 164.312(b) asks for.
 * @param organization - The calling clinic.
 * @param taskId - The tracking Task for this run.
 * @param drchronoPatientId - The source patient in DrChrono.
 * @param medplumPatientId - The imported Patient, or `unknown` on an early failure.
 * @param counts - Per-resource-type write tallies.
 * @param outcome - FHIR audit outcome: 0 success, 4 minor, 8 serious, 12 major.
 * @param outcomeDesc - Human-readable summary.
 * @returns The AuditEvent resource.
 */
function buildAuditEvent(
  organization: Reference<Organization>,
  taskId: string,
  drchronoPatientId: string,
  medplumPatientId: string,
  counts: ImportCounts,
  outcome: '0' | '4' | '8' | '12',
  outcomeDesc: string
): AuditEvent {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return {
    resourceType: 'AuditEvent',
    meta: buildMeta(organization),
    type: {
      system: 'http://terminology.hl7.org/CodeSystem/audit-event-type',
      code: 'rest',
      display: 'RESTful Operation',
    },
    subtype: [{ system: 'http://hl7.org/fhir/restful-interaction', code: 'transaction', display: 'transaction' }],
    action: 'C',
    recorded: new Date().toISOString(),
    outcome,
    outcomeDesc,
    agent: [
      {
        type: {
          coding: [
            { system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110153', display: 'Source Role ID' },
          ],
        },
        who: {
          display: 'Lyfe DrChrono import bot',
          identifier: { system: IDENTIFIER_SYSTEMS.agent, value: 'drchrono-import' },
        },
        requestor: false,
      },
    ],
    source: {
      site: 'lyfe-medplum-provider',
      observer: { display: 'Lyfe DrChrono import bot' },
      type: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/security-source-type',
          code: '4',
          display: 'Application Server',
        },
      ],
    },
    entity: [
      {
        what: { reference: `Patient/${medplumPatientId}` },
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type', code: '1', display: 'Person' },
        role: { system: 'http://terminology.hl7.org/CodeSystem/object-role', code: '1', display: 'Patient' },
      },
      {
        what: { reference: `Task/${taskId}` },
        type: {
          system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type',
          code: '2',
          display: 'System Object',
        },
      },
      {
        what: { identifier: { system: IDENTIFIER_SYSTEMS.patient, value: drchronoPatientId } },
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type', code: '4', display: 'Other' },
        description: `Imported ${total} resources from DrChrono`,
        detail: Object.entries(counts).map(([type, value]) => ({ type, valueString: String(value) })),
      },
    ],
  };
}

// ─── Import steps ────────────────────────────────────────────────────────────

/** Everything the per-step helpers need, threaded through in one object. */
interface ImportContext {
  /** Bot-scoped Medplum client. */
  medplum: MedplumClient;
  /** Clinic-scoped DrChrono client. */
  client: DrChronoClient;
  /** The calling clinic. */
  organization: Reference<Organization>;
  /** DrChrono's id for the patient being imported. */
  drchronoPatientId: string;
  /** Running tallies, mutated in place by each step. */
  counts: ImportCounts;
  /** DrChrono doctor id to Practitioner reference. */
  practitioners: Map<string, Reference<Practitioner>>;
  /** DrChrono doctor id to their IANA time zone, for reading naive timestamps. */
  doctorTimeZones: Map<string, string>;
  /**
   * The zone every naive DrChrono timestamp is wall-clock in.
   *
   * Resolved once from the practice's providers and carried on the context so
   * no mapper has to fall back to a hardcoded default. Every timestamp
   * DrChrono returns is naive — `"2024-04-23T18:57:41"`, no offset — so this
   * applies to documents, labs, messages and tasks, not just appointments.
   */
  timeZone: string;
  /** DrChrono office id to Location reference. */
  locations: Map<string, Reference<Location>>;
  /** DrChrono office ids the clinic has switched off. */
  disabledOffices: Set<number>;
  /** DrChrono provider ids the clinic has switched off. */
  disabledDoctors: Set<number>;
  /** DrChrono appointment id to Encounter reference. */
  encounters: Map<string, Reference<Encounter>>;
  /** DrChrono lab order id to ServiceRequest reference. */
  labOrders: Map<string, Reference<ServiceRequest>>;
  /** Written resource references, grouped by type, for Provenance. */
  refsByType: Map<string, Reference[]>;
  /** Per-run RxNorm memo. */
  rxNormCache: Map<string, string>;
}

/**
 * Record a written resource so it ends up on a Provenance.
 * @param ctx - The import context.
 * @param resourceType - FHIR type of the written resource.
 * @param ids - Ids from a batch result; nulls are skipped.
 */
function trackRefs(ctx: ImportContext, resourceType: string, ids: (string | null)[]): void {
  const list = ctx.refsByType.get(resourceType) ?? [];
  for (const id of ids) {
    if (id) {
      list.push({ reference: `${resourceType}/${id}` });
    }
  }
  ctx.refsByType.set(resourceType, list);
}

/**
 * Log a progress line with a timestamp, matching the original importer's format.
 * @param message - What happened.
 */
/**
 * Key a cross-reference map by a DrChrono id.
 *
 * Every map in this importer is keyed by an id out of DrChrono's JSON, and
 * DrChrono is not consistent about the type: an appointment's own `id` arrives
 * as the STRING "306503074", while the `appointment` field pointing at it from
 * a procedure, problem or medication arrives as the NUMBER 306503074.
 * TypeScript cannot see this — both are declared `number` — so
 * `encounters.get(procedure.appointment)` compiled, ran, and returned
 * undefined every time.
 *
 * The damage was invisible. The import reported success and wrote every
 * resource; each one was simply unlinked from the visit it belonged to, so the
 * chart looked complete while nothing joined up. Folding both sides through
 * `String()` removes the class of bug rather than the instance, which matters
 * because there are nine of these lookups.
 * @param id - A DrChrono id, however its JSON happened to type it.
 * @returns The id as a string, or undefined when there is none.
 */
function refKey(id: string | number | null | undefined): string | undefined {
  return id === null || id === undefined || id === '' ? undefined : String(id);
}

/**
 * Resolve a reference by DrChrono id, normalising the key.
 * @param map - The cross-reference map.
 * @param id - The DrChrono id to resolve.
 * @returns The reference, or undefined when absent.
 */
function lookup<T>(map: Map<string, T>, id: string | number | null | undefined): T | undefined {
  const key = refKey(id);
  return key === undefined ? undefined : map.get(key);
}

function log(message: string): void {
  console.log(`[drchrono-import] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

/**
 * Import the practice-wide providers and offices.
 *
 * These are not patient-scoped, but every clinical resource references them, so
 * they are loaded first. Re-importing is cheap because the upsert is conditional.
 * @param ctx - The import context.
 */
async function importPractice(ctx: ImportContext): Promise<void> {
  const result = await syncDirectoryResources(ctx.medplum, ctx.client, ctx.organization);

  for (const [drId, ref] of result.practitionerRefs) {
    ctx.practitioners.set(String(drId), ref);
  }
  ctx.counts.practitioners = result.practitionerWrote;
  trackRefs(ctx, 'Practitioner', result.practitionerIds);

  for (const [drId, ref] of result.locationRefs) {
    ctx.locations.set(String(drId), ref);
  }
  ctx.counts.locations = result.locationWrote;
  trackRefs(ctx, 'Location', result.locationIds);

  for (const [drId, zone] of result.doctorTimeZones) {
    ctx.doctorTimeZones.set(drId, zone);
  }
  ctx.timeZone = practiceZone(ctx.doctorTimeZones);

  ctx.disabledOffices = result.disabledOfficeIds;
  ctx.disabledDoctors = result.disabledDoctorIds;
}

/** What one directory sync wrote, and the references it resolved. */
interface DirectorySyncResult {
  practitionerWrote: number;
  locationWrote: number;
  practitionerIds: (string | null)[];
  locationIds: (string | null)[];
  /** DrChrono doctor id to IANA time zone. */
  doctorTimeZones: Map<string, string>;
  practitionerRefs: Map<string, Reference<Practitioner>>;
  locationRefs: Map<string, Reference<Location>>;
  /** How many of each are switched off, for the caller to report. */
  disabledPractitioners: number;
  disabledLocations: number;
  /** The switched-off DrChrono ids themselves, for filtering appointments. */
  disabledOfficeIds: Set<number>;
  disabledDoctorIds: Set<number>;
}

/**
 * Pull the practice directory from DrChrono and upsert it into Medplum.
 *
 * Shared by the chart importer (which needs the references to attribute
 * encounters) and by the `syncDirectory` action (which the Directory page
 * calls to refresh the list). Both must go through here, because both write
 * the same resources by conditional PUT and so both can destroy an operator's
 * enable/disable choices.
 *
 * Enablement is read back before writing and merged in `mergeEnabled`, so a
 * re-pull leaves every toggle exactly where the operator left it. Getting this
 * wrong is not a visible failure: the import succeeds, and a disabled office
 * quietly starts pulling appointments again.
 * @param medplum - Bot-scoped Medplum client.
 * @param client - Clinic-scoped DrChrono client.
 * @param organization - The calling clinic.
 * @returns What was written, plus resolved references by DrChrono id.
 */
async function syncDirectoryResources(
  medplum: MedplumClient,
  client: DrChronoClient,
  organization: Reference<Organization>
): Promise<DirectorySyncResult> {
  log('directory: reading current enablement');
  const existing = await readDirectoryState(medplum, organization);
  log(`directory: ${existing.practitioners.size} known providers, ${existing.locations.size} known offices`);

  const doctors = await drchronoOptional<DrDoctor>(client, '/doctors');
  log(`${doctors.length} doctors fetched`);
  const doctorEnabled = doctors.map((d) =>
    mergeEnabled({
      retiredUpstream: d.is_account_suspended === true,
      existing: existing.practitioners.get(String(d.id)),
    })
  );
  const doctorResult = await write(
    medplum,
    doctors.map((d, i) => ({
      resourceType: 'Practitioner',
      resource: mapPractitioner(d, organization, doctorEnabled[i]),
      system: IDENTIFIER_SYSTEMS.practitioner,
      value: String(d.id),
    })),
    'practitioners'
  );

  const practitionerRefs = new Map<string, Reference<Practitioner>>();
  const doctorTimeZones = new Map<string, string>();
  for (const d of doctors) {
    if (d.timezone) {
      doctorTimeZones.set(String(d.id), d.timezone);
    }
  }
  for (let i = 0; i < doctors.length; i++) {
    const id = doctorResult.ids[i];
    if (id) {
      practitionerRefs.set(String(doctors[i].id), {
        reference: `Practitioner/${id}`,
        display: `${doctors[i].first_name} ${doctors[i].last_name}`.trim(),
      });
    }
  }

  log('directory: providers written');
  const offices = await drchronoOptional<DrOffice>(client, '/offices');
  log(`${offices.length} offices fetched`);
  const officeEnabled = offices.map((o) =>
    mergeEnabled({
      retiredUpstream: o.archived === true,
      existing: existing.locations.get(String(o.id)),
    })
  );
  const officeZus = offices.map((o) => mergeZusEnabled(existing.locations.get(String(o.id))));
  const officeResult = await write(
    medplum,
    offices.map((o, i) => ({
      resourceType: 'Location',
      resource: mapLocation(o, organization, officeEnabled[i], officeZus[i]),
      system: IDENTIFIER_SYSTEMS.location,
      value: String(o.id),
    })),
    'locations'
  );

  const locationRefs = new Map<string, Reference<Location>>();
  for (let i = 0; i < offices.length; i++) {
    const id = officeResult.ids[i];
    if (id) {
      locationRefs.set(String(offices[i].id), { reference: `Location/${id}`, display: offices[i].name });
    }
  }

  log('directory: offices written');
  return {
    practitionerWrote: doctorResult.wrote,
    locationWrote: officeResult.wrote,
    practitionerIds: doctorResult.ids,
    locationIds: officeResult.ids,
    practitionerRefs,
    locationRefs,
    doctorTimeZones,
    disabledPractitioners: doctorEnabled.filter((e) => !e).length,
    disabledLocations: officeEnabled.filter((e) => !e).length,
    disabledOfficeIds: new Set(offices.filter((_, i) => !officeEnabled[i]).map((o) => o.id)),
    disabledDoctorIds: new Set(doctors.filter((_, i) => !doctorEnabled[i]).map((d) => d.id)),
  };
}

/**
 * Fetch and write the patient themselves.
 * @param ctx - The import context.
 * @returns The DrChrono payload and the Medplum reference to the written Patient.
 */
async function importPatientRecord(
  ctx: ImportContext
): Promise<{ drPatient: DrPatient; patientRef: Reference<Patient>; medplumPatientId: string }> {
  const res = await drchronoGet(ctx.client, `/patients/${encodeURIComponent(ctx.drchronoPatientId)}`);
  if (!res.ok) {
    throw new Error(
      `DrChrono /patients/${ctx.drchronoPatientId} answered ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const drPatient = (await res.json()) as DrPatient;

  const resource = mapPatient(drPatient, ctx.organization);
  const generalPractitioner = drPatient.doctor ? lookup(ctx.practitioners, drPatient.doctor) : undefined;
  if (generalPractitioner) {
    resource.generalPractitioner = [generalPractitioner];
  }

  const result = await write(
    ctx.medplum,
    [
      {
        resourceType: 'Patient',
        resource,
        system: IDENTIFIER_SYSTEMS.patient,
        value: String(drPatient.id),
      },
    ],
    'patient'
  );
  const medplumPatientId = result.ids[0];
  if (!medplumPatientId) {
    throw new Error(`Patient write did not settle (status ${result.statuses[0] ?? 'unknown'})`);
  }
  trackRefs(ctx, 'Patient', [medplumPatientId]);

  return {
    drPatient,
    medplumPatientId,
    patientRef: {
      reference: `Patient/${medplumPatientId}`,
      display: joinDefined([drPatient.first_name, drPatient.last_name], ' '),
    },
  };
}

/**
 * Import the patient's insurance coverage.
 *
 * `/insurances` requires `payer_type`, which selects the clearinghouse whose
 * format the returned payer id uses; `emdeon` is the largest US clearinghouse.
 *
 * The filter on the next line is not defensive tidying. On a grant without the
 * billing scope, DrChrono answers `/insurances` with its **payer directory** —
 * `{payer_name, payer_id, state}` rows with no `id` and no `patient` — and
 * silently ignores the `patient` filter. The original importer mapped those
 * straight through, so a chart with no coverage at all came out with 20
 * Coverage resources named after unrelated insurers, every one of them keyed on
 * the literal string `undefined`. Nineteen of twenty 400'd; the twentieth would
 * have stuck. A row is patient coverage only if it carries both fields.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 */
async function importCoverage(ctx: ImportContext, patient: Reference<Patient>): Promise<void> {
  const rows = await drchronoOptional<DrInsurance>(
    ctx.client,
    '/insurances',
    { patient: ctx.drchronoPatientId, payer_type: 'emdeon' },
    { maxRecords: 20, sectionTimeoutMs: 60_000 }
  );
  const insurances = rows.filter((c) => typeof c.id === 'number' && typeof c.patient === 'number');
  if (insurances.length < rows.length) {
    log(`${rows.length - insurances.length} /insurances rows were payer-directory entries, not coverage — skipped`);
  }
  const result = await write(
    ctx.medplum,
    insurances.map((c) => ({
      resourceType: 'Coverage',
      resource: mapCoverage(c, patient, ctx.organization),
      system: IDENTIFIER_SYSTEMS.coverage,
      value: String(c.id),
    })),
    'coverages'
  );
  ctx.counts.coverages = result.wrote;
  trackRefs(ctx, 'Coverage', result.ids);
}

/**
 * Find or create the practice-wide Schedule the Slots hang off.
 *
 * Scoped to the calling clinic by identifier value. A plain
 * `searchOne('Schedule', 'active=true')` — which is what the original did —
 * finds whichever clinic's Schedule the bot happens to see first, and the bot is
 * a project admin, so that is a cross-tenant link.
 * @param ctx - The import context.
 * @returns A reference to the Schedule.
 */
async function getOrCreateSchedule(ctx: ImportContext): Promise<Reference<Schedule>> {
  const orgId = ctx.organization.reference?.split('/')[1] ?? 'unknown';
  const value = `drchrono-practice-${orgId}`;
  const resource: Schedule = {
    resourceType: 'Schedule',
    meta: buildMeta(ctx.organization),
    identifier: [{ system: IDENTIFIER_SYSTEMS.schedule, value }],
    active: true,
    // Schedule.actor cannot reference an Organization, so the practice is named
    // rather than linked; the compartment on `meta` is what ties it to the clinic.
    actor: [{ display: 'DrChrono Practice' }],
  };
  const result = await write(
    ctx.medplum,
    [{ resourceType: 'Schedule', resource, system: IDENTIFIER_SYSTEMS.schedule, value }],
    'schedule'
  );
  const id = result.ids[0];
  if (!id) {
    throw new Error(`Schedule write did not settle (status ${result.statuses[0] ?? 'unknown'})`);
  }
  return { reference: `Schedule/${id}` };
}

/**
 * Pull every appointment for the patient, walking DrChrono's date filter safely.
 *
 * `date_range` is capped at roughly 190 days unless the whole range is in the
 * past, and DrChrono answers an over-wide range with an empty result set rather
 * than an error. That failure mode is invisible: the import reports success and
 * writes no visits. Chunking at 180 days keeps every request inside the limit.
 * @param ctx - The import context.
 * @param drPatient - The DrChrono patient, whose first-appointment date sets the floor.
 * @returns Every appointment found, deduplicated by DrChrono id.
 */
async function fetchAppointments(ctx: ImportContext, drPatient: DrPatient): Promise<DrAppointment[]> {
  const floor = drPatient.date_of_first_appointment
    ? new Date(`${drPatient.date_of_first_appointment}T00:00:00Z`)
    : new Date(Date.now() - DEFAULT_LOOKBACK_YEARS * 365 * DAY_MS);
  const ceiling = new Date(Date.now() + FUTURE_WINDOW_DAYS * DAY_MS);

  const start = Number.isNaN(floor.getTime()) ? new Date(Date.now() - DEFAULT_LOOKBACK_YEARS * 365 * DAY_MS) : floor;
  const byId = new Map<number, DrAppointment>();

  for (let from = start.getTime(); from <= ceiling.getTime(); from += APPOINTMENT_CHUNK_DAYS * DAY_MS) {
    const to = Math.min(from + (APPOINTMENT_CHUNK_DAYS - 1) * DAY_MS, ceiling.getTime());
    const range = `${isoDate(new Date(from))}/${isoDate(new Date(to))}`;
    const page = await drchronoOptional<DrAppointment>(ctx.client, '/appointments', {
      patient: ctx.drchronoPatientId,
      date_range: range,
      verbose: 'true',
    });
    for (const appt of page) {
      byId.set(appt.id, appt);
    }
  }

  // A switched-off office or provider contributes no visits at all, even when
  // the patient themselves is being imported deliberately. Filtering here
  // rather than at the write keeps it off every downstream surface at once:
  // no Encounter, no Appointment, no Slot, no vitals, no clinical note.
  const visible = [...byId.values()].filter(
    (a) => !isDirectoryDisabled(a.office, ctx.disabledOffices) && !isDirectoryDisabled(a.doctor, ctx.disabledDoctors)
  );
  const hidden = byId.size - visible.length;
  log(
    `${visible.length} appointments across ${isoDate(start)}..${isoDate(ceiling)}` +
      (hidden > 0 ? ` (${hidden} skipped: disabled office or provider)` : '')
  );
  return visible;
}

/**
 * Whether a DrChrono office or provider id has been switched off.
 *
 * An id that is not in the set is allowed. Absence means the directory has
 * never seen it — an office added upstream since the last sync — and nobody
 * has switched it off.
 * @param id - The id from the appointment.
 * @param disabled - The switched-off ids.
 * @returns True when the appointment must be skipped.
 */
function isDirectoryDisabled(id: number | undefined, disabled: Set<number>): boolean {
  return typeof id === 'number' && disabled.has(id);
}

/**
 * Write the Slot, Appointment and Encounter for every visit, plus its vitals.
 *
 * The write order is forced by the references: Slot has no dependencies,
 * Appointment points at its Slot, and Encounter points at its Appointment. Doing
 * it in that order means three batches rather than a write-then-patch pass per
 * visit.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 * @param appointments - Every appointment found for the patient.
 */
async function importAppointments(
  ctx: ImportContext,
  patient: Reference<Patient>,
  appointments: DrAppointment[]
): Promise<void> {
  if (appointments.length === 0) {
    return;
  }

  warnOnUnmappedStatuses(appointments);

  // Only a scheduled appointment can occupy a Slot; the rest still become
  // Encounters, which is what carries the clinical content.
  const zone = ctx.timeZone;
  const scheduled = appointments.filter((a) => Boolean(toInstant(a.scheduled_time, zone)));
  const schedule = scheduled.length > 0 ? await getOrCreateSchedule(ctx) : undefined;

  const slotRefs = new Map<string, Reference<Slot>>();
  if (schedule) {
    const slotResult = await write(
      ctx.medplum,
      scheduled.map((a) => ({
        resourceType: 'Slot',
        resource: mapSlot(a, toInstant(a.scheduled_time, zone) as string, schedule, ctx.organization),
        system: IDENTIFIER_SYSTEMS.slot,
        value: String(a.id),
      })),
      'slots'
    );
    for (let i = 0; i < scheduled.length; i++) {
      const id = slotResult.ids[i];
      if (id) {
        slotRefs.set(String(scheduled[i].id), { reference: `Slot/${id}` });
      }
    }
    ctx.counts.slots = slotResult.wrote;
    trackRefs(ctx, 'Slot', slotResult.ids);
  }

  const withSlots = scheduled.filter((a) => slotRefs.has(String(a.id)));
  const appointmentRefs = new Map<string, Reference<Appointment>>();
  const apptResult = await write(
    ctx.medplum,
    withSlots.map((a) => ({
      resourceType: 'Appointment',
      resource: mapAppointment(
        a,
        toInstant(a.scheduled_time, zone) as string,
        lookup(slotRefs, a.id) as Reference<Slot>,
        patient,
        a.doctor ? lookup(ctx.practitioners, a.doctor) : undefined,
        a.office ? lookup(ctx.locations, a.office) : undefined,
        ctx.organization
      ),
      system: IDENTIFIER_SYSTEMS.appointment,
      value: String(a.id),
    })),
    'appointments'
  );
  for (let i = 0; i < withSlots.length; i++) {
    const id = apptResult.ids[i];
    if (id) {
      appointmentRefs.set(String(withSlots[i].id), { reference: `Appointment/${id}` });
    }
  }
  ctx.counts.appointmentResources = apptResult.wrote;
  trackRefs(ctx, 'Appointment', apptResult.ids);

  const encounterResult = await write(
    ctx.medplum,
    appointments.map((a) => ({
      resourceType: 'Encounter',
      resource: mapEncounter(
        a,
        patient,
        ctx.organization,
        ctx.practitioners,
        ctx.locations,
        lookup(appointmentRefs, a.id),
        zone
      ),
      system: IDENTIFIER_SYSTEMS.encounter,
      value: String(a.id),
    })),
    'encounters'
  );
  for (let i = 0; i < appointments.length; i++) {
    const id = encounterResult.ids[i];
    if (id) {
      ctx.encounters.set(String(appointments[i].id), { reference: `Encounter/${id}` });
    }
  }
  ctx.counts.appointments = encounterResult.wrote;
  trackRefs(ctx, 'Encounter', encounterResult.ids);

  const vitalEntries: UpsertEntry[] = [];
  for (const appt of appointments) {
    const effective = toInstant(appt.scheduled_time, zone);
    if (!appt.vitals || !effective) {
      continue;
    }
    const encounter = lookup(ctx.encounters, appt.id);
    const performer = appt.doctor ? lookup(ctx.practitioners, appt.doctor) : undefined;
    for (const obs of mapVitals(appt.vitals, appt.id, effective, patient, ctx.organization)) {
      if (encounter) {
        obs.encounter = encounter;
      }
      if (performer) {
        obs.performer = [performer];
      }
      vitalEntries.push({
        resourceType: 'Observation',
        resource: obs,
        system: IDENTIFIER_SYSTEMS.observation,
        value: obs.identifier?.[0]?.value as string,
      });
    }
  }
  const vitalResult = await write(ctx.medplum, vitalEntries, 'vitals');
  ctx.counts.observations = vitalResult.wrote;
  trackRefs(ctx, 'Observation', vitalResult.ids);
}

/** Cap on visit-note PDFs pulled in one run, so a 900s bot cannot be starved. */
const MAX_CLINICAL_NOTES = 300;

/** In-flight PDF downloads. Enough to hide latency, few enough to stay polite. */
const CLINICAL_NOTE_CONCURRENCY = 4;

/**
 * Download each locked visit note PDF and store it as a DocumentReference.
 *
 * The PDF is re-hosted as a Medplum Binary rather than linked, because
 * DrChrono's note URLs are short-lived presigned links — a stored URL is dead
 * within the hour, which is worse than no attachment at all.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 * @param appointments - Every appointment found for the patient.
 */
async function importClinicalNotes(
  ctx: ImportContext,
  patient: Reference<Patient>,
  appointments: DrAppointment[]
): Promise<void> {
  const withNotes = appointments
    .filter((a) => Boolean(a.clinical_note?.pdf) && Boolean(toInstant(a.scheduled_time, ctx.timeZone)))
    .slice(0, MAX_CLINICAL_NOTES);
  if (withNotes.length === 0) {
    return;
  }
  log(`fetching ${withNotes.length} clinical note PDFs`);

  const entries = await mapWithConcurrency(
    withNotes,
    CLINICAL_NOTE_CONCURRENCY,
    async (appt): Promise<UpsertEntry | undefined> => {
      try {
        const pdfUrl = appt.clinical_note?.pdf as string;
        const res = await withHardTimeout(fetch(pdfUrl), DRCHRONO_REQUEST_TIMEOUT_MS, `note ${appt.id}`);
        if (!res.ok) {
          return undefined;
        }
        const data = new Uint8Array(await res.arrayBuffer());
        const binary = await withMedplum429Retry(
          () =>
            ctx.medplum.createBinary({
              data,
              filename: `clinical-note-${appt.id}.pdf`,
              contentType: 'application/pdf',
            }),
          `createBinary(note ${appt.id})`
        );
        const date = toInstant(appt.scheduled_time, ctx.timeZone) as string;
        const author = appt.doctor ? lookup(ctx.practitioners, appt.doctor) : undefined;
        const encounter = lookup(ctx.encounters, appt.id);
        const resource: DocumentReference = {
          resourceType: 'DocumentReference',
          meta: buildMeta(ctx.organization),
          identifier: [{ system: IDENTIFIER_SYSTEMS.clinicalNote, value: String(appt.id) }],
          status: 'current',
          docStatus: appt.clinical_note?.locked ? 'final' : 'preliminary',
          type: {
            coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }],
            text: 'Clinical Note',
          },
          subject: patient,
          author: author ? [author] : undefined,
          custodian: ctx.organization,
          date,
          context: {
            encounter: encounter ? [encounter] : undefined,
            period: { start: date },
          },
          content: [
            {
              attachment: {
                contentType: 'application/pdf',
                url: binary.url,
                title: `Clinical Note – ${date.slice(0, 10)}`,
              },
            },
          ],
        };
        return {
          resourceType: 'DocumentReference',
          resource,
          system: IDENTIFIER_SYSTEMS.clinicalNote,
          value: String(appt.id),
        };
      } catch (err) {
        console.warn(
          `[drchrono-import] clinical note for appointment ${appt.id} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
      }
    }
  );

  const kept = entries.filter((e): e is UpsertEntry => e !== undefined);
  const result = await write(ctx.medplum, kept, 'clinical-notes');
  ctx.counts.clinicalNotes = result.wrote;
  trackRefs(ctx, 'DocumentReference', result.ids);
}

/**
 * Import allergies, medications and the problem list.
 *
 * Runs after appointments so `encounter` can be populated on the medications and
 * conditions DrChrono links to a visit.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 */
async function importClinical(ctx: ImportContext, patient: Reference<Patient>): Promise<void> {
  const allergies = await drchronoOptional<DrAllergy>(ctx.client, '/allergies', { patient: ctx.drchronoPatientId });
  const allergyEntries = await Promise.all(
    allergies.map(async (a) => ({
      resourceType: 'AllergyIntolerance',
      resource: mapAllergy(
        a,
        patient,
        a.name || a.description || (await resolveRxNormName(a.rxnorm, ctx.rxNormCache)),
        ctx.organization
      ),
      system: IDENTIFIER_SYSTEMS.allergy,
      value: String(a.id),
    }))
  );
  const allergyResult = await write(ctx.medplum, allergyEntries, 'allergies');
  ctx.counts.allergies = allergyResult.wrote;
  trackRefs(ctx, 'AllergyIntolerance', allergyResult.ids);

  const medications = await drchronoOptional<DrMedication>(ctx.client, '/medications', {
    patient: ctx.drchronoPatientId,
  });
  const medicationResult = await write(
    ctx.medplum,
    medications.map((m) => ({
      resourceType: 'MedicationRequest',
      resource: mapMedication(m, patient, ctx.organization, ctx.practitioners, ctx.encounters),
      system: IDENTIFIER_SYSTEMS.medication,
      value: String(m.id),
    })),
    'medications'
  );
  ctx.counts.medications = medicationResult.wrote;
  trackRefs(ctx, 'MedicationRequest', medicationResult.ids);

  const problems = await drchronoOptional<DrProblem>(ctx.client, '/problems', { patient: ctx.drchronoPatientId });
  const conditionResult = await write(
    ctx.medplum,
    problems.map((p) => ({
      resourceType: 'Condition',
      resource: mapCondition(p, patient, ctx.organization, ctx.encounters),
      system: IDENTIFIER_SYSTEMS.condition,
      value: String(p.id),
    })),
    'conditions'
  );
  ctx.counts.conditions = conditionResult.wrote;
  trackRefs(ctx, 'Condition', conditionResult.ids);
}

/**
 * Import vaccines, family history and social history.
 *
 * Vaccines live at `/patient_vaccine_records`, not `/immunizations` — the latter
 * exists but returns the practice's vaccine inventory, not what was given.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 */
async function importHistories(ctx: ImportContext, patient: Reference<Patient>): Promise<void> {
  const vaccines = await drchronoOptional<DrImmunization>(ctx.client, '/patient_vaccine_records', {
    patient: ctx.drchronoPatientId,
  });
  const vaccineResult = await write(
    ctx.medplum,
    vaccines.map((i) => ({
      resourceType: 'Immunization',
      resource: mapImmunization(i, patient, ctx.organization, ctx.practitioners),
      system: IDENTIFIER_SYSTEMS.immunization,
      value: String(i.id),
    })),
    'immunizations'
  );
  ctx.counts.immunizations = vaccineResult.wrote;
  trackRefs(ctx, 'Immunization', vaccineResult.ids);

  const family = await drchronoOptional<DrFamilyHistory>(ctx.client, '/family_history', {
    patient: ctx.drchronoPatientId,
  });
  const familyResult = await write(
    ctx.medplum,
    family.map((f) => ({
      resourceType: 'FamilyMemberHistory',
      resource: mapFamilyMemberHistory(f, patient, ctx.organization),
      system: IDENTIFIER_SYSTEMS.familyHistory,
      value: String(f.id),
    })),
    'family-history'
  );
  ctx.counts.familyHistories = familyResult.wrote;
  trackRefs(ctx, 'FamilyMemberHistory', familyResult.ids);

  const social = await drchronoOptional<DrSocialHistory>(ctx.client, '/social_history', {
    patient: ctx.drchronoPatientId,
  });
  const socialEntries: UpsertEntry[] = [];
  for (const s of social) {
    for (const obs of mapSocialHistory(s, patient, ctx.organization, ctx.timeZone)) {
      socialEntries.push({
        resourceType: 'Observation',
        resource: obs,
        system: IDENTIFIER_SYSTEMS.socialHistory,
        value: obs.identifier?.[0]?.value as string,
      });
    }
  }
  const socialResult = await write(ctx.medplum, socialEntries, 'social-history');
  ctx.counts.socialHistoryObs = socialResult.wrote;
  trackRefs(ctx, 'Observation', socialResult.ids);
}

/**
 * Import procedures.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 */
async function importProcedures(ctx: ImportContext, patient: Reference<Patient>): Promise<void> {
  const procedures = await drchronoOptional<DrProcedure>(ctx.client, '/procedures', {
    patient: ctx.drchronoPatientId,
  });
  const result = await write(
    ctx.medplum,
    procedures.map((p) => ({
      resourceType: 'Procedure',
      resource: mapProcedure(p, patient, ctx.organization, ctx.practitioners, ctx.encounters),
      system: IDENTIFIER_SYSTEMS.procedure,
      value: String(p.id),
    })),
    'procedures'
  );
  ctx.counts.procedures = result.wrote;
  trackRefs(ctx, 'Procedure', result.ids);
}

/** Cap on lab orders per run. */
const MAX_LAB_ORDERS = 200;

/** Cap on lab results per run. */
const MAX_LAB_RESULTS = 500;

/** Cap on lab documents per run; these carry inline HL7 and are the largest. */
const MAX_LAB_DOCUMENTS = 500;

/**
 * Import lab orders, results and result documents.
 *
 * Both result paths are walked because neither is sufficient alone.
 * `/lab_results` gives structured, trendable Observations but returns malformed
 * JSON for practices with large histories — a DrChrono bug, handled here by the
 * graceful-degradation path in {@link drchronoPaginated} rather than by failing.
 * `/lab_documents` always works and carries the PDF plus the raw HL7 v2 message,
 * so the data survives even when the structured endpoint does not.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 */
async function importLabs(ctx: ImportContext, patient: Reference<Patient>): Promise<void> {
  const orders = await drchronoOptional<DrLabOrder>(
    ctx.client,
    '/lab_orders',
    { patient: ctx.drchronoPatientId },
    { maxRecords: MAX_LAB_ORDERS, sectionTimeoutMs: 90_000 }
  );
  const orderResult = await write(
    ctx.medplum,
    orders.map((l) => ({
      resourceType: 'ServiceRequest',
      resource: mapLabOrder(l, patient, ctx.organization, ctx.practitioners, ctx.encounters),
      system: IDENTIFIER_SYSTEMS.labOrder,
      value: String(l.id),
    })),
    'lab-orders'
  );
  for (let i = 0; i < orders.length; i++) {
    const id = orderResult.ids[i];
    if (id) {
      ctx.labOrders.set(String(orders[i].id), { reference: `ServiceRequest/${id}` });
    }
  }
  ctx.counts.labOrders = orderResult.wrote;
  trackRefs(ctx, 'ServiceRequest', orderResult.ids);

  const results = await drchronoOptional<DrLabResult>(
    ctx.client,
    '/lab_results',
    { patient: ctx.drchronoPatientId },
    // 60s, not the 300s default. `/lab_results` is the endpoint DrChrono is
    // known to break on — it 500s or returns malformed JSON for practices with
    // large histories — so a practice where it is broken pays one minute, not
    // five, and still gets the same data from `/lab_documents` below.
    { maxRecords: MAX_LAB_RESULTS, sectionTimeoutMs: 60_000 }
  );
  const observationResult = await write(
    ctx.medplum,
    results.map((r) => ({
      resourceType: 'Observation',
      resource: mapLabObservation(r, patient, ctx.organization, ctx.timeZone),
      system: IDENTIFIER_SYSTEMS.labObservation,
      value: String(r.id),
    })),
    'lab-observations'
  );
  ctx.counts.labObservations = observationResult.wrote;
  trackRefs(ctx, 'Observation', observationResult.ids);

  const reportResult = await write(
    ctx.medplum,
    results.map((r, i) => {
      const obsId = observationResult.ids[i];
      const obsRefs: Reference<Observation>[] = obsId ? [{ reference: `Observation/${obsId}` }] : [];
      return {
        resourceType: 'DiagnosticReport',
        resource: mapLabReport(r, patient, ctx.organization, ctx.labOrders, obsRefs, ctx.timeZone),
        system: IDENTIFIER_SYSTEMS.labReport,
        value: String(r.id),
      };
    }),
    'lab-reports'
  );
  ctx.counts.labReports = reportResult.wrote;
  trackRefs(ctx, 'DiagnosticReport', reportResult.ids);

  const documents = await drchronoOptional<DrLabDocument>(
    ctx.client,
    '/lab_documents',
    { patient: ctx.drchronoPatientId },
    { maxRecords: MAX_LAB_DOCUMENTS, sectionTimeoutMs: 180_000 }
  );
  const labFiles = await rehostDocumentFiles(
    ctx,
    patient,
    IDENTIFIER_SYSTEMS.labDocument,
    documents,
    'lab-document',
    // DrChrono documents lab files as PDFs, so fall back to that when the bytes are not recognised.
    () => ['lab.pdf']
  );
  const documentResult = await write(
    ctx.medplum,
    documents.map((d) => ({
      resourceType: 'DocumentReference',
      resource: mapLabDocument(
        d,
        patient,
        ctx.organization,
        ctx.labOrders,
        ctx.timeZone,
        labFiles.get(String(d.id))
      ),
      system: IDENTIFIER_SYSTEMS.labDocument,
      value: String(d.id),
    })),
    'lab-documents'
  );
  ctx.counts.labDocuments = documentResult.wrote;
  trackRefs(ctx, 'DocumentReference', documentResult.ids);
}

/** Cap on document files downloaded in one run; the rest keep DrChrono's link until the next run. */
const MAX_DOCUMENT_FILES = 300;

/** In-flight document downloads. */
const DOCUMENT_FILE_CONCURRENCY = 4;

/**
 * Files already copied into Medplum by an earlier run, keyed by DrChrono id, so
 * a re-import does not download and store every document again.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 * @param system - The identifier system of the documents.
 * @returns DrChrono id to the stored attachment.
 */
async function loadStoredFiles(
  ctx: ImportContext,
  patient: Reference<Patient>,
  system: string
): Promise<Map<string, Attachment>> {
  const stored = new Map<string, Attachment>();
  const baseUrl = ctx.medplum.getBaseUrl();
  for await (const page of ctx.medplum.searchResourcePages('DocumentReference', {
    patient: patient.reference as string,
    _elements: 'identifier,content',
    _count: '1000',
  })) {
    for (const doc of page) {
      const drchronoId = doc.identifier?.find((i) => i.system === system)?.value;
      const attachment = doc.content?.[0]?.attachment;
      const binary = storedBinaryReference(attachment?.url, baseUrl);
      if (drchronoId && attachment?.contentType && binary) {
        stored.set(drchronoId, { contentType: attachment.contentType, url: binary, size: attachment.size });
      }
    }
  }
  return stored;
}

/**
 * Copy DrChrono-hosted document files into Medplum Binaries.
 *
 * DrChrono serves documents from short-lived presigned S3 links with no MIME
 * type, so a DocumentReference that only stores the link cannot be previewed
 * and stops opening within the hour. Files stored by an earlier run are reused;
 * the rest are downloaded, typed from their bytes, and stored. A file that
 * cannot be fetched is skipped and keeps DrChrono's link, to be retried next run.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 * @param system - The identifier system of the documents.
 * @param documents - The DrChrono documents, each with an id and a file link.
 * @param label - Names the files in storage and in logs.
 * @param names - File names or titles that may reveal the type when the bytes do not.
 * @returns DrChrono id to the stored attachment (content type, Binary URL and size).
 */
async function rehostDocumentFiles<T extends { id: number; document?: string }>(
  ctx: ImportContext,
  patient: Reference<Patient>,
  system: string,
  documents: T[],
  label: string,
  names: (d: T) => (string | undefined)[]
): Promise<Map<string, Attachment>> {
  const files = new Map<string, Attachment>();
  if (documents.length === 0) {
    return files;
  }
  try {
    for (const [id, attachment] of await loadStoredFiles(ctx, patient, system)) {
      files.set(id, attachment);
    }
  } catch (err) {
    console.warn(
      `[drchrono-import] could not read stored ${label} files: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const pending = documents.filter((d) => d.document && !files.has(String(d.id))).slice(0, MAX_DOCUMENT_FILES);
  if (pending.length > 0) {
    log(`fetching ${pending.length} ${label} files (${files.size} already stored)`);
  }
  await mapWithConcurrency(pending, DOCUMENT_FILE_CONCURRENCY, async (d) => {
    try {
      const url = d.document as string;
      const res = await withHardTimeout(fetch(url), DRCHRONO_REQUEST_TIMEOUT_MS, `${label} ${d.id}`);
      if (!res.ok) {
        return;
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const stored = await storeFile(
        ctx.medplum,
        data,
        res.headers.get('content-type'),
        [...names(d), url],
        `drchrono-${label}-${d.id}`
      );
      files.set(String(d.id), stored);
    } catch (err) {
      console.warn(
        `[drchrono-import] ${label} ${d.id} file failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
  return files;
}

/** Cap on inbox messages per run. */
const MAX_MESSAGES = 200;

/** Cap on DrChrono tasks per run. */
const MAX_TASKS = 200;

/**
 * Import chart documents, inbox messages and open tasks.
 * @param ctx - The import context.
 * @param patient - Reference to the imported patient.
 */
async function importAdministrative(ctx: ImportContext, patient: Reference<Patient>): Promise<void> {
  const documents = await drchronoOptional<DrDocument>(ctx.client, '/documents', {
    patient: ctx.drchronoPatientId,
  });
  const files = await rehostDocumentFiles(ctx, patient, IDENTIFIER_SYSTEMS.document, documents, 'document', (d) => [
    d.description,
  ]);
  const documentResult = await write(
    ctx.medplum,
    documents.map((d) => ({
      resourceType: 'DocumentReference',
      resource: mapDocument(d, patient, ctx.organization, ctx.timeZone, files.get(String(d.id))),
      system: IDENTIFIER_SYSTEMS.document,
      value: String(d.id),
    })),
    'documents'
  );
  ctx.counts.documents = documentResult.wrote;
  trackRefs(ctx, 'DocumentReference', documentResult.ids);

  const messages = await drchronoOptional<DrMessage>(
    ctx.client,
    '/messages',
    { patient: ctx.drchronoPatientId },
    { maxRecords: MAX_MESSAGES, sectionTimeoutMs: 60_000 }
  );
  const messageResult = await write(
    ctx.medplum,
    messages.map((m) => ({
      resourceType: 'Communication',
      resource: mapCommunication(m, patient, ctx.organization, ctx.timeZone),
      system: IDENTIFIER_SYSTEMS.communication,
      value: String(m.id),
    })),
    'communications'
  );
  ctx.counts.communications = messageResult.wrote;
  trackRefs(ctx, 'Communication', messageResult.ids);

  const tasks = await drchronoOptional<DrTask>(
    ctx.client,
    '/tasks',
    { patient: ctx.drchronoPatientId },
    { maxRecords: MAX_TASKS, sectionTimeoutMs: 60_000 }
  );
  const taskResult = await write(
    ctx.medplum,
    tasks.map((t) => ({
      resourceType: 'Task',
      resource: mapDrTask(t, patient, ctx.organization, ctx.practitioners, ctx.encounters, ctx.timeZone),
      system: IDENTIFIER_SYSTEMS.task,
      value: String(t.id),
    })),
    'tasks'
  );
  ctx.counts.tasks = taskResult.wrote;
  trackRefs(ctx, 'Task', taskResult.ids);
}

/*
 * A note on `Patient/$set-accounts` with `propagate`, which the original
 * importer called at the end of every run and this one deliberately does not.
 *
 * It re-writes every resource in the patient's compartment to stamp the account
 * onto it. Measured against this chart on the live server: it consumed the
 * whole 50,000-point-per-minute write budget by itself, and the 429 that
 * followed cascaded into the AuditEvent and the Task close-out — turning a
 * 133-second import into a 391-second one. batch.ts's own header warns about
 * exactly this call.
 *
 * It is also redundant. Every resource this bot writes already carries
 * `meta.account` from `buildMeta`, which is what compartment filtering matches
 * on. The only resources it would have added are the Binaries behind the
 * clinical-note PDFs, and the clinic access policy grants `Binary` at project
 * scope with no compartment criteria, so those are readable either way.
 *
 * If a future access policy does put `Binary` behind a compartment, the fix is
 * to stamp each Binary as it is created, not to re-write the whole chart.
 */

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Bot entry point.
 *
 * Failures are returned, not thrown. An uncaught throw reaches the caller as a
 * bare 500 "Internal Server Error", which hides the one thing worth knowing:
 * most failures here are configuration ("not scoped to an organization",
 * "DrChrono is not configured"), and a 500 sends people to debug the server.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - Carries the input, the requester and the project secrets.
 * @returns The import result, or a described failure.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<ImportInput>
): Promise<ImportSuccess | DirectorySyncSuccess | ImportFailure> {
  try {
    return await run(medplum, event);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate the input, establish the clinic, then import the chart.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - Carries the input, the requester and the project secrets.
 * @returns The import result, or a described failure.
 */
async function run(
  medplum: MedplumClient,
  event: BotEvent<ImportInput>
): Promise<ImportSuccess | DirectorySyncSuccess | ImportFailure> {
  const input = event.input;
  const action = input?.action;
  if (action !== 'import' && action !== 'syncDirectory') {
    throw new Error(`Unknown action: ${JSON.stringify(action)}`);
  }

  const material = event.secrets[ENCRYPTION_KEY_SECRET_NAME]?.valueString;
  if (!material) {
    throw new Error(`${ENCRYPTION_KEY_SECRET_NAME} is not set in project secrets`);
  }

  // The clinic comes from the caller's own membership. Accepting it as input
  // would let any caller import into — and read credentials for — another
  // tenant, which is the IDOR class this rewrite exists to close.
  const organization = await resolveCallerOrganization({ medplum, requester: event.requester });
  const client = await createDrChronoClient({ medplum, organization, key: deriveEncryptionKey({ material }) });

  if (action === 'syncDirectory') {
    const result = await syncDirectoryResources(medplum, client, organization);
    return {
      ok: true,
      action: 'syncDirectory',
      practitioners: { wrote: result.practitionerWrote, disabled: result.disabledPractitioners },
      locations: { wrote: result.locationWrote, disabled: result.disabledLocations },
    };
  }

  const drchronoPatientId = String(input.drchronoPatientId ?? '').trim();
  if (!drchronoPatientId) {
    throw new Error('drchronoPatientId is required');
  }

  return importChart(medplum, client, organization, drchronoPatientId);
}

/**
 * Import one DrChrono chart end to end, tracked by a FHIR Task.
 *
 * The Task is created before the first fetch and closed out at the end, so an
 * import that dies mid-run leaves an `in-progress` Task behind rather than no
 * trace at all. Both the success and failure paths write an AuditEvent.
 * @param medplum - Bot-scoped Medplum client.
 * @param client - Clinic-scoped DrChrono client.
 * @param organization - The calling clinic.
 * @param drchronoPatientId - DrChrono's id for the patient to import.
 * @returns The import result, or a described failure.
 */
async function importChart(
  medplum: MedplumClient,
  client: DrChronoClient,
  organization: Reference<Organization>,
  drchronoPatientId: string
): Promise<ImportSuccess | ImportFailure> {
  const startedAt = Date.now();
  const counts = emptyCounts();

  const task = await withMedplum429Retry(
    () =>
      medplum.createResource<Task>({
        resourceType: 'Task',
        meta: buildMeta(organization),
        status: 'in-progress',
        intent: 'order',
        code: { text: 'drchrono-import' },
        description: `Import DrChrono patient ${drchronoPatientId} into Medplum`,
        authoredOn: new Date().toISOString(),
        executionPeriod: { start: new Date().toISOString() },
        identifier: [
          { system: IDENTIFIER_SYSTEMS.syncJob, value: `drchrono-import-${drchronoPatientId}-${Date.now()}` },
        ],
      }),
    'Task.create'
  );
  const taskId = task.id;
  // Held separately because the terminal updates below spread `task`, which is
  // the object as it was CREATED — before the patient existed. Without this the
  // completed Task loses the patient it belongs to, and the import monitor
  // shows a finished run with no name against it.
  let taskFor: Reference<Patient> | undefined;

  const ctx: ImportContext = {
    medplum,
    client,
    organization,
    drchronoPatientId,
    counts,
    practitioners: new Map(),
    doctorTimeZones: new Map(),
    timeZone: DEFAULT_PRACTICE_TIME_ZONE,
    locations: new Map(),
    disabledOffices: new Set(),
    disabledDoctors: new Set(),
    encounters: new Map(),
    labOrders: new Map(),
    refsByType: new Map(),
    rxNormCache: new Map(),
  };

  const progress = new ImportProgress({ medplum, task, totalPhases: 11 });

  try {
    await progress.phase('practice directory');
    await importPractice(ctx);

    await progress.phase(`patient ${drchronoPatientId}`);
    const { drPatient, patientRef, medplumPatientId } = await importPatientRecord(ctx);

    // The Task is opened before the patient exists, so `for` cannot be set at
    // creation. Attaching it here is what lets the import monitor name the
    // patient a run belongs to while the run is still going.
    taskFor = patientRef;
    if (taskId) {
      await medplum
        .patchResource('Task', taskId, [{ op: 'add', path: '/for', value: patientRef }])
        .catch(() => undefined);
    }

    await progress.phase('insurance coverage');
    await importCoverage(ctx, patientRef);

    // Appointments come before the clinical resources that reference them: the
    // original ran them after, so `encounter` was silently empty on every
    // medication, condition, procedure, lab order and task.
    await progress.phase('appointments and visits');
    const appointments = await fetchAppointments(ctx, drPatient);
    await importAppointments(ctx, patientRef, appointments);

    await progress.phase('clinical notes');
    await importClinicalNotes(ctx, patientRef, appointments);

    await progress.phase('allergies, medications, problems');
    await importClinical(ctx, patientRef);
    await progress.report(ctx.counts as unknown as Record<string, number>);

    await progress.phase('immunizations, family and social history');
    await importHistories(ctx, patientRef);

    await progress.phase('procedures');
    await importProcedures(ctx, patientRef);

    await progress.phase('lab orders and results');
    await importLabs(ctx, patientRef);
    await progress.report(ctx.counts as unknown as Record<string, number>);

    await progress.phase('documents, messages, tasks');
    await importAdministrative(ctx, patientRef);

    await progress.phase('provenance and audit');
    for (const [resourceType, refs] of ctx.refsByType) {
      if (refs.length === 0) {
        continue;
      }
      await withMedplum429Retry(
        () => medplum.createResource(buildProvenance(refs, organization, taskId, drchronoPatientId)),
        `Provenance(${resourceType})`
      ).catch((err: unknown) =>
        console.warn(
          `[drchrono-import] Provenance(${resourceType}) failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const durationMs = Date.now() - startedAt;
    await withMedplum429Retry(
      () =>
        medplum.createResource(
          buildAuditEvent(
            organization,
            taskId,
            drchronoPatientId,
            medplumPatientId,
            counts,
            '0',
            `OK — ${total} resources written in ${Math.round(durationMs / 1000)}s`
          )
        ),
      'AuditEvent'
    ).catch((err: unknown) =>
      console.warn(`[drchrono-import] AuditEvent failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    // No `$set-accounts` here — see the note above `handler` for why.

    // Closing the Task out is bookkeeping. The chart is already on disk, so a
    // throttled write here is not worth failing the import over.
    await withMedplum429Retry(
      () =>
        medplum.updateResource<Task>({
          ...task,
          status: 'completed',
          lastModified: new Date().toISOString(),
          businessStatus: { text: 'complete' },
          ...(taskFor ? { for: taskFor } : {}),
          executionPeriod: { ...task.executionPeriod, end: new Date().toISOString() },
          // One entry per resource type with a real integer, so the numbers
          // are readable without parsing a JSON blob out of a valueString.
          output: [
            ...countsToOutput(counts as unknown as Record<string, number>),
            { type: { text: 'medplumPatientId' }, valueString: medplumPatientId },
            { type: { text: 'durationMs' }, valueInteger: durationMs },
          ],
        }),
      'Task.complete'
    ).catch((err: unknown) =>
      console.warn(`[drchrono-import] Task close-out failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    log(`done: ${total} resources in ${Math.round(durationMs / 1000)}s`);
    return { ok: true, medplumPatientId, counts, taskId, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[drchrono-import] failed: ${message}`);

    await medplum
      .createResource(
        buildAuditEvent(
          organization,
          taskId,
          drchronoPatientId,
          'unknown',
          counts,
          '8',
          `FAILED: ${message.slice(0, 200)}`
        )
      )
      .catch(() => null);

    await medplum
      .updateResource<Task>({
        ...task,
        status: 'failed',
        lastModified: new Date().toISOString(),
        ...(taskFor ? { for: taskFor } : {}),
        // The coded reason is what a list view groups on ("token expired" is
        // a reconnect, "rate limited" is a retry); the text is what tells a
        // person what actually happened.
        statusReason: buildStatusReason(err),
        executionPeriod: { ...task.executionPeriod, end: new Date().toISOString() },
        // Keep whatever did land, so a partial import is visible as partial
        // rather than looking like nothing happened.
        output: countsToOutput(counts as unknown as Record<string, number>),
      })
      .catch(() => null);

    return { ok: false, error: message, taskId, counts, durationMs: Date.now() - startedAt };
  }
}
