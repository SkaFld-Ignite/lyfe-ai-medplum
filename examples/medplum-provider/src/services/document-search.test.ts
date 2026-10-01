// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The browser's half of document search.
 *
 * The assertion that matters is the negative one: this request carries the caller's token and the
 * patient, and **no organization**. The worker derives the clinic from the token and puts it in the
 * retrieval `WHERE` clause, so a body that could name one would make `/api/rag/search` a PHI
 * disclosure endpoint with a login in front of it. A field added here would not fail anything — it
 * would just be sent — which is why it is pinned.
 */

vi.mock('./bulk-import', () => ({ IMPORT_WORKER_URL: 'https://worker.example.com/' }));

const { searchPatientDocuments } = await import('./document-search');

const medplum = { getAccessToken: () => 'caller-token' } as unknown as MedplumClient;

/**
 * The single `fetch` call this module made.
 * @returns The URL and the request init.
 */
function lastFetch(): { url: string; init: RequestInit } {
  const call = vi.mocked(globalThis.fetch).mock.calls[0];
  return { url: call[0] as string, init: call[1] ?? {} };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ hits: [], asText: 'nothing' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchPatientDocuments', () => {
  test('sends only the patient, the query and the caller’s own token', async () => {
    await searchPatientDocuments(medplum, { patientId: 'p1', query: 'aortic stenosis' });

    const { url, init } = lastFetch();
    expect(url).toBe('https://worker.example.com/api/rag/search');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer caller-token');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toStrictEqual({ patientId: 'p1', query: 'aortic stenosis' });
    // The clinic is resolved server-side from the token. Nothing here may name one.
    expect(Object.keys(body)).not.toContain('organizationId');
    expect(Object.keys(body)).not.toContain('organization');
  });

  test('forwards topK when one was asked for', async () => {
    await searchPatientDocuments(medplum, { patientId: 'p1', query: 'q', topK: 12 });
    expect(JSON.parse(lastFetch().init.body as string)).toStrictEqual({ patientId: 'p1', query: 'q', topK: 12 });
  });

  test('turns a refusal into an error naming the status', async () => {
    // A 503 here is "RAG_DATABASE_URL is unset on the worker" and a 401 is "the token expired".
    // Both have to reach the caller as something it can report, not as an empty result set.
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('RAG_DATABASE_URL is unset', { status: 503 }));
    await expect(searchPatientDocuments(medplum, { patientId: 'p1', query: 'q' })).rejects.toThrow(
      /503.*RAG_DATABASE_URL/s
    );
  });

  test('returns the hits and the worker’s note', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          hits: [{ documentId: 'd1', chunkIndex: 0, snippet: 's', distance: 0.1, title: 't', documentDate: null }],
          asText: 'digest',
        }),
        { status: 200 }
      )
    );
    const result = await searchPatientDocuments(medplum, { patientId: 'p1', query: 'q' });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].documentId).toBe('d1');
  });
});

describe('with no worker configured', () => {
  test('refuses before making a request', async () => {
    vi.doMock('./bulk-import', () => ({ IMPORT_WORKER_URL: undefined }));
    vi.resetModules();
    const unconfigured = await import('./document-search');
    await expect(unconfigured.searchPatientDocuments(medplum, { patientId: 'p1', query: 'q' })).rejects.toThrow(
      /No document index is configured/
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.doUnmock('./bulk-import');
    vi.resetModules();
  });
});
