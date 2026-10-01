// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

/**
 * Starting a bulk run on the import worker.
 *
 * The worker is a separate service, so a run is one authenticated call that
 * returns as soon as the work is queued. The run belongs to the worker from
 * that moment, which is what makes closing the tab irrelevant — the previous
 * in-page loop could only ever preserve the handful of imports already in
 * flight.
 *
 * The worker URL is configuration, not a constant, and when it is absent the
 * caller falls back to driving the imports from the page. That fallback is the
 * point: the app must keep working in an environment where the worker is not
 * deployed yet, rather than failing on a service that is not there.
 */

/** Where the import worker is, when one is deployed. */
export const IMPORT_WORKER_URL: string | undefined = import.meta.env.IMPORT_WORKER_URL || undefined;

/** What the worker reports back when a run is queued. */
export interface BulkRunQueued {
  /** Groups this run's patients, on the Task identifiers and in the worker. */
  batchId: string;
  queued: number;
}

/**
 * Queue a bulk import on the worker.
 *
 * The caller's own access token is sent and verified there: the worker takes
 * the requesting user from the token and resolves their clinic itself, so the
 * clinic can never be chosen by the browser.
 * @param medplum - Authenticated Medplum client, for its access token.
 * @param drchronoPatientIds - The patients to import.
 * @param withZus - Pull each patient's Zus record once their chart lands.
 * @returns The batch id and how many were queued.
 */
export async function queueBulkImport(
  medplum: MedplumClient,
  drchronoPatientIds: string[],
  withZus: boolean
): Promise<BulkRunQueued> {
  if (!IMPORT_WORKER_URL) {
    throw new Error('No import worker is configured');
  }
  const response = await fetch(`${IMPORT_WORKER_URL.replace(/\/$/, '')}/api/imports/bulk`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${medplum.getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ drchronoPatientIds, withZus }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`The import worker refused the run (${response.status}): ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as BulkRunQueued;
}
