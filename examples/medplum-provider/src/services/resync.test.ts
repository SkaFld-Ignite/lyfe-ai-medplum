// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Which sources the patient page offers, and what pressing one does.
 *
 * The rule under test is that neither half of the answer is written down in
 * the app: a source appears only when the **worker** will pull it and the
 * **clinic** has connected it. That is what keeps this from becoming the thing
 * it replaces — a hardcoded button per vendor, which is how the previous
 * platform ended up with DrChrono and Zus spelled out across fifty files.
 */

vi.mock('./bulk-import', () => ({ IMPORT_WORKER_URL: 'https://worker.example.com' }));

const getIntegrationStatus = vi.fn();
vi.mock('./integrations', () => ({
  getIntegrationStatus: (...args: unknown[]) => getIntegrationStatus(...args),
}));

const { listResyncSources, queuePatientResync } = await import('./resync');

const medplum = { getAccessToken: () => 'token-123' } as unknown as MedplumClient;

/**
 * Stub `fetch` with one response per URL fragment.
 * @param routes - URL fragment to the response it should answer with.
 */
function stubFetch(routes: Record<string, { ok: boolean; status?: number; body?: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
      if (!match) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      const [, route] = match;
      return {
        ok: route.ok,
        status: route.status ?? (route.ok ? 200 : 500),
        json: async () => route.body,
        text: async () => JSON.stringify(route.body ?? ''),
      };
    })
  );
}

/**
 * An integrations snapshot with the given sources connected.
 * @param connected - Integration ids reporting `connected`.
 * @returns The snapshot.
 */
function integrations(connected: string[]): {
  backendAvailable: boolean;
  integrations: { id: string; status: string }[];
} {
  return {
    backendAvailable: true,
    integrations: [
      { id: 'drchrono', status: connected.includes('drchrono') ? 'connected' : 'not-connected' },
      { id: 'zus', status: connected.includes('zus') ? 'connected' : 'not-connected' },
    ],
  };
}

describe('listResyncSources', () => {
  beforeEach(() => {
    getIntegrationStatus.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('offers a source the worker supports and the clinic has connected', async () => {
    stubFetch({ '/health': { ok: true, body: { resyncSources: [{ id: 'zus' }] } } });
    getIntegrationStatus.mockResolvedValue(integrations(['zus']));

    const sources = await listResyncSources(medplum);

    // Labelled from the product's own table, so the vendor name never reaches
    // the screen.
    expect(sources).toEqual([{ id: 'zus', label: 'Lyfe' }]);
  });

  test('offers nothing for a source the clinic has not connected', async () => {
    stubFetch({ '/health': { ok: true, body: { resyncSources: [{ id: 'zus' }] } } });
    getIntegrationStatus.mockResolvedValue(integrations([]));
    expect(await listResyncSources(medplum)).toEqual([]);
  });

  test('offers nothing for a source the worker will not pull', async () => {
    // An older worker, or one where the source has been taken out. Showing the
    // button anyway is a 400 the clinician cannot act on.
    stubFetch({ '/health': { ok: true, body: { resyncSources: [] } } });
    getIntegrationStatus.mockResolvedValue(integrations(['zus']));
    expect(await listResyncSources(medplum)).toEqual([]);
  });

  test('offers nothing when the clinic’s configuration cannot be read', async () => {
    stubFetch({ '/health': { ok: true, body: { resyncSources: [{ id: 'zus' }] } } });
    getIntegrationStatus.mockResolvedValue({ backendAvailable: false, integrations: [] });
    // Guessing that everything is connected would put a button on the page
    // whose run fails on the first call out.
    expect(await listResyncSources(medplum)).toEqual([]);
  });

  test('offers nothing when the worker cannot be reached', async () => {
    stubFetch({ '/health': { ok: false, status: 503 } });
    getIntegrationStatus.mockResolvedValue(integrations(['zus']));
    expect(await listResyncSources(medplum)).toEqual([]);
  });
});

describe('queuePatientResync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends the caller’s own token and the patient', async () => {
    stubFetch({ '/api/imports/resync': { ok: true, body: { queued: true, source: 'zus', patientId: 'p1' } } });

    const result = await queuePatientResync(medplum, { patientId: 'p1', source: 'zus' });

    expect(result.queued).toBe(true);
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token-123' });
    // The clinic is not in the body, and must never be: the worker resolves it
    // from the token, so a body field would be an IDOR.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ patientId: 'p1', source: 'zus' });
  });

  test('surfaces the worker’s refusal rather than swallowing it', async () => {
    stubFetch({ '/api/imports/resync': { ok: false, status: 404, body: { error: 'No such patient' } } });
    await expect(queuePatientResync(medplum, { patientId: 'p1', source: 'zus' })).rejects.toThrow('404');
  });
});
