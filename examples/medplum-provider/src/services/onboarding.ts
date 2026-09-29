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
}

/**
 * Every distinct patient with an appointment in a date range.
 *
 * This is the "import everyone on Tuesday's schedule" flow. Cancelled,
 * rescheduled and no-show appointments are excluded server-side, since those
 * never produced a visit worth pulling a chart for.
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
  }>(medplum, { action: 'preview', start, ...(end ? { end } : {}) });
  return {
    scannedAppointments: body.scannedAppointments ?? 0,
    candidates: body.results ?? [],
  };
}

/** Identifier system DrChrono patients are stamped with when imported. */
export const DRCHRONO_IDENTIFIER_SYSTEM = 'https://drchrono.com/patients';
