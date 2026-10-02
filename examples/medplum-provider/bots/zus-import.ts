// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Enrol one patient in Zus and mirror their longitudinal record into Medplum.
 *
 * WHY THIS IS SHORTER THAN THE DRCHRONO IMPORT
 * --------------------------------------------
 * Zus already speaks FHIR R4, so nothing here maps fields. The whole job is
 * re-anchoring and tagging: drop the id Zus's server assigned, keep it as a
 * business identifier so a re-run updates instead of duplicating, point every
 * `subject`/`patient` reference at the Medplum Patient, and stamp the clinic's
 * compartment on the way in.
 *
 * THE TWO ZUS PATIENT IDS, AND WHY MIXING THEM UP COSTS AN AFTERNOON
 * -----------------------------------------------------------------
 * A Zus patient has two identifiers and they are not interchangeable:
 *
 *   - the **builder-scoped** Patient resource id, which is what the data
 *     subscription API enrols. Posting anything else gets "not builder's
 *     patient";
 *   - the **universal** patient id (`upid`), which is what the FHIR search
 *     parameter of that name takes. Posting the builder-scoped id to
 *     `/fhir/Observation?upid=...` returns HTTP 200 with an empty bundle — no
 *     error, just nothing, which reads exactly like "this patient has no data".
 *
 * Verified against the live Zus API for the pilot patient: enrolment answers for
 * `0bf6bf99-…` and returns an empty list for `a9ebcab2-…`; the FHIR search does
 * the opposite. Hence two separate inputs rather than one, and hence the names.
 *
 * FOUR FAILURE MODES THIS IS BUILT AROUND
 * ---------------------------------------
 *  1. **Silent truncation.** Zus pages its bundles. Reading only the first page
 *     yielded 10 allergies where the chart has 65, and 10 medications where it
 *     has 537. Every pull here follows `link[relation="next"]` to exhaustion,
 *     and a pull that could not finish is reported as incomplete rather than
 *     counted as a clean zero.
 *  2. **5xx as a response, not a throw.** Zus intermittently answers 502 on the
 *     long pulls. A 502 is a perfectly successful `fetch`, so a try/catch never
 *     sees it; the bundle simply fails to parse or comes back empty. Status is
 *     therefore inspected and retried explicitly.
 *  3. **One bad resource type taking the run with it.** Each type is pulled and
 *     written inside its own try/catch, so a schema surprise in `CarePlan`
 *     cannot discard the 2,000 Observations already written.
 *  4. **A missing compartment.** Every resource is written with
 *     `meta.account` = the caller's Organization. Without it the resource is
 *     outside the clinic compartment and invisible to every clinic user, even
 *     though the write returned 200.
 *
 * The Organization is resolved from the caller's own ProjectMembership and never
 * from the input. Accepting it as an argument would let any clinic import into
 * another clinic's compartment.
 *
 * RUNNING THIS A SECOND TIME
 * --------------------------
 * This bot is the re-sync. There is no separate path: the manual "sync now"
 * control and the automatic pull after a chart import both arrive here through
 * the same `lyfe/zus.import.requested` event, so whatever is true of one is
 * true of the other.
 *
 * Two different properties have to hold for that to be safe, and only the
 * first of them is the conditional PUT:
 *
 *  - **No duplicates.** Every write is `PUT <Type>?identifier=<zus system>|<zus
 *    id>`, so the server matches: no match creates, one match updates in place,
 *    several match return 412. A resource Zus returns with no `id` is skipped
 *    rather than written, because there would be nothing to key the next run
 *    on. That much has been true since the first import.
 *  - **No overwriting a clinician.** A conditional PUT replaces the *whole*
 *    resource, so a Condition someone resolved or a dose someone corrected
 *    would be silently reverted on the next pull. Before each type is written
 *    the local copies are indexed and `shared/local-edits.ts` decides, per
 *    resource, whether writing over it is allowed. A person's edit is kept, an
 *    ambiguous match is skipped, and a server that will not report
 *    `meta.author` makes the guard decline rather than guess. Every decline is
 *    counted onto the run's Task as `incomplete:preserved`.
 *
 * What re-syncing deliberately does **not** do is reflect an upstream
 * deletion*. A resource that has vanished from Zus stays in the chart. The
 * alternative is deleting clinical data on the strength of a third party's
 * record having changed shape, which is not a trade this makes.
 */
import type { BotEvent, MedplumClient, WithId } from '@medplum/core';
import type {
  Attachment,
  Binary,
  Bundle,
  Coding,
  DocumentReference,
  Identifier,
  Organization,
  Patient,
  Reference,
  Resource,
  Task,
} from '@medplum/fhirtypes';
import { Buffer as NodeBuffer } from 'node:buffer';
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';
import { sleep, upsertBatch, withMedplum429Retry } from './shared/batch.ts';
import {
  ENCRYPTION_KEY_SECRET_NAME,
  deriveEncryptionKey,
  getCredentialValues,
  readCredentialRecord,
} from './shared/credentials.ts';
import { readZusEnabledLocationRefs } from './shared/directory.ts';
import { mapWithConcurrency, storeFile, storedBinaryReference } from './shared/files.ts';
import type { DeclineReason, DeclineTally } from './shared/local-edits.ts';
import { describeDeclines, selectWritable } from './shared/local-edits.ts';
import { linkPatientCoveragePayors } from './shared/payers.ts';
import { ImportProgress, buildStatusReason, openOrAdoptTask } from './shared/progress.ts';
import { ZUS_SOURCE_TAG } from './shared/source.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';
import { pushReciprocity } from './shared/zus-push.ts';

/**
 * Give the bot sandbox the Node globals it does not have.
 *
 * Medplum's `vmcontext` runtime builds its VM context from a hand-written
 * object: `console`, `fetch`, `require`, `process`, `ContentType`,
 * `Hl7Message`, `MedplumClient`, `TextDecoder`, `TextEncoder`, `URL`,
 * `URLSearchParams`, `event`. That is the whole list — there is no `setTimeout`,
 * no `clearTimeout` and no `Buffer`. Confirmed by executing a probe bot against
 * the live server: `typeof globalThis.setTimeout` came back `'undefined'` while
 * `require('node:timers').setTimeout` was a function.
 *
 * It matters because `shared/batch.ts` sleeps on the *global* `setTimeout`
 * between chunks and after a 429. Without this, an import of more than one
 * 200-entry chunk dies with `ReferenceError: setTimeout is not defined` — and it
 * dies on the largest pulls, which are exactly the ones that need the throttling.
 * This chart is ~3,800 resources across 19 chunks, so it is not a corner case.
 *
 * This runs at module scope, not inside the handler, so anything imported here
 * is already safe by the time the first line of `handler` executes. esbuild
 * compiles these imports to `require`, which the sandbox does provide.
 */
const sandboxGlobals = globalThis as unknown as {
  setTimeout?: unknown;
  clearTimeout?: unknown;
  Buffer?: unknown;
};
sandboxGlobals.setTimeout ??= nodeSetTimeout;
sandboxGlobals.clearTimeout ??= nodeClearTimeout;
sandboxGlobals.Buffer ??= NodeBuffer;

/** What the caller sends. */
export interface ZusImportInput {
  /** Only supported action. Present so the bot can grow siblings without breaking callers. */
  action: 'import';
  /**
   * A Task the caller already opened for this run.
   *
   * The import worker opens one before invoking the bot, so a run that fails
   * before reaching the bot still leaves a record. Supplying it here means the
   * bot reports onto that Task instead of opening a second one for the same
   * import. Absent — a direct invocation — the bot opens its own.
   */
  taskId?: string;
  /**
   * Builder-scoped Zus Patient resource id — the one the data subscription API
   * enrols. NOT the universal id; see the note at the top of this file.
   *
   * Optional. When omitted the bot resolves it from the Medplum Patient's own
   * Zus identifiers, and registers the patient with Zus if they are not there
   * yet. That is what makes an unattended bulk run possible: the caller has a
   * Medplum patient id and nothing else.
   */
  zusPatientId?: string;
  /**
   * Zus universal patient id (`upid`) — the one the FHIR search parameter of
   * that name takes. Optional, resolved alongside `zusPatientId`.
   */
  zusUniversalId?: string;
  /** The Medplum Patient every imported resource is re-anchored to. */
  medplumPatientId: string;
}

/** What the caller gets back on success. */
interface ZusImportSuccess {
  /** Always true. */
  ok: true;
  /** Resources written per FHIR resource type. */
  counts: Record<string, number>;
  /** Types whose pull could not be completed, with the reason. Empty on a clean run. */
  incomplete: Record<string, string>;
  /** The `zus-import` Task that records this run. */
  taskId: string;
  /** Wall-clock duration of the whole import. */
  durationMs: number;
}

/** What the caller gets back on failure. */
interface ZusImportFailure {
  /** Always false. */
  ok: false;
  /** Why the import did not run. */
  error: string;
  /** The Task that was opened, when the failure happened after it was created. */
  taskId?: string;
  /** Wall-clock duration up to the failure. */
  durationMs: number;
}

/** Tag stamped on every mirrored resource so Lyfe-sourced data stays identifiable. */
const SOURCE_TAG: Coding = ZUS_SOURCE_TAG;

/**
 * Identifier system prefix for the Zus resource id, e.g.
 * `https://zusapi.com/fhir/Observation`.
 *
 * This exact spelling is load-bearing: an earlier import of this patient is
 * already in the project keyed on it, and the conditional PUTs below match on
 * it. Changing the casing or the host would not fail — it would quietly write a
 * second copy of all ~3,800 resources.
 */
const ZUS_IDENTIFIER_BASE = 'https://zusapi.com/fhir';

/** Identifier system Zus itself uses for the universal patient id. */
const ZUS_UNIVERSAL_ID_SYSTEM = 'https://zusapi.com/fhir/identifier/universal-id';

/** Fallback Zus FHIR base, used when the clinic record does not set one. */
const DEFAULT_ZUS_API_URL = 'https://api.zusapi.com/fhir';

/** Fallback Zus token host. */
const DEFAULT_ZUS_AUTH_URL = 'https://auth.zusapi.com';

/** Data subscription host for production Zus. */
const SUBSCRIPTIONS_URL = 'https://zap-data-subscriptions.zusapi.com';

/** Data subscription host for the Zus sandbox. */
const SUBSCRIPTIONS_URL_SANDBOX = 'https://zap-data-subscriptions.dev.zusapi.com';

/** Bundle size per Zus page. 100 is the largest value Zus honours in practice. */
const ZUS_PAGE_SIZE = 100;

/** Hard stop on pagination, so a malformed `next` link cannot loop forever. */
const ZUS_MAX_PAGES = 200;

/** Courtesy pause between Zus pages. */
const ZUS_INTER_PAGE_DELAY_MS = 100;

/** Backoff ladder for a Zus 5xx. Length also sets the retry budget. */
const ZUS_5XX_BACKOFFS_MS = [2_000, 5_000, 10_000, 20_000];

/** Per-request ceiling: a Zus call that hangs must not eat the bot's whole budget. */
const ZUS_REQUEST_TIMEOUT_MS = 60_000;

/** How many times enrolment is re-checked while it is still `pending`. */
const ENROLMENT_POLL_ATTEMPTS = 10;

/** Pause between enrolment status checks. */
const ENROLMENT_POLL_DELAY_MS = 3_000;

/**
 * Resource types mirrored, in pull order.
 *
 * `Encounter` is deliberately first, and `Observation` before `DiagnosticReport`:
 * each type's Zus-id-to-Medplum-id mapping is fed forward, so a later resource's
 * `encounter` or `result` reference can be repointed at the Medplum copy instead
 * of dangling at a Zus id that means nothing in this project.
 */
const RESOURCE_TYPES = [
  'Encounter',
  'Condition',
  'AllergyIntolerance',
  'MedicationStatement',
  'MedicationRequest',
  'Immunization',
  'Observation',
  'DiagnosticReport',
  'Procedure',
  'DocumentReference',
  'Coverage',
  'CarePlan',
  'FamilyMemberHistory',
] as const;

/** A FHIR resource as it arrives from Zus, before it is narrowed. */
type RawResource = Record<string, unknown>;

/** Everything needed to talk to one clinic's Zus tenant. */
interface ZusConnection {
  /** FHIR base, e.g. `https://api.zusapi.com/fhir`. */
  fhirUrl: string;
  /** Data subscription base for enrolment. */
  subscriptionsUrl: string;
  /** Bearer token minted for this run. */
  token: string;
  /** Builder id, sent as the `Zus-Account` header. */
  builderId?: string;
  /** Data package the patient is enrolled in. */
  packageId?: string;
  /** Enrolling practitioner's NPI. */
  practitionerNpi?: string;
  /** Enrolling practice name. */
  practiceName?: string;
  /** Enrolling practitioner's role. */
  practitionerRole?: string;
}

/** Outcome of pulling one resource type out of Zus. */
interface PullResult {
  /** Everything that came back, across every page that was read. */
  resources: RawResource[];
  /** Pages actually read. */
  pages: number;
  /** False when pagination stopped early — the list above is a prefix, not the whole set. */
  complete: boolean;
  /** Why it stopped early, when `complete` is false. */
  reason?: string;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client, running under the bot's own admin membership.
 * @param event - Carries the input, the caller's identity and the project secrets.
 * @returns The per-type counts and the Task id, or a message explaining the refusal.
 */
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<ZusImportInput>
): Promise<ZusImportSuccess | ZusImportFailure> {
  const startedAt = Date.now();
  try {
    return await run({ medplum, event, startedAt });
  } catch (err) {
    // Returned, never rethrown. An uncaught throw reaches the caller as a bare
    // 500 with no body, which hides the one thing worth knowing — nearly every
    // failure here is configuration ("not scoped to an organization", "Zus is
    // not configured", "not builder's patient") and a 500 sends people to the
    // server logs for something the message already says.
    return { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt };
  }
}

/**
 * The import itself, wrapped by {@link handler} so failures come back as messages.
 * @param props - The run inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.event - The bot event, for input, requester and secrets.
 * @param props.startedAt - Epoch millis the run began, for the reported duration.
 * @returns The per-type counts and the Task id.
 */
async function run(props: {
  medplum: MedplumClient;
  event: BotEvent<ZusImportInput>;
  startedAt: number;
}): Promise<ZusImportSuccess | ZusImportFailure> {
  const { medplum, event, startedAt } = props;
  const input = event.input;

  if (input?.action !== 'import') {
    throw new Error(`Unknown action ${JSON.stringify(input?.action)}. Expected "import".`);
  }
  requireId({ value: input.medplumPatientId, name: 'medplumPatientId' });

  const material = event.secrets[ENCRYPTION_KEY_SECRET_NAME]?.valueString;
  if (!material) {
    throw new Error(`${ENCRYPTION_KEY_SECRET_NAME} is not set in project secrets`);
  }

  // Derived from the caller's membership, never from the input — see the file header.
  //
  // Wrapped for 429s like every other Medplum call in this file. A previous run
  // of this bot had exhausted the server's points-per-minute budget, so the very
  // next execution died 22ms in, on this membership search, and reported "Too
  // Many Requests" as though the caller were unauthorised. Setup reads share the
  // limiter with the bulk writes; they need the same patience.
  const organization = await withMedplum429Retry(
    () => resolveCallerOrganization({ medplum, requester: event.requester }),
    'resolve caller organization'
  );

  // Confirms the Patient exists and, more importantly, that it belongs to the
  // caller's clinic. Without this check a caller could re-anchor another
  // clinic's chart onto a Patient they cannot see.
  const patient = await withMedplum429Retry(
    () => medplum.readResource('Patient', input.medplumPatientId),
    'read Patient'
  );
  assertSameOrganization({ patient, organization });

  // Zus enrolment is gated per office, separately from whether that office's
  // charts are imported at all. The clinic imports appointments from every
  // office it operates, but only some of those offices' patients should be
  // sent to Zus — enrolment is an outward call to a third party and is billed
  // per patient. Which offices qualify is configuration, set on the Directory
  // page, not a constant in this file.
  //
  // Checked here, before connectToZus, so an ineligible patient costs nothing:
  // no credentials read, no enrolment POST, no Task opened.
  const eligibility = await withMedplum429Retry(
    () => resolveZusEligibility({ medplum, organization, medplumPatientId: input.medplumPatientId }),
    'resolve Zus eligibility'
  );
  if (!eligibility.eligible) {
    return { ok: false, error: eligibility.reason, durationMs: Date.now() - startedAt };
  }
  log(`Zus-eligible via ${eligibility.via}`);

  const zus = await connectToZus({ medplum, organization, key: deriveEncryptionKey({ material }) });

  // Resolve the two Zus ids the rest of this run needs. Supplied ids win, so a
  // caller that already knows them pays for nothing extra; otherwise they come
  // off the Patient, and failing that the patient is registered with Zus.
  const ids = await resolveZusPatientIds({ medplum, zus, patient, input });
  const resolved: ZusImportInput = { ...input, ...ids };

  const task = await openOrAdoptTask({
    medplum,
    taskId: input.taskId,
    create: () => createTask({ medplum, organization, input: resolved }),
  });
  log(`task ${task.id} opened for Patient/${input.medplumPatientId}`);

  const counts: Record<string, number> = {};
  const incomplete: Record<string, string> = {};

  try {
    const enrolment = await ensureEnrolment({ zus, builderScopedPatientId: resolved.zusPatientId as string });
    log(`enrolment ${enrolment.status}${enrolment.alreadyEnrolled ? ' (pre-existing)' : ''}`);
    if (enrolment.status !== 'active') {
      // Not fatal: Zus keeps aggregating in the background and a later run picks
      // up the rest. Recorded so a thin import is explicable after the fact.
      incomplete.enrolment = `Zus enrolment is "${enrolment.status}", not "active" — the record may be partial`;
    }

    await linkZusIdentifiers({ medplum, patient, input: resolved });

    // Two setup phases (enrolment, identifiers) then one per resource type.
    // Two setup phases, one per resource type, then payer linking and reciprocity.
    const progress = new ImportProgress({ medplum, task, totalPhases: RESOURCE_TYPES.length + 4 });
    await progress.phase('enrolment');
    await progress.phase('linking Zus identifiers');

    const patientRef: Reference<Patient> = { reference: `Patient/${input.medplumPatientId}` };
    // Zus reference ("Encounter/<zus id>") to Medplum reference, fed forward
    // across resource types so inter-resource links survive the move.
    const referenceMap = new Map<string, string>();

    // What the run refused to overwrite, summed across types. Reported on the
    // Task rather than only logged: a re-sync that quietly declines half a
    // chart and reports a clean success is the failure this whole guard is
    // about, so the number has to reach the person who pressed the button.
    const declinedTotal: DeclineTally = {};
    const declinedSample: Partial<Record<DeclineReason, string>> = {};

    for (const resourceType of RESOURCE_TYPES) {
      await progress.phase(resourceType);
      try {
        const written = await importResourceType({
          medplum,
          zus,
          resourceType,
          upid: resolved.zusUniversalId as string,
          patientRef,
          organization,
          referenceMap,
        });
        counts[resourceType] = written.wrote;
        for (const [reason, n] of Object.entries(written.declined) as [DeclineReason, number][]) {
          declinedTotal[reason] = (declinedTotal[reason] ?? 0) + n;
          declinedSample[reason] ??= `${resourceType}: ${written.declineDetail[reason]}`;
        }
        if (written.reason) {
          incomplete[resourceType] = written.reason;
        }
        // Publish after each type so a long pull shows what it has already
        // landed rather than only its phase name.
        await progress.report(counts);
      } catch (err) {
        // Isolation: one type's failure must not discard the types already
        // written, nor stop the ones still to come.
        counts[resourceType] = 0;
        incomplete[resourceType] = err instanceof Error ? err.message : String(err);
        log(`${resourceType} failed: ${incomplete[resourceType]}`);
      }
    }

    const declineSummary = describeDeclines(declinedTotal, declinedSample);
    if (declineSummary) {
      incomplete['preserved'] = declineSummary;
      log(`preserved: ${declineSummary}`);
    }

    // Payers arrive from Zus as display strings with no reference, which
    // renders as "Unknown Payor" everywhere. Mint the Organizations they name
    // and point the Coverages at them.
    await progress.phase('linking payers');
    try {
      const payers = await linkPatientCoveragePayors({ medplum, organization, patientId: input.medplumPatientId });
      if (payers.linked > 0) {
        log(`linked ${payers.linked} Coverage(s) to ${payers.payers} payer organization(s)`);
      }
    } catch (err) {
      incomplete.payers = err instanceof Error ? err.message : String(err);
    }

    // Reciprocity: publish what we authored back to the network we just read
    // from. Carequality and CommonWell expect contribution in exchange for
    // query, so this is part of the pull, not an optional extra.
    await progress.phase('publishing to Zus (reciprocity)');
    try {
      const pushed = await pushReciprocity({
        medplum,
        zus,
        patient,
        zusPatientId: resolved.zusPatientId as string,
        upid: resolved.zusUniversalId as string,
        log,
      });
      counts['reciprocity:published'] = pushed.total;
      if (pushed.errors.length > 0) {
        incomplete.reciprocity = pushed.errors.join('; ').slice(0, 400);
      }
      log(`reciprocity: published ${pushed.total} resource(s) to Zus`);
    } catch (err) {
      // Failing to contribute must not discard a successful pull.
      incomplete.reciprocity = err instanceof Error ? err.message : String(err);
      log(`reciprocity failed: ${incomplete.reciprocity}`);
    }

    const durationMs = Date.now() - startedAt;
    await finishTask({ medplum, task, status: 'completed', counts, incomplete, durationMs });
    log(`done: ${total(counts)} resources in ${Math.round(durationMs / 1000)}s`);
    return { ok: true, counts, incomplete, taskId: task.id, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    await finishTask({ medplum, task, status: 'failed', counts, incomplete, durationMs, error: message });
    return { ok: false, error: message, taskId: task.id, durationMs };
  }
}

/**
 * Write one line of bot output.
 * @param message - What happened.
 */
function log(message: string): void {
  console.log(`[zus-import] ${message}`);
}

/**
 * Sum the per-type counts.
 * @param counts - Resources written per type.
 * @returns The total.
 */
function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * Reject a missing or blank required id.
 * @param props - The value under test.
 * @param props.value - The submitted value.
 * @param props.name - Input field name, for the message.
 */
function requireId(props: { value: unknown; name: string }): void {
  if (typeof props.value !== 'string' || props.value.trim() === '') {
    throw new Error(`${props.name} is required`);
  }
}

/**
 * Refuse to import into a Patient that belongs to a different clinic.
 *
 * `resolveCallerOrganization` establishes which clinic is asking; this
 * establishes that the target is theirs. Both are needed: the first alone still
 * lets clinic A stamp its own compartment onto clinic B's Patient.
 * @param props - The check inputs.
 * @param props.patient - The Medplum Patient being imported into.
 * @param props.organization - The caller's clinic.
 */
function assertSameOrganization(props: { patient: Patient; organization: Reference<Organization> }): void {
  const accounts = [props.patient.meta?.account, ...(props.patient.meta?.accounts ?? [])];
  const owned = accounts.some((account) => account?.reference === props.organization.reference);
  if (!owned) {
    throw new Error(
      `Patient/${props.patient.id} is not in ${props.organization.reference}'s compartment. ` +
        'Refusing to import another organization’s chart.'
    );
  }
}

/**
 * Race a promise against a timeout.
 *
 * `AbortSignal` is not in the bot sandbox, so the underlying request cannot be
 * cancelled — this bounds how long the run *waits* on it, which is the property
 * that matters when the alternative is spending the bot's whole 900s budget on
 * one wedged connection.
 * @param props - What to race.
 * @param props.promise - The operation to bound.
 * @param props.ms - How long to allow.
 * @param props.label - Shown in the timeout message.
 * @returns Whatever the promise resolves to.
 */
async function withTimeout<T>(props: { promise: Promise<T>; ms: number; label: string }): Promise<T> {
  let timer: ReturnType<typeof nodeSetTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = nodeSetTimeout(() => reject(new Error(`${props.label} timed out after ${props.ms}ms`)), props.ms);
  });
  try {
    return await Promise.race([props.promise, timeout]);
  } finally {
    if (timer) {
      nodeClearTimeout(timer);
    }
  }
}

/**
 * Read the clinic's Zus credentials and mint a token for this run.
 *
 * Zus is machine-to-machine: `client_credentials` every time, no refresh token
 * to rotate and nothing to persist. A clinic that stores a long-lived access
 * token instead (`authMode: "access_token"`) is honoured as-is.
 * @param props - The lookup inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The clinic whose credentials to use.
 * @param props.key - AES key for the stored secrets.
 * @returns An authenticated Zus connection.
 */
async function connectToZus(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  key: Buffer;
}): Promise<ZusConnection> {
  const record = await withMedplum429Retry(
    () =>
      readCredentialRecord({
        medplum: props.medplum,
        organization: props.organization,
        integration: 'zus',
      }),
    'read Zus credentials'
  );
  if (!record) {
    throw new Error(`Zus is not configured for ${props.organization.reference}`);
  }

  const values = getCredentialValues({ record, key: props.key });
  if (values.unreadableSecrets.length > 0) {
    throw new Error(
      `Zus credentials cannot be decrypted (${values.unreadableSecrets.join(', ')}). ` +
        'The encryption key has changed — re-enter them in Integrations.'
    );
  }

  const fhirUrl = (values.config.apiUrl || DEFAULT_ZUS_API_URL).replace(/\/$/, '');
  const sandbox = fhirUrl.includes('sandbox') || fhirUrl.includes('.dev.');
  const connection: Omit<ZusConnection, 'token'> = {
    fhirUrl,
    subscriptionsUrl: sandbox ? SUBSCRIPTIONS_URL_SANDBOX : SUBSCRIPTIONS_URL,
    builderId: values.config.builderId,
    packageId: values.config.packageId,
    practitionerNpi: values.config.practitionerNpi,
    practiceName: values.config.practiceName,
    practitionerRole: values.config.practitionerRole,
  };

  if (values.config.authMode === 'access_token') {
    if (!values.secrets.accessToken) {
      throw new Error('Zus authMode is "access_token" but no accessToken is stored');
    }
    return { ...connection, token: values.secrets.accessToken };
  }

  const { clientId, clientSecret } = values.secrets;
  if (!clientId || !clientSecret) {
    throw new Error('Zus clientId and clientSecret are both required');
  }

  // Stored inconsistently upstream: sometimes the bare host, sometimes with the
  // path already on it. Accept either rather than build `/oauth/token/oauth/token`.
  const base = (values.config.authUrl || DEFAULT_ZUS_AUTH_URL).replace(/\/$/, '');
  const tokenUrl = base.endsWith('/oauth/token') ? base : `${base}/oauth/token`;

  const res = await withTimeout({
    promise: fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        // The OAuth audience is the API host without the FHIR path.
        audience: fhirUrl.replace(/\/fhir$/, ''),
        grant_type: 'client_credentials',
      }),
    }),
    ms: ZUS_REQUEST_TIMEOUT_MS,
    label: 'Zus token',
  });

  if (!res.ok) {
    // Never echo the body: a token endpoint's error payload can carry the
    // credentials that were sent to it.
    throw new Error(`Zus token endpoint returned ${res.status}. Check the clinic's client id and secret.`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Zus token endpoint returned 200 with no access_token');
  }
  return { ...connection, token: body.access_token };
}

/**
 * Issue one Zus request, retrying 5xx *responses* as well as thrown errors.
 *
 * The distinction is the point. Zus answers 502 on long pulls, and a 502 is a
 * successful `fetch` — `try`/`catch` never fires, so a phase that only guards
 * against throws quietly yields zero resources and reports success.
 * @param props - The request inputs.
 * @param props.connection - Authenticated Zus connection.
 * @param props.url - Absolute URL to call.
 * @param props.label - Shown in retry and timeout messages.
 * @param props.headers - Extra headers to merge in.
 * @param props.method - HTTP method. Defaults to GET.
 * @param props.body - Request body for a POST.
 * @returns The final response, which may still be a 5xx once the budget is spent.
 */
async function zusFetch(props: {
  connection: ZusConnection;
  url: string;
  label: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${props.connection.token}`,
    Accept: 'application/fhir+json',
    'User-Agent': 'Lyfe-Medplum-Import/1.0',
    ...props.headers,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= ZUS_5XX_BACKOFFS_MS.length; attempt++) {
    const last = attempt === ZUS_5XX_BACKOFFS_MS.length;
    let res: Response;
    try {
      res = await withTimeout({
        promise: fetch(props.url, { method: props.method ?? 'GET', headers, body: props.body }),
        ms: ZUS_REQUEST_TIMEOUT_MS,
        label: props.label,
      });
    } catch (err) {
      lastError = err;
      if (last) {
        throw err;
      }
      log(`${props.label}: ${err instanceof Error ? err.message : String(err)} — retrying`);
      await sleep(ZUS_5XX_BACKOFFS_MS[attempt]);
      continue;
    }

    if (res.status < 500 || last) {
      return res;
    }
    // Drain the body so the socket can be reused, then back off.
    await res.text().catch(() => undefined);
    log(`${props.label}: HTTP ${res.status} — backing off ${ZUS_5XX_BACKOFFS_MS[attempt]}ms`);
    await sleep(ZUS_5XX_BACKOFFS_MS[attempt]);
  }
  throw lastError instanceof Error ? lastError : new Error(`${props.label}: retries exhausted`);
}

/**
 * Resolve the two Zus ids for a patient, registering them with Zus if needed.
 *
 * Zus uses two different ids and they are not interchangeable — the
 * builder-scoped `Patient.id` is what the subscription API enrols, while the
 * universal id (`upid`) is what the FHIR search parameter takes. Passing the
 * wrong one fails quietly: the search returns HTTP 200 with an empty bundle.
 * See the note at the top of this file.
 *
 * Resolution order:
 *   1. ids supplied by the caller, so an existing caller is unaffected
 *   2. the Zus identifiers already on the Medplum Patient, written by a
 *      previous run's `linkZusIdentifiers`
 *   3. registering the patient with Zus, which returns both
 *
 * Step 3 is the only one that writes anything outward, and it is reached only
 * for a patient Zus has never seen.
 * @param props - The lookup inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.zus - Authenticated Zus connection.
 * @param props.patient - The Medplum Patient being imported onto.
 * @param props.input - The caller's input, whose ids win when present.
 * @returns Both Zus ids.
 */
async function resolveZusPatientIds(props: {
  medplum: MedplumClient;
  zus: ZusConnection;
  patient: Patient;
  input: ZusImportInput;
}): Promise<{ zusPatientId: string; zusUniversalId: string }> {
  const supplied = {
    zusPatientId: props.input.zusPatientId?.trim(),
    zusUniversalId: props.input.zusUniversalId?.trim(),
  };
  if (supplied.zusPatientId && supplied.zusUniversalId) {
    return { zusPatientId: supplied.zusPatientId, zusUniversalId: supplied.zusUniversalId };
  }

  const identifiers = props.patient.identifier ?? [];
  const stored = {
    zusPatientId: identifiers.find((i) => i.system === `${ZUS_IDENTIFIER_BASE}/Patient`)?.value,
    zusUniversalId: identifiers.find((i) => i.system === ZUS_UNIVERSAL_ID_SYSTEM)?.value,
  };
  const zusPatientId = supplied.zusPatientId ?? stored.zusPatientId;
  const zusUniversalId = supplied.zusUniversalId ?? stored.zusUniversalId;
  if (zusPatientId && zusUniversalId) {
    log(`resolved Zus ids from Patient/${props.patient.id}`);
    return { zusPatientId, zusUniversalId };
  }

  return registerPatientWithZus({ zus: props.zus, patient: props.patient });
}

/**
 * Register a patient with Zus and return the ids Zus assigns.
 *
 * Zus requires a name and date of birth to match a person to its network; a
 * record without them would be registered but never aggregate anything, so
 * this refuses rather than creating an inert patient.
 * @param props - The registration inputs.
 * @param props.zus - Authenticated Zus connection.
 * @param props.patient - The Medplum Patient to mirror into Zus.
 * @returns Both Zus ids.
 */
async function registerPatientWithZus(props: {
  zus: ZusConnection;
  patient: Patient;
}): Promise<{ zusPatientId: string; zusUniversalId: string }> {
  const name = props.patient.name?.[0];
  const family = name?.family?.trim();
  const given = name?.given?.filter(Boolean).join(' ').trim();
  const birthDate = props.patient.birthDate;
  if (!family || !given || !birthDate) {
    throw new Error(
      `Patient/${props.patient.id} cannot be registered with Zus: a given name, family name and date of birth are all required ` +
        `(given=${given || 'missing'}, family=${family || 'missing'}, birthDate=${birthDate || 'missing'})`
    );
  }

  const body = {
    resourceType: 'Patient',
    active: true,
    name: [{ use: 'official', family, given: given.split(' ') }],
    birthDate,
    ...(props.patient.gender ? { gender: props.patient.gender } : {}),
    ...(props.patient.telecom?.length ? { telecom: props.patient.telecom } : {}),
    ...(props.patient.address?.length ? { address: props.patient.address } : {}),
  };

  const res = await zusFetch({
    connection: props.zus,
    url: `${props.zus.fhirUrl}/Patient`,
    label: 'Zus patient registration',
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zus refused to register Patient/${props.patient.id} (${res.status}): ${text.slice(0, 300)}`);
  }

  let created: { id?: string; identifier?: Identifier[] };
  try {
    created = JSON.parse(text) as { id?: string; identifier?: Identifier[] };
  } catch {
    throw new Error(`Zus returned a non-JSON response registering Patient/${props.patient.id}: ${text.slice(0, 200)}`);
  }

  const zusPatientId = created.id;
  const zusUniversalId = created.identifier?.find((i) => i.system === ZUS_UNIVERSAL_ID_SYSTEM)?.value;
  if (!zusPatientId || !zusUniversalId) {
    throw new Error(
      `Zus registered Patient/${props.patient.id} but did not return both ids ` +
        `(id=${zusPatientId ?? 'missing'}, upid=${zusUniversalId ?? 'missing'})`
    );
  }
  log(`registered Patient/${props.patient.id} with Zus (upid ${zusUniversalId})`);
  return { zusPatientId, zusUniversalId };
}

/**
 * Decide whether this patient may be enrolled in Zus.
 *
 * A patient qualifies when any of their encounters happened at an office whose
 * Zus-enrolment flag is on. Encounter is the only thing tying a patient to an
 * office, and it is already written by the DrChrono importer, so this needs no
 * new field on Patient and no second list to keep in step.
 *
 * The consequence worth knowing: a patient with no encounters yet — imported
 * before their first visit, or whose visits were all at offices switched off
 * in the Directory — is not eligible. That is the intended reading of an
 * office-based rule, but it makes "nothing happened" explicable rather than
 * mysterious, which is why the refusal names the cause.
 * @param props - The lookup inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The calling clinic.
 * @param props.medplumPatientId - The patient being considered.
 * @returns Whether to proceed, and why not when refusing.
 */
async function resolveZusEligibility(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  medplumPatientId: string;
}): Promise<{ eligible: true; via: string } | { eligible: false; reason: string }> {
  const enabled = await readZusEnabledLocationRefs(props.medplum, props.organization);
  if (enabled.size === 0) {
    return {
      eligible: false,
      reason:
        'No office has Zus enrolment switched on, so no patient can be enrolled. ' +
        'Turn it on for the relevant offices on the Directory page.',
    };
  }

  const encounters = await props.medplum.searchResources('Encounter', {
    patient: `Patient/${props.medplumPatientId}`,
    _count: '1000',
  });

  for (const encounter of encounters) {
    for (const entry of encounter.location ?? []) {
      const reference = entry.location?.reference;
      if (reference && enabled.has(reference)) {
        return { eligible: true, via: entry.location?.display ?? reference };
      }
    }
  }

  return {
    eligible: false,
    reason:
      `Patient/${props.medplumPatientId} has no encounter at an office with Zus enrolment switched on ` +
      `(${encounters.length} encounter(s) checked against ${enabled.size} enabled office(s)). ` +
      'Zus enrolment is configured per office on the Directory page.',
  };
}

/**
 * Make sure the patient is enrolled in the clinic's Zus data package.
 *
 * Enrolment is what makes Zus go and fetch the longitudinal record, so pulling
 * before it is active returns whatever happens to be cached — often nothing.
 *
 * The patient id used here is the **builder-scoped** one. Zus rejects the
 * universal id with "not builder's patient", and the wording is opaque enough
 * that the error is re-explained below rather than passed through raw.
 * @param props - The enrolment inputs.
 * @param props.zus - Authenticated Zus connection.
 * @param props.builderScopedPatientId - The builder-scoped Zus Patient resource id.
 * @returns The final status, and whether an enrolment already existed.
 */
async function ensureEnrolment(props: {
  zus: ZusConnection;
  builderScopedPatientId: string;
}): Promise<{ status: string; alreadyEnrolled: boolean }> {
  const existing = await readEnrolmentStatus(props);
  if (existing === 'active') {
    return { status: 'active', alreadyEnrolled: true };
  }

  if (!props.zus.packageId) {
    throw new Error('Zus packageId is not configured for this organization, so the patient cannot be enrolled');
  }

  const payload = {
    data: {
      type: 'patient-data-subscriptions/enrollment-status',
      attributes: {
        status: 'active',
        ...(props.zus.practitionerNpi
          ? {
              practitioner: {
                npi: props.zus.practitionerNpi,
                ...(props.zus.practiceName ? { name: props.zus.practiceName } : {}),
                ...(props.zus.practitionerRole ? { role: props.zus.practitionerRole } : {}),
              },
            }
          : {}),
      },
      relationships: {
        patient: { data: { id: props.builderScopedPatientId, type: 'fhir/Patient' } },
        package: { data: { id: props.zus.packageId, type: 'zap-data-subscriptions/package' } },
      },
    },
  };

  const res = await zusFetch({
    connection: props.zus,
    url: `${props.zus.subscriptionsUrl}/zap-data-subscriptions/enrollment-statuses`,
    label: 'Zus enrolment',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(props.zus.builderId ? { 'Zus-Account': props.zus.builderId } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 409) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 403 || /builder|not your patient|does not belong/i.test(detail)) {
      throw new Error(
        `Zus refused to enrol ${props.builderScopedPatientId} (${res.status}): ${detail}. ` +
          'Enrolment takes the BUILDER-SCOPED Zus Patient resource id, not the universal id (upid) — ' +
          'check which of the two was passed as zusPatientId.'
      );
    }
    throw new Error(`Zus enrolment returned ${res.status}: ${detail}`);
  }

  // Enrolment is asynchronous: a 2xx means accepted, not aggregated.
  for (let attempt = 0; attempt < ENROLMENT_POLL_ATTEMPTS; attempt++) {
    const status = await readEnrolmentStatus(props);
    if (status === 'active') {
      return { status: 'active', alreadyEnrolled: false };
    }
    if (status && status !== 'pending') {
      return { status, alreadyEnrolled: false };
    }
    await sleep(ENROLMENT_POLL_DELAY_MS);
  }
  return { status: 'pending', alreadyEnrolled: false };
}

/**
 * Read the patient's current enrolment status from Zus.
 * @param props - The lookup inputs.
 * @param props.zus - Authenticated Zus connection.
 * @param props.builderScopedPatientId - The builder-scoped Zus Patient resource id.
 * @returns The status string, or undefined when there is no enrolment at all.
 */
async function readEnrolmentStatus(props: {
  zus: ZusConnection;
  builderScopedPatientId: string;
}): Promise<string | undefined> {
  const url =
    `${props.zus.subscriptionsUrl}/zap-data-subscriptions/enrollment-statuses` +
    `?filter[patient-id]=${encodeURIComponent(props.builderScopedPatientId)}`;
  const res = await zusFetch({
    connection: props.zus,
    url,
    label: 'Zus enrolment status',
    headers: props.zus.builderId ? { 'Zus-Account': props.zus.builderId } : undefined,
  });
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`Zus enrolment status returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: { attributes?: { status?: string } }[] };
  return body.data?.[0]?.attributes?.status;
}

/**
 * Record both Zus ids on the Medplum Patient, so the next run can find them.
 *
 * Idempotent, and a failure here is non-fatal: the identifiers are a convenience
 * for later lookups, not something the import depends on.
 * @param props - The update inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.patient - The Patient as it currently stands.
 * @param props.input - The two Zus ids from the caller.
 */
async function linkZusIdentifiers(props: {
  medplum: MedplumClient;
  patient: Patient;
  input: ZusImportInput;
}): Promise<void> {
  const wanted: Identifier[] = [
    { use: 'secondary', system: ZUS_UNIVERSAL_ID_SYSTEM, value: props.input.zusUniversalId },
    { use: 'secondary', system: `${ZUS_IDENTIFIER_BASE}/Patient`, value: props.input.zusPatientId },
  ];
  const existing = props.patient.identifier ?? [];
  const missing = wanted.filter((id) => !existing.some((e) => e.system === id.system && e.value === id.value));
  if (missing.length === 0) {
    return;
  }
  try {
    await withMedplum429Retry(
      () => props.medplum.updateResource<Patient>({ ...props.patient, identifier: [...existing, ...missing] }),
      'update Patient identifiers'
    );
    log(`added ${missing.length} Zus identifier(s) to Patient/${props.patient.id}`);
  } catch (err) {
    log(`could not add Zus identifiers: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Pull one resource type out of Zus and write it into Medplum.
 *
 * Every write is a conditional update keyed on the Zus id, so pulling a
 * resource that is already here updates it in place rather than writing a
 * second copy. What that alone does *not* protect is a resource a clinician
 * has since edited — a conditional update replaces the whole resource — so the
 * local index read here decides, per resource, whether overwriting it is
 * allowed at all. See `shared/local-edits.ts`.
 *
 * The index read is deliberately **not** wrapped in a try/catch. If it fails,
 * it must take the type with it: writing the whole type blind is precisely the
 * outcome the guard exists to prevent, and the caller already records a thrown
 * type as incomplete without failing the run.
 * @param props - The import inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.zus - Authenticated Zus connection.
 * @param props.resourceType - FHIR resource type to mirror.
 * @param props.upid - Zus universal patient id, the FHIR search key.
 * @param props.patientRef - The Medplum Patient everything is re-anchored to.
 * @param props.organization - The clinic compartment to stamp.
 * @param props.referenceMap - Zus-to-Medplum reference map, read and extended in place.
 * @returns What was written, what was declined and why, and why the pull was short if it was.
 */
async function importResourceType(props: {
  medplum: MedplumClient;
  zus: ZusConnection;
  resourceType: string;
  upid: string;
  patientRef: Reference<Patient>;
  organization: Reference<Organization>;
  referenceMap: Map<string, string>;
}): Promise<{
  wrote: number;
  declined: DeclineTally;
  declineDetail: Partial<Record<DeclineReason, string>>;
  reason?: string;
}> {
  const pull = await pullAllPages({
    zus: props.zus,
    resourceType: props.resourceType,
    upid: props.upid,
  });
  log(`${props.resourceType}: ${pull.resources.length} from Zus across ${pull.pages} page(s)`);

  if (pull.resources.length === 0) {
    return { wrote: 0, declined: {}, declineDetail: {}, reason: pull.complete ? undefined : pull.reason };
  }

  const system = `${ZUS_IDENTIFIER_BASE}/${props.resourceType}`;

  const candidates: { sourceId: string; value: Resource }[] = [];
  let skipped = 0;
  for (const raw of pull.resources) {
    const prepared = retagForMedplum({
      raw,
      resourceType: props.resourceType,
      patientRef: props.patientRef,
      organization: props.organization,
      referenceMap: props.referenceMap,
    });
    if (!prepared) {
      skipped++;
      continue;
    }
    candidates.push({ sourceId: prepared.zusId, value: prepared.resource });
  }
  if (skipped > 0) {
    log(`${props.resourceType}: skipped ${skipped} resource(s) with no Zus id to key on`);
  }

  // The guard reads what is already here and hands back only what may be
  // written. There is no list of entries before this call, which is the point.
  const selection = await selectWritable({
    medplum: props.medplum,
    resourceType: props.resourceType,
    patient: props.patientRef,
    system,
    items: candidates,
  });
  const { declined, declineDetail } = selection;

  // A resource that was kept rather than rewritten is still a Zus id this
  // project knows, so later types can point at the copy already here. Leaving
  // it out would dangle their references at a Zus id that means nothing in
  // Medplum — the resource was preserved, not lost.
  for (const [sourceId, medplumId] of selection.existingIds) {
    props.referenceMap.set(`${props.resourceType}/${sourceId}`, `${props.resourceType}/${medplumId}`);
  }

  const entries = selection.writable.map((item) => ({
    resourceType: props.resourceType,
    resource: item.value,
    system,
    value: item.sourceId,
  }));
  const zusIds = selection.writable.map((item) => item.sourceId);

  const declineSummary = describeDeclines(declined, declineDetail);
  if (declineSummary) {
    log(`${props.resourceType}: ${declineSummary}`);
  }

  if (props.resourceType === 'DocumentReference') {
    await rehostZusDocumentFiles({
      medplum: props.medplum,
      zus: props.zus,
      patientRef: props.patientRef,
      entries,
    });
  }

  const result = await upsertBatch(props.medplum, entries, { label: `zus-import ${props.resourceType}` });

  // Feed this type's ids forward so later types can repoint their references.
  for (let i = 0; i < result.ids.length; i++) {
    const medplumId = result.ids[i];
    if (medplumId) {
      props.referenceMap.set(`${props.resourceType}/${zusIds[i]}`, `${props.resourceType}/${medplumId}`);
    }
  }

  const reasons: string[] = [];
  if (!pull.complete && pull.reason) {
    reasons.push(pull.reason);
  }
  if (result.failed > 0) {
    reasons.push(`${result.failed}/${entries.length} writes did not settle 2xx`);
  }
  return { wrote: result.wrote, declined, declineDetail, reason: reasons.length > 0 ? reasons.join('; ') : undefined };
}

/** Cap on Zus document files copied in one run; the rest keep Zus's link until the next run. */
const MAX_ZUS_DOCUMENT_FILES = 300;

/** In-flight Zus file downloads. */
const ZUS_FILE_CONCURRENCY = 4;

/**
 * The URL to download a Zus attachment from, with the Zus token.
 *
 * Only Zus's own FHIR server is called: a document can point anywhere, and the
 * bearer token must never be sent to a third-party host.
 * @param zus - Authenticated Zus connection.
 * @param url - The attachment URL as Zus returned it.
 * @returns The absolute Zus URL, or undefined when the file is not on Zus.
 */
function zusFileUrl(zus: ZusConnection, url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  if (url.startsWith('Binary/')) {
    return `${zus.fhirUrl}/${url}`;
  }
  return url.startsWith(`${zus.fhirUrl}/`) ? url : undefined;
}

/**
 * Download one file from Zus. A FHIR Binary may come back raw or wrapped as
 * JSON with base64 `data`, depending on how Zus honours the Accept header.
 * @param zus - Authenticated Zus connection.
 * @param url - Absolute Zus URL.
 * @returns The bytes and the type Zus reported, or undefined when the download failed.
 */
async function downloadZusFile(
  zus: ZusConnection,
  url: string
): Promise<{ data: Uint8Array; contentType?: string } | undefined> {
  const res = await zusFetch({ connection: zus, url, label: `zus file ${url}`, headers: { Accept: '*/*' } });
  if (!res.ok) {
    await res.text().catch(() => undefined);
    return undefined;
  }
  const headerType = res.headers.get('content-type') ?? undefined;
  if (headerType?.includes('json')) {
    const body = (await res.json()) as Partial<Binary>;
    if (body.resourceType === 'Binary' && body.data) {
      return { data: new Uint8Array(NodeBuffer.from(body.data, 'base64')), contentType: body.contentType };
    }
    return { data: new Uint8Array(NodeBuffer.from(JSON.stringify(body))), contentType: headerType };
  }
  return { data: new Uint8Array(await res.arrayBuffer()), contentType: headerType };
}

/**
 * Files already copied into Medplum by an earlier run, keyed by Zus id and
 * index-aligned to `DocumentReference.content`, so a re-import reuses them.
 * @param medplum - Bot-scoped Medplum client.
 * @param patientRef - The Medplum Patient.
 * @returns Zus document id to its stored attachments.
 */
async function loadStoredZusFiles(
  medplum: MedplumClient,
  patientRef: Reference<Patient>
): Promise<Map<string, (Pick<Attachment, 'contentType' | 'url' | 'size'> | undefined)[]>> {
  const stored = new Map<string, (Pick<Attachment, 'contentType' | 'url' | 'size'> | undefined)[]>();
  const system = `${ZUS_IDENTIFIER_BASE}/DocumentReference`;
  const baseUrl = medplum.getBaseUrl();
  for await (const page of medplum.searchResourcePages('DocumentReference', {
    patient: patientRef.reference as string,
    _elements: 'identifier,content',
    _count: '1000',
  })) {
    for (const doc of page) {
      const zusId = doc.identifier?.find((i) => i.system === system)?.value;
      if (!zusId) {
        continue;
      }
      stored.set(
        zusId,
        (doc.content ?? []).map(({ attachment }) => {
          const binary = storedBinaryReference(attachment.url, baseUrl);
          return binary && attachment.contentType
            ? { contentType: attachment.contentType, url: binary, size: attachment.size }
            : undefined;
        })
      );
    }
  }
  return stored;
}

/**
 * Copy each Zus document's file into Medplum before the documents are written.
 *
 * Zus attachments point at Zus's own `Binary` endpoint, which only answers with
 * the bot's Zus token, or carry the file inline as base64 (typical for C-CDA
 * XML). Neither can be previewed in the app, so each is stored as a Medplum
 * Binary and the attachment is repointed at it. Files stored by an earlier run
 * are reused. A file that cannot be fetched keeps Zus's link and is retried on
 * the next run.
 * @param props - The inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.zus - Authenticated Zus connection.
 * @param props.patientRef - The Medplum Patient.
 * @param props.entries - The prepared DocumentReferences, mutated in place.
 */
async function rehostZusDocumentFiles(props: {
  medplum: MedplumClient;
  zus: ZusConnection;
  patientRef: Reference<Patient>;
  entries: { resource: Resource; value: string }[];
}): Promise<void> {
  let stored = new Map<string, (Pick<Attachment, 'contentType' | 'url' | 'size'> | undefined)[]>();
  try {
    stored = await loadStoredZusFiles(props.medplum, props.patientRef);
  } catch (err) {
    log(`DocumentReference: could not read stored files: ${err instanceof Error ? err.message : String(err)}`);
  }

  const jobs: { doc: DocumentReference; attachment: Attachment; zusId: string; index: number }[] = [];
  let reused = 0;
  for (const entry of props.entries) {
    const doc = entry.resource as DocumentReference;
    (doc.content ?? []).forEach(({ attachment }, index) => {
      const previous = stored.get(entry.value)?.[index];
      if (previous) {
        Object.assign(attachment, previous);
        delete attachment.data;
        reused++;
      } else if (attachment.data || zusFileUrl(props.zus, attachment.url)) {
        jobs.push({ doc, attachment, zusId: entry.value, index });
      }
    });
  }
  const pending = jobs.slice(0, MAX_ZUS_DOCUMENT_FILES);
  if (pending.length > 0) {
    log(`DocumentReference: copying ${pending.length} file(s) into Medplum (${reused} already stored)`);
  }

  let copied = 0;
  await mapWithConcurrency(pending, ZUS_FILE_CONCURRENCY, async ({ doc, attachment, zusId, index }) => {
    try {
      const file = attachment.data
        ? { data: new Uint8Array(NodeBuffer.from(attachment.data, 'base64')), contentType: attachment.contentType }
        : await downloadZusFile(props.zus, zusFileUrl(props.zus, attachment.url) as string);
      if (!file) {
        return;
      }
      const storedFile = await storeFile(
        props.medplum,
        file.data,
        attachment.contentType ?? file.contentType,
        [attachment.title, doc.description, attachment.url],
        `zus-document-${zusId}-${index}`
      );
      Object.assign(attachment, storedFile);
      delete attachment.data;
      copied++;
    } catch (err) {
      log(`DocumentReference ${zusId}: file copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (pending.length > 0) {
    log(`DocumentReference: copied ${copied}/${pending.length} file(s)`);
  }
}

/**
 * Follow Zus's `next` links to exhaustion for one resource type.
 *
 * A page that fails ends the pull and marks it incomplete rather than throwing,
 * so the pages already in hand are still written — but the shortfall is reported
 * instead of being indistinguishable from "this patient has 10 allergies".
 * @param props - The pull inputs.
 * @param props.zus - Authenticated Zus connection.
 * @param props.resourceType - FHIR resource type to search.
 * @param props.upid - Zus universal patient id.
 * @returns Every resource read, and whether the pull ran to completion.
 */
async function pullAllPages(props: { zus: ZusConnection; resourceType: string; upid: string }): Promise<PullResult> {
  const resources: RawResource[] = [];
  const search = `?upid=${encodeURIComponent(props.upid)}&_count=${ZUS_PAGE_SIZE}`;
  let url: string | undefined = `${props.zus.fhirUrl}/${props.resourceType}${search}`;
  let pages = 0;

  while (url) {
    if (pages >= ZUS_MAX_PAGES) {
      return { resources, pages, complete: false, reason: `stopped at the ${ZUS_MAX_PAGES}-page cap` };
    }
    const res = await zusFetch({
      connection: props.zus,
      url,
      label: `Zus ${props.resourceType} page ${pages + 1}`,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return {
        resources,
        pages,
        complete: false,
        reason: `page ${pages + 1} returned HTTP ${res.status} after retries: ${detail}`,
      };
    }

    const bundle = (await res.json()) as Bundle;
    for (const entry of bundle.entry ?? []) {
      if (entry.resource) {
        resources.push(entry.resource as unknown as RawResource);
      }
    }
    pages++;

    const next = (bundle.link ?? []).find((link) => link.relation === 'next')?.url;
    url = next;
    if (url) {
      await sleep(ZUS_INTER_PAGE_DELAY_MS);
    }
  }
  return { resources, pages, complete: true };
}

/**
 * Re-anchor and tag one Zus resource so it can be written into this project.
 *
 * Five things happen, in this order:
 *
 *  1. Zus's server-assigned `id` is removed and kept as a business identifier.
 *     Medplum assigns its own id; the Zus id is what makes a re-run an update
 *     rather than a duplicate.
 *  2. References to other Zus resources already imported are repointed at their
 *     Medplum copies, so the clinical graph survives the move.
 *  3. `subject` / `patient` / `beneficiary` are re-anchored at the Medplum
 *     Patient. This runs *after* step 2 so the Patient reference always wins.
 *  4. Zus's own `meta.tag` entries are kept — they carry the data's provenance
 *     (Carequality org, repository, owning builder) — and the Lyfe source tag is
 *     appended.
 *  5. `meta.account` is set to the clinic. Without it the resource lands outside
 *     the compartment and is invisible under the clinic access policy, despite a
 *     perfectly successful write.
 * @param props - The resource and what to anchor it to.
 * @param props.raw - The resource exactly as Zus returned it. Mutated in place.
 * @param props.resourceType - The type being imported.
 * @param props.patientRef - The Medplum Patient.
 * @param props.organization - The clinic compartment.
 * @param props.referenceMap - Zus-to-Medplum reference map built by earlier types.
 * @returns The prepared resource and its Zus id, or undefined when it has no id to key on.
 */
function retagForMedplum(props: {
  raw: RawResource;
  resourceType: string;
  patientRef: Reference<Patient>;
  organization: Reference<Organization>;
  referenceMap: Map<string, string>;
}): { resource: Resource; zusId: string } | undefined {
  const zusId = typeof props.raw.id === 'string' ? props.raw.id : undefined;
  if (!zusId) {
    return undefined;
  }

  const out = props.raw;
  delete out.id;

  if (props.referenceMap.size > 0) {
    rewriteReferences({ node: out, referenceMap: props.referenceMap });
  }

  for (const field of ['subject', 'patient', 'beneficiary']) {
    const value = out[field] as { reference?: string } | undefined;
    if (value?.reference?.startsWith('Patient/')) {
      out[field] = props.patientRef;
    }
  }

  const meta = (out.meta ?? {}) as { tag?: Coding[]; versionId?: string; lastUpdated?: string };
  delete meta.versionId;
  delete meta.lastUpdated;
  const tag = meta.tag ?? [];
  if (!tag.some((t) => t.system === SOURCE_TAG.system && t.code === SOURCE_TAG.code)) {
    tag.push(SOURCE_TAG);
  }
  out.meta = { ...meta, tag, account: props.organization, accounts: [props.organization] };

  const identifier = (out.identifier as Identifier[] | undefined) ?? [];
  const system = `${ZUS_IDENTIFIER_BASE}/${props.resourceType}`;
  if (!identifier.some((id) => id.system === system && id.value === zusId)) {
    identifier.push({ system, value: zusId });
  }
  out.identifier = identifier;

  return { resource: out as unknown as Resource, zusId };
}

/**
 * Rewrite every `reference` string that names an already-imported Zus resource.
 *
 * Walks the whole resource because FHIR puts references in a dozen shapes —
 * `Observation.encounter`, `DiagnosticReport.result[]`,
 * `DocumentReference.context.encounter[]` — and enumerating them by hand means
 * missing one.
 * @param props - The traversal inputs.
 * @param props.node - The current object, array or scalar. Mutated in place.
 * @param props.referenceMap - Zus reference to Medplum reference.
 */
function rewriteReferences(props: { node: unknown; referenceMap: Map<string, string> }): void {
  const node = props.node;
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      rewriteReferences({ node: item, referenceMap: props.referenceMap });
    }
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.reference === 'string') {
    const replacement = props.referenceMap.get(record.reference);
    if (replacement) {
      record.reference = replacement;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'reference') {
      rewriteReferences({ node: value, referenceMap: props.referenceMap });
    }
  }
}

/**
 * Open the Task that records this import.
 *
 * Created before any work so that a run which dies mid-import still leaves a
 * trace. A chart that is half-imported with no record of why is the thing this
 * exists to prevent.
 * @param props - The Task inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The clinic compartment.
 * @param props.input - The caller's input, echoed into `Task.input`.
 * @returns The created Task.
 */
async function createTask(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  input: ZusImportInput;
}): Promise<WithId<Task>> {
  const now = new Date().toISOString();
  return withMedplum429Retry(
    () =>
      props.medplum.createResource<Task>({
        resourceType: 'Task',
        meta: { account: props.organization, accounts: [props.organization] },
        status: 'in-progress',
        intent: 'order',
        code: { text: 'zus-import' },
        for: { reference: `Patient/${props.input.medplumPatientId}` },
        authoredOn: now,
        lastModified: now,
        executionPeriod: { start: now },
        input: [
          { type: { text: 'zusPatientId' }, valueString: props.input.zusPatientId },
          { type: { text: 'zusUniversalId' }, valueString: props.input.zusUniversalId },
        ],
      }),
    'create Task'
  );
}

/**
 * Close the Task with the counts, whether the run succeeded or not.
 *
 * Failures here are swallowed: losing the bookkeeping must not turn a successful
 * import into a reported failure.
 * @param props - The closing inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.task - The Task opened at the start of the run.
 * @param props.status - `completed` or `failed`.
 * @param props.counts - Resources written per type.
 * @param props.incomplete - Types that could not be pulled in full, with reasons.
 * @param props.durationMs - Wall-clock duration of the run.
 * @param props.error - The failure message, when there is one.
 */
async function finishTask(props: {
  medplum: MedplumClient;
  task: Task;
  status: 'completed' | 'failed';
  counts: Record<string, number>;
  incomplete: Record<string, string>;
  durationMs: number;
  error?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const output: NonNullable<Task['output']> = Object.entries(props.counts).map(([resourceType, count]) => ({
    type: { text: resourceType },
    valueInteger: count,
  }));
  output.push({ type: { text: 'total' }, valueInteger: total(props.counts) });
  output.push({ type: { text: 'durationMs' }, valueInteger: props.durationMs });
  for (const [key, reason] of Object.entries(props.incomplete)) {
    output.push({ type: { text: `incomplete:${key}` }, valueString: reason });
  }
  if (props.error) {
    output.push({ type: { text: 'error' }, valueString: props.error });
  }

  try {
    await withMedplum429Retry(
      () =>
        props.medplum.updateResource<Task>({
          ...props.task,
          status: props.status,
          lastModified: now,
          businessStatus: { text: props.status === 'completed' ? 'complete' : 'failed' },
          executionPeriod: { ...props.task.executionPeriod, end: now },
          ...(props.error ? { statusReason: buildStatusReason(props.error) } : {}),
          output,
        }),
      'update Task'
    );
  } catch (err) {
    log(`could not close Task/${props.task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
