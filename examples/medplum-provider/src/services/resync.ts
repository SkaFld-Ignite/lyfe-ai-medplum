// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Asking for one patient's record to be pulled again.
 *
 * The browser cannot start the pull itself — it needs an Inngest event key,
 * and a key in a bundle is not a key — so this posts to the import worker,
 * which verifies the caller's own Medplum token and queues the same event a
 * chart import emits. The run belongs to the worker from that moment, so
 * closing the tab is irrelevant and nothing here polls for completion: the
 * run's own `Task` is what the page watches, through `services/imports.ts`.
 *
 * **Which sources are offered is not decided here.** It is the intersection of
 * two things the deployment already knows: what the worker will re-pull (its
 * `/health` reports it, so adding a source there lights it up without a
 * front-end release) and what this clinic has actually configured on the
 * Integrations page. A clinic with no Lyfe credentials sees no Lyfe button,
 * and a clinic that later connects a second source sees a second one, with
 * nothing in this file naming either.
 */
import type { MedplumClient } from '@medplum/core';
import { IMPORT_WORKER_URL } from './bulk-import';
import type { ImportSource } from './imports';
import { SOURCE_LABELS } from './imports';
import { getIntegrationStatus } from './integrations';

/** A source this deployment can re-pull a patient from. */
export interface ResyncSource {
  /** Wire id, as the worker names it. */
  readonly id: ImportSource;
  /** What the product calls it. Never the vendor name. */
  readonly label: string;
}

/** What the worker reports about itself. */
interface WorkerHealth {
  readonly resyncSources?: readonly { id?: string; label?: string }[];
}

/**
 * Raised when no import worker is configured, so the page can say that rather
 * than showing a button that cannot work.
 */
export class ResyncUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResyncUnavailableError';
  }
}

/**
 * The worker's base URL with no trailing slash.
 * @returns The URL.
 * @throws When no worker is configured.
 */
function workerUrl(): string {
  if (!IMPORT_WORKER_URL) {
    throw new ResyncUnavailableError('No import worker is configured');
  }
  return IMPORT_WORKER_URL.replace(/\/$/, '');
}

/**
 * Which sources the worker will re-pull from.
 *
 * Read from `/health` because the worker owns that list — the registry is
 * there, next to the events it sends. An older worker that does not report the
 * field yields an empty list, which correctly shows no control rather than a
 * button that 400s.
 * @returns The worker's sources, or an empty list when it cannot be asked.
 */
async function workerResyncSources(): Promise<ResyncSource[]> {
  const response = await fetch(`${workerUrl()}/health`);
  if (!response.ok) {
    return [];
  }
  const health = (await response.json()) as WorkerHealth;
  const sources: ResyncSource[] = [];
  for (const entry of health.resyncSources ?? []) {
    const id = entry?.id;
    // Only sources this app also knows how to label are offered. An unlabelled
    // one would render the vendor name, which is the one thing the product
    // never shows.
    if (id && id in SOURCE_LABELS) {
      sources.push({ id: id as ImportSource, label: SOURCE_LABELS[id as ImportSource] });
    }
  }
  return sources;
}

/**
 * The sources this clinic can re-pull a patient from, right now.
 *
 * The intersection of what the worker supports and what the clinic has
 * connected. Both halves matter: offering a source the worker will refuse is a
 * button that errors, and offering one the clinic has no credentials for is a
 * run that fails at the first call.
 * @param medplum - Authenticated Medplum client.
 * @returns The available sources. Empty when there is nothing to offer.
 */
export async function listResyncSources(medplum: MedplumClient): Promise<ResyncSource[]> {
  if (!IMPORT_WORKER_URL) {
    return [];
  }
  const [supported, integrations] = await Promise.all([
    workerResyncSources().catch(() => [] as ResyncSource[]),
    getIntegrationStatus(medplum).catch(() => undefined),
  ]);
  if (!integrations?.backendAvailable) {
    // The clinic's configuration could not be read. Offering every source the
    // worker supports would be guessing that they are all connected; offering
    // none is the honest answer and the page says why.
    return [];
  }
  const connected = new Set(
    integrations.integrations.filter((i) => i.status === 'connected').map((i) => i.id as string)
  );
  return supported.filter((source) => connected.has(source.id));
}

/** What the worker answers when a re-sync is queued. */
export interface ResyncQueued {
  readonly queued: true;
  readonly source: string;
  readonly patientId: string;
}

/**
 * Queue a re-pull of one patient from one source.
 *
 * The caller's own access token goes with it and is verified there; the clinic
 * is resolved by the worker from that token and can never be chosen by the
 * browser.
 * @param medplum - Authenticated Medplum client, for its access token.
 * @param props - What to re-pull.
 * @param props.patientId - The Medplum patient id.
 * @param props.source - Which source to pull from.
 * @returns The worker's acknowledgement.
 */
export async function queuePatientResync(
  medplum: MedplumClient,
  props: { patientId: string; source: ImportSource }
): Promise<ResyncQueued> {
  const response = await fetch(`${workerUrl()}/api/imports/resync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${medplum.getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ patientId: props.patientId, source: props.source }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`The import worker refused the sync (${response.status}): ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as ResyncQueued;
}
