// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The onboarding flow's data access, kept in one place deliberately.
 *
 * DrChrono cannot be called from the browser: the token would ship in client JS
 * and DrChrono sends no CORS headers for a browser origin. These calls go to the
 * `lyfe-drchrono-search` bot, which runs server-side and reads the calling
 * clinic's own credentials — so a clinic searches its own DrChrono practice, not
 * a shared one.
 *
 * This previously posted to a dev-only Vite middleware, which existed only under
 * `vite dev` and would have 404'd in any production build.
 */
import type { MedplumClient } from '@medplum/core';
import type { OperationOutcome } from '@medplum/fhirtypes';

export interface DrChronoPatientSummary {
  readonly id: number;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly dateOfBirth?: string;
  readonly gender?: string;
  readonly chartId?: string;
  readonly email?: string;
  readonly cellPhone?: string;
}

/** Identifier of the bot that performs the read-only DrChrono lookups. */
const SEARCH_BOT_IDENTIFIER = 'https://lyfe.health/bots|lyfe-drchrono-search';

/**
 * Thrown when the search bot is absent or refuses the call, so the UI can say
 * which of the two it was instead of rendering a bare failure.
 */
export class OnboardingBackendUnavailableError extends Error {}

/**
 * Invoke the search bot, normalising both failure modes into one error type.
 * @param medplum - Authenticated Medplum client.
 * @param input - The action and its arguments.
 * @returns The bot's parsed response.
 */
async function executeSearchBot<T>(medplum: MedplumClient, input: Record<string, unknown>): Promise<T> {
  let bot;
  try {
    bot = await medplum.searchOne('Bot', { identifier: SEARCH_BOT_IDENTIFIER });
  } catch (err) {
    throw new OnboardingBackendUnavailableError(
      `Could not look up the DrChrono search bot: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!bot?.id) {
    throw new OnboardingBackendUnavailableError(
      `No Bot found with identifier ${SEARCH_BOT_IDENTIFIER}. Run "npm run deploy:bots".`
    );
  }
  const body = (await medplum.executeBot(bot.id, input, 'application/json')) as T & {
    ok?: boolean;
    error?: string;
  };
  // The bot reports configuration failures in-band rather than throwing, so a
  // useful message survives instead of becoming a generic 500.
  if (body?.ok === false && body.error) {
    throw new OnboardingBackendUnavailableError(body.error);
  }
  return body;
}

/**
 * Search DrChrono for candidates to import. DrChrono has no free-text patient
 * endpoint, so the server fans the term out across last name, first name and
 * chart id and merges the results.
 * @param medplum - Authenticated Medplum client.
 * @param query - The text typed by the user; fewer than two characters returns nothing.
 * @returns The matching DrChrono patients.
 */
export async function searchDrChronoPatients(medplum: MedplumClient, query: string): Promise<DrChronoPatientSummary[]> {
  if (query.trim().length < 2) {
    return [];
  }
  const body = await executeSearchBot<{ results?: DrChronoPatientSummary[] }>(medplum, {
    action: 'search',
    query,
  });
  return body.results ?? [];
}

/**
 * Display name for a DrChrono record, falling back to the chart id.
 * @param patient - The DrChrono patient summary to label.
 * @returns A human-readable name, falling back to chart id then patient id.
 */
export function formatDrChronoName(patient: DrChronoPatientSummary): string {
  const name = [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim();
  return name || patient.chartId || `Patient ${patient.id}`;
}

export interface BulkImportCandidate extends DrChronoPatientSummary {
  /** How many appointments this patient had in the selected window. */
  readonly appointments: number;
}

export interface BulkImportPreview {
  /** Appointments examined, before cancelled/rescheduled/no-show were dropped. */
  readonly scannedAppointments: number;
  readonly candidates: BulkImportCandidate[];
  /** Appointments dropped because their office or provider is switched off. */
  readonly skippedByDirectory: number;
  /** Cancelled, rescheduled or no-show appointments, which never happened. */
  readonly excludedByStatus: number;
}

/**
 * Every distinct patient with an appointment in a date range.
 *
 * This is the "import everyone on Tuesday's schedule" flow. Cancelled,
 * rescheduled and no-show appointments are excluded server-side, since those
 * never produced a visit worth pulling a chart for. So are appointments at an
 * office or with a provider the clinic has switched off in the Directory.
 * @param medplum - Authenticated Medplum client.
 * @param start - First appointment date, as YYYY-MM-DD.
 * @param end - Last appointment date; defaults to `start` when omitted.
 * @returns The candidates and how many appointments were scanned.
 */
export async function previewBulkImport(
  medplum: MedplumClient,
  start: string,
  end: string | undefined
): Promise<BulkImportPreview> {
  const body = await executeSearchBot<{
    scannedAppointments?: number;
    results?: BulkImportCandidate[];
    skippedByDirectory?: number;
    excludedByStatus?: number;
  }>(medplum, { action: 'preview', start, ...(end ? { end } : {}) });
  return {
    scannedAppointments: body.scannedAppointments ?? 0,
    candidates: body.results ?? [],
    skippedByDirectory: body.skippedByDirectory ?? 0,
    excludedByStatus: body.excludedByStatus ?? 0,
  };
}

/** Identifier system DrChrono patients are stamped with when imported. */
export const DRCHRONO_IDENTIFIER_SYSTEM = 'https://drchrono.com/patients';

/** Identifier of the bot that imports one DrChrono chart into Medplum. */
const IMPORT_BOT_IDENTIFIER = 'https://lyfe.health/bots|lyfe-drchrono-import';

export interface ImportResult {
  readonly ok: boolean;
  readonly medplumPatientId?: string;
  readonly counts?: Record<string, number>;
  readonly taskId?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

/**
 * Bot ids, looked up once per session.
 *
 * A bulk run starts a job per patient, and each start needs the bot's id. A
 * hundred-odd identical searches for a resource that cannot change mid-run is
 * latency spent for nothing, right at the point the run is trying to get all
 * of its work queued quickly.
 */
const botIdCache = new Map<string, Promise<string>>();

/**
 * Resolve a bot's id from its identifier, once.
 * @param medplum - Authenticated Medplum client.
 * @param botIdentifier - `system|value` identifier of the bot.
 * @returns The bot's resource id.
 */
async function resolveBotId(medplum: MedplumClient, botIdentifier: string): Promise<string> {
  const cached = botIdCache.get(botIdentifier);
  if (cached) {
    return cached;
  }
  const pending = medplum.searchOne('Bot', { identifier: botIdentifier }).then((bot) => {
    if (!bot?.id) {
      throw new OnboardingBackendUnavailableError(
        `No Bot found with identifier ${botIdentifier}. Run "npm run deploy:bots".`
      );
    }
    return bot.id;
  });
  // Cached as the promise, not the result, so concurrent starts share one
  // search rather than racing to issue their own.
  botIdCache.set(botIdentifier, pending);
  // A failed lookup must not be remembered: deploying the bots should fix it
  // without a reload.
  pending.catch(() => botIdCache.delete(botIdentifier));
  return pending;
}

/**
 * Start a bot as a server-side async job and return its id, without waiting.
 *
 * Splitting "start" from "wait" is what makes a bulk run parallel. While the
 * two were one function, a caller could only ever hold one import open at a
 * time, so 122 patients ran strictly one after another — and closing the tab
 * abandoned every patient that had not been reached yet, because the loop
 * driving them lived in the page.
 *
 * A started job belongs to the server. It survives the tab closing, and the
 * `Task` it writes is what the Imports page reads, so a run stays inspectable
 * whether or not anyone is watching it.
 * @param medplum - Authenticated Medplum client.
 * @param botIdentifier - `system|value` identifier of the bot to run.
 * @param input - The bot's input, sent as JSON.
 * @returns The AsyncJob id.
 */
async function startBotJob(
  medplum: MedplumClient,
  botIdentifier: string,
  input: Record<string, string>
): Promise<string> {
  const botId = await resolveBotId(medplum, botIdentifier);

  // Deliberately async, not a plain executeBot.
  //
  // Railway caps any single request at 300s. A synchronous $execute of a real
  // chart import is killed at that ceiling with a 502 — and MedplumClient
  // RETRIES it, which starts a SECOND concurrent import of the same patient
  // while the first is still running server-side. The async pattern returns
  // immediately with a job to poll, and has no such ceiling.
  const accepted = await medplum.startAsyncRequest<OperationOutcome>(`fhir/R4/Bot/${botId}/$execute`, {
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json' },
  });

  const statusUrl = accepted.issue?.[0]?.diagnostics ?? '';
  const jobId = /\/job\/([0-9a-f-]+)\/status/.exec(statusUrl)?.[1];
  if (!jobId) {
    throw new Error(`Job did not start: ${statusUrl || 'no job id in response'}`);
  }
  return jobId;
}

/**
 * Wait for a started job and return whatever the bot responded with.
 * @param medplum - Authenticated Medplum client.
 * @param jobId - The AsyncJob to wait on.
 * @param options - Polling settings.
 * @param options.maxPolls - How many times to poll before giving up.
 * @param options.label - Prefix for the progress message, e.g. "importing".
 * @param options.timeoutMessage - Returned as the error when the job outlives `maxPolls`.
 * @param options.onProgress - Called with a human-readable status while the job runs.
 * @returns The bot's parsed response, or a failure describing what went wrong.
 */
async function awaitBotJob<T extends { ok: boolean; error?: string }>(
  medplum: MedplumClient,
  jobId: string,
  options: {
    maxPolls: number;
    label: string;
    timeoutMessage: string;
    onProgress?: (status: string) => void;
  }
): Promise<T> {
  const POLL_MS = 5000;
  for (let i = 0; i < options.maxPolls; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
    const job = await medplum.readResource('AsyncJob', jobId);
    if (job.status === 'completed') {
      const raw = job.output?.parameter?.find((p) => p.name === 'responseBody')?.valueString;
      return raw ? (JSON.parse(raw) as T) : ({ ok: true } as T);
    }
    if (job.status === 'error') {
      return { ok: false, error: `${options.label} failed — see the Task for details.` } as T;
    }
    options.onProgress?.(`${options.label}… ${Math.round(((i + 1) * POLL_MS) / 1000)}s`);
  }
  return { ok: false, error: options.timeoutMessage } as T;
}

/** How many polls a DrChrono chart import gets: 20 minutes. */
const DRCHRONO_MAX_POLLS = 240;

/** How many polls a Zus pull gets: 25 minutes; a full record took 19. */
const ZUS_MAX_POLLS = 300;

/**
 * Start one DrChrono chart import, without waiting for it.
 * @param medplum - Authenticated Medplum client.
 * @param drchronoPatientId - The DrChrono patient id to import.
 * @returns The AsyncJob id, already running server-side.
 */
export async function startDrChronoImport(medplum: MedplumClient, drchronoPatientId: number | string): Promise<string> {
  return startBotJob(medplum, IMPORT_BOT_IDENTIFIER, {
    action: 'import',
    drchronoPatientId: String(drchronoPatientId),
  });
}

/**
 * Wait for a DrChrono chart import started by {@link startDrChronoImport}.
 * @param medplum - Authenticated Medplum client.
 * @param jobId - The AsyncJob to wait on.
 * @param onProgress - Called with a human-readable status while the job runs.
 * @returns The bot's result, including per-resource-type counts on success.
 */
export async function awaitDrChronoImport(
  medplum: MedplumClient,
  jobId: string,
  onProgress?: (status: string) => void
): Promise<ImportResult> {
  return awaitBotJob<ImportResult>(medplum, jobId, {
    maxPolls: DRCHRONO_MAX_POLLS,
    label: 'importing',
    timeoutMessage: 'Import is still running after 20 minutes; check the Task.',
    onProgress,
  });
}

/**
 * Start one Zus pull, without waiting for it.
 * @param medplum - Authenticated Medplum client.
 * @param medplumPatientId - The Medplum Patient to import onto.
 * @returns The AsyncJob id, already running server-side.
 */
export async function startZusImport(medplum: MedplumClient, medplumPatientId: string): Promise<string> {
  return startBotJob(medplum, ZUS_BOT_IDENTIFIER, { action: 'import', medplumPatientId });
}

/**
 * Wait for a Zus pull started by {@link startZusImport}.
 * @param medplum - Authenticated Medplum client.
 * @param jobId - The AsyncJob to wait on.
 * @param onProgress - Called with a human-readable status while the job runs.
 * @returns The bot's result.
 */
export async function awaitZusImport(
  medplum: MedplumClient,
  jobId: string,
  onProgress?: (status: string) => void
): Promise<ZusImportResult> {
  return awaitBotJob<ZusImportResult>(medplum, jobId, {
    maxPolls: ZUS_MAX_POLLS,
    label: 'Zus',
    timeoutMessage: 'Zus import is still running after 25 minutes; check the Task.',
    onProgress,
  });
}

/**
 * Import one DrChrono patient's chart into Medplum.
 *
 * The bot does the work server-side against the calling clinic's own DrChrono
 * credentials, and records a FHIR Task so a long import stays inspectable after
 * the browser has moved on.
 * @param medplum - Authenticated Medplum client.
 * @param drchronoPatientId - The DrChrono patient id to import.
 * @param onProgress - Called with a human-readable status while the job runs.
 * @returns The bot's result, including per-resource-type counts on success.
 */
export async function importDrChronoPatient(
  medplum: MedplumClient,
  drchronoPatientId: number | string,
  onProgress?: (status: string) => void
): Promise<ImportResult> {
  const jobId = await startDrChronoImport(medplum, drchronoPatientId);
  return awaitDrChronoImport(medplum, jobId, onProgress);
}

/** Identifier of the bot that mirrors a patient's Zus record into Medplum. */
const ZUS_BOT_IDENTIFIER = 'https://lyfe.health/bots|lyfe-zus-import';

export interface ZusImportResult {
  readonly ok: boolean;
  readonly counts?: Record<string, number>;
  readonly incomplete?: Record<string, string>;
  readonly error?: string;
}

/**
 * Pull a patient's Zus record into Medplum.
 *
 * Takes only the Medplum patient id: the bot resolves the two Zus ids itself,
 * reading them off the Patient and registering with Zus when they are not
 * there yet. That is what lets a bulk run chain straight from the DrChrono
 * import without a human pasting ids.
 *
 * Whether the patient is eligible at all is decided server-side from the
 * office their encounters are at — see the Directory page's Zus column. An
 * ineligible patient comes back `ok: false` with the reason, having cost
 * nothing.
 * @param medplum - Authenticated Medplum client.
 * @param medplumPatientId - The Medplum Patient to import onto.
 * @param onProgress - Called with a human-readable status while the job runs.
 * @returns The bot's result.
 */
export async function importZusRecord(
  medplum: MedplumClient,
  medplumPatientId: string,
  onProgress?: (status: string) => void
): Promise<ZusImportResult> {
  const jobId = await startZusImport(medplum, medplumPatientId);
  return awaitZusImport(medplum, jobId, onProgress);
}
