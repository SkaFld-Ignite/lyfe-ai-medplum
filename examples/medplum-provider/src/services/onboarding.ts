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
  }>(medplum, { action: 'preview', start, ...(end ? { end } : {}) });
  return {
    scannedAppointments: body.scannedAppointments ?? 0,
    candidates: body.results ?? [],
    skippedByDirectory: body.skippedByDirectory ?? 0,
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
  const bot = await medplum.searchOne('Bot', { identifier: IMPORT_BOT_IDENTIFIER });
  if (!bot?.id) {
    throw new OnboardingBackendUnavailableError(
      `No Bot found with identifier ${IMPORT_BOT_IDENTIFIER}. Run "npm run deploy:bots".`
    );
  }

  // Deliberately async, not a plain executeBot.
  //
  // Railway caps any single request at 300s. A synchronous $execute of a real
  // chart import is killed at that ceiling with a 502 — and MedplumClient
  // RETRIES it, which starts a SECOND concurrent import of the same patient
  // while the first is still running server-side. The async pattern returns
  // immediately with a job to poll, and has no such ceiling.
  const accepted = await medplum.startAsyncRequest<OperationOutcome>(`fhir/R4/Bot/${bot.id}/$execute`, {
    body: JSON.stringify({ action: 'import', drchronoPatientId: String(drchronoPatientId) }),
    headers: { 'Content-Type': 'application/json' },
  });

  const statusUrl = accepted.issue?.[0]?.diagnostics ?? '';
  const jobId = /\/job\/([0-9a-f-]+)\/status/.exec(statusUrl)?.[1];
  if (!jobId) {
    throw new Error(`Import did not start: ${statusUrl || 'no job id in response'}`);
  }

  const POLL_MS = 5000;
  const MAX_POLLS = 240; // 20 minutes; a Zus-sized chart took 19
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
    const job = await medplum.readResource('AsyncJob', jobId);
    if (job.status === 'completed') {
      const raw = job.output?.parameter?.find((p) => p.name === 'responseBody')?.valueString;
      return raw ? (JSON.parse(raw) as ImportResult) : { ok: true };
    }
    if (job.status === 'error') {
      return { ok: false, error: 'Import failed — see the Task for details.' };
    }
    onProgress?.(`importing… ${Math.round(((i + 1) * POLL_MS) / 1000)}s`);
  }
  return { ok: false, error: 'Import is still running after 20 minutes; check the Task.' };
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
  const bot = await medplum.searchOne('Bot', { identifier: ZUS_BOT_IDENTIFIER });
  if (!bot?.id) {
    throw new OnboardingBackendUnavailableError(
      `No Bot found with identifier ${ZUS_BOT_IDENTIFIER}. Run "npm run deploy:bots".`
    );
  }

  // Async for the same reason the DrChrono import is: a Zus-sized pull runs
  // well past Railway's 300s request ceiling.
  const accepted = await medplum.startAsyncRequest<OperationOutcome>(`fhir/R4/Bot/${bot.id}/$execute`, {
    body: JSON.stringify({ action: 'import', medplumPatientId }),
    headers: { 'Content-Type': 'application/json' },
  });

  const statusUrl = accepted.issue?.[0]?.diagnostics ?? '';
  const jobId = /\/job\/([0-9a-f-]+)\/status/.exec(statusUrl)?.[1];
  if (!jobId) {
    throw new Error(`Zus import did not start: ${statusUrl || 'no job id in response'}`);
  }

  const POLL_MS = 5000;
  const MAX_POLLS = 300; // 25 minutes; a full Zus record took 19
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
    const job = await medplum.readResource('AsyncJob', jobId);
    if (job.status === 'completed') {
      const raw = job.output?.parameter?.find((p) => p.name === 'responseBody')?.valueString;
      return raw ? (JSON.parse(raw) as ZusImportResult) : { ok: true };
    }
    if (job.status === 'error') {
      return { ok: false, error: 'Zus import failed — see the Task for details.' };
    }
    onProgress?.(`Zus… ${Math.round(((i + 1) * POLL_MS) / 1000)}s`);
  }
  return { ok: false, error: 'Zus import is still running after 25 minutes; check the Task.' };
}
