// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The RAG endpoints' trust boundary.
 *
 * `/api/rag/search` returns the text of clinical documents, which makes this
 * the most sensitive handler in the worker. Everything asserted here is one
 * rule stated three ways: **the organization comes from the caller's verified
 * identity and never from the request.** A body-supplied organization would
 * turn this into a PHI disclosure endpoint with an authentication check in
 * front of it, and the bug would be invisible in a single-tenant dev
 * environment.
 */

const send = vi.fn();
const searchPatientDocuments = vi.fn();
const getIndexStatus = vi.fn();

vi.mock('./inngest.ts', () => ({
  inngest: { send: (...args: unknown[]) => send(...args) },
  PER_CLINIC_CONCURRENCY: 5,
}));

vi.mock('./rag/db.ts', () => ({ isRagConfigured: () => true }));

vi.mock('./rag/retrieve.ts', () => ({
  searchPatientDocuments: (...args: unknown[]) => searchPatientDocuments(...args),
  getIndexStatus: (...args: unknown[]) => getIndexStatus(...args),
  TOP_K_DOCS: 6,
}));

// The same Medplum stubs `trigger.test.ts` uses, so both endpoints are proved
// against the same identity resolution rather than two different fakes.
/** The caller's memberships, so a test can take their organization away. */
const memberships = vi.fn(async (): Promise<unknown[]> => [
  {
    resourceType: 'ProjectMembership',
    access: [{ parameter: [{ name: 'organization', valueReference: { reference: 'Organization/clinic-1' } }] }],
  },
]);

vi.mock('./medplum.ts', () => ({
  requiredEnv: () => 'https://medplum.example.com/',
  getMedplum: async () => ({ searchResources: async () => memberships() }),
}));

const validToken = vi.fn(async () => ({ profile: { resourceType: 'Practitioner', id: 'prac-1' } }));

vi.mock('@medplum/core', () => ({
  MedplumClient: class {
    setAccessToken(): void {}
    async get(): Promise<unknown> {
      return validToken();
    }
  },
}));

const { handleRagIngest, handleRagSearch, handleRagStatus } = await import('./rag-http.ts');

/**
 * A request with a JSON body and, by default, a bearer token.
 *
 * `null` means "send no Authorization header". Not `undefined` — passing
 * `undefined` explicitly triggers a default parameter, so a test meaning to
 * send no token would quietly send one and assert 401 against a request that
 * was properly authenticated. That mistake was made writing these tests and is
 * worth not repeating.
 * @param body - What the caller posted.
 * @param authorization - The Authorization header, or null for none.
 * @returns Enough of an IncomingMessage for the handlers.
 */
function request(body: unknown, authorization: string | null = 'Bearer token'): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    headers: authorization ? { authorization } : {},
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

/**
 * A response that records what was written to it.
 * @returns The stub.
 */
function response(): ServerResponse & { status?: number; body?: string } {
  const res = {
    writeHead(status: number) {
      res.status = status;
    },
    end(body: string) {
      res.body = body;
    },
  } as unknown as ServerResponse & { status?: number; body?: string };
  return res;
}

/**
 * Parse a recorded response body.
 * @param res - The response stub.
 * @param res.body - The JSON the handler wrote.
 * @returns The parsed JSON.
 */
function parsed(res: { body?: string }): Record<string, unknown> {
  return JSON.parse(res.body ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  validToken.mockResolvedValue({ profile: { resourceType: 'Practitioner', id: 'prac-1' } });
  memberships.mockResolvedValue([
    {
      resourceType: 'ProjectMembership',
      access: [{ parameter: [{ name: 'organization', valueReference: { reference: 'Organization/clinic-1' } }] }],
    },
  ]);
  searchPatientDocuments.mockResolvedValue({ hits: [], asText: 'nothing' });
  getIndexStatus.mockResolvedValue({ documents: {}, chunks: 0 });
});

describe('authentication', () => {
  for (const [name, handler] of [
    ['ingest', handleRagIngest],
    ['search', handleRagSearch],
    ['status', handleRagStatus],
  ] as const) {
    test(`${name} refuses a request with no bearer token`, async () => {
      const res = response();
      await handler(request({ patientId: 'p', patientIds: ['p'], query: 'q' }, null), res);
      expect(res.status).toBe(401);
      expect(searchPatientDocuments).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    test(`${name} refuses a token Medplum does not recognise`, async () => {
      // Verified by asking Medplum, not by decoding anything locally.
      validToken.mockResolvedValue({} as never);
      const res = response();
      await handler(request({ patientId: 'p', patientIds: ['p'], query: 'q' }), res);
      expect(res.status).toBe(401);
      expect(searchPatientDocuments).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  }

  test('does not tell an unauthenticated caller which check they failed', async () => {
    const noToken = response();
    await handleRagSearch(request({ patientId: 'p', query: 'q' }, null), noToken);
    validToken.mockResolvedValue({} as never);
    const badToken = response();
    await handleRagSearch(request({ patientId: 'p', query: 'q' }), badToken);
    // Different messages here would let a caller probe which half they got
    // right.
    expect(parsed(noToken).error).toBeDefined();
    expect(parsed(badToken).error).toBe('Token is not valid');
  });
});

describe('handleRagSearch', () => {
  test('takes the organization from the token, never from the body', async () => {
    const res = response();
    await handleRagSearch(
      // A caller trying to read another clinic. The body's organizationId is
      // not a parameter this handler has, and must stay that way.
      request({ patientId: 'pat-1', query: 'chest pain', organizationId: 'clinic-2' }),
      res
    );

    expect(res.status).toBe(200);
    const [context] = searchPatientDocuments.mock.calls[0] as [{ organizationId: string; patientId: string }];
    expect(context.organizationId).toBe('clinic-1');
    expect(context.patientId).toBe('pat-1');
  });

  test('builds the retrieval context from nothing but the identity and the patient', async () => {
    // Asserted on the keys, not only the values. The way this endpoint turns into a breach is a
    // later edit spreading the body into the context — `{ ...body, organizationId }` — which keeps
    // every other test here passing while handing the caller a say in the tenant filter. There are
    // exactly two keys and both are derived server-side.
    const res = response();
    await handleRagSearch(
      request({
        patientId: 'pat-1',
        query: 'q',
        organizationId: 'clinic-2',
        organization: 'Organization/clinic-2',
      }),
      res
    );
    const [context] = searchPatientDocuments.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(context).sort()).toStrictEqual(['organizationId', 'patientId']);
    expect(context.organizationId).toBe('clinic-1');
  });

  test('a caller whose membership names no organization reads nothing at all', async () => {
    // The one case where "no organization" must not become "no filter". A valid token with no
    // clinic on it is refused before any query runs, rather than reaching the WHERE clause as an
    // empty string — which would match no rows today and is one schema change away from matching
    // every row.
    memberships.mockResolvedValue([{ resourceType: 'ProjectMembership', access: [] }]);
    const res = response();
    await handleRagSearch(request({ patientId: 'pat-1', query: 'q' }), res);
    expect(res.status).toBe(401);
    expect(searchPatientDocuments).not.toHaveBeenCalled();
  });

  test('passes the patient through, because the org filter already bounds it', async () => {
    // Trusting `patientId` is safe for exactly one reason: the SQL filters on
    // organization AND patient, so another clinic's patient matches no rows.
    const res = response();
    await handleRagSearch(request({ patientId: 'patient-of-clinic-2', query: 'q' }), res);
    const [context] = searchPatientDocuments.mock.calls[0] as [{ organizationId: string; patientId: string }];
    expect(context.organizationId).toBe('clinic-1');
    expect(context.patientId).toBe('patient-of-clinic-2');
  });

  test('requires a patient and a query', async () => {
    const noPatient = response();
    await handleRagSearch(request({ query: 'q' }), noPatient);
    expect(noPatient.status).toBe(400);

    const noQuery = response();
    await handleRagSearch(request({ patientId: 'p' }), noQuery);
    expect(noQuery.status).toBe(400);
    expect(searchPatientDocuments).not.toHaveBeenCalled();
  });

  test('ignores a non-string patientId rather than coercing it', async () => {
    const res = response();
    await handleRagSearch(request({ patientId: { toString: 'nope' }, query: 'q' }), res);
    expect(res.status).toBe(400);
  });

  test('truncates an enormous query instead of forwarding it to Bedrock', async () => {
    const res = response();
    await handleRagSearch(request({ patientId: 'p', query: 'x'.repeat(50_000) }), res);
    const [, query] = searchPatientDocuments.mock.calls[0] as [unknown, string];
    expect(query).toHaveLength(2000);
  });

  test('returns the hits and the digest the model reads', async () => {
    searchPatientDocuments.mockResolvedValue({
      hits: [{ documentId: 'd1', chunkIndex: 0, snippet: 's', distance: 0.1, title: 't', documentDate: null }],
      asText: '[doc:S1 | t | chunk 0]\ns',
    });
    const res = response();
    await handleRagSearch(request({ patientId: 'p', query: 'q' }), res);
    expect(res.status).toBe(200);
    expect(parsed(res).asText).toContain('[doc:S1');
  });
});

describe('handleRagIngest', () => {
  test('queues one event per patient, stamped with the caller’s organization', async () => {
    const res = response();
    await handleRagIngest(request({ patientIds: ['p1', 'p2'], organizationId: 'clinic-2' }), res);

    expect(res.status).toBe(202);
    const events = send.mock.calls[0][0] as { name: string; data: Record<string, unknown> }[];
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.name).toBe('lyfe/rag.ingest.requested');
      // Not clinic-2, whatever the body said.
      expect(event.data.organizationId).toBe('clinic-1');
      expect(event.data.requester).toBe('Practitioner/prac-1');
      expect(event.data.batchId).toBeDefined();
    }
  });

  test('rejects an empty or missing patient list', async () => {
    const empty = response();
    await handleRagIngest(request({ patientIds: [] }), empty);
    expect(empty.status).toBe(400);

    const missing = response();
    await handleRagIngest(request({}), missing);
    expect(missing.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  test('caps the batch so a typo cannot queue the whole corpus', async () => {
    const res = response();
    await handleRagIngest(request({ patientIds: new Array(501).fill('p') }), res);
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  test('returns as soon as the events are accepted', async () => {
    // Indexing takes minutes; the browser must not hold a connection for it.
    const res = response();
    await handleRagIngest(request({ patientIds: ['p1'] }), res);
    expect(res.status).toBe(202);
    expect(parsed(res).queued).toBe(1);
  });
});

describe('handleRagStatus', () => {
  test('scopes the count to the caller’s organization', async () => {
    const res = response();
    await handleRagStatus(request({ patientId: 'pat-1', organizationId: 'clinic-2' }), res);
    expect(res.status).toBe(200);
    expect(getIndexStatus.mock.calls[0][0]).toEqual({ organizationId: 'clinic-1', patientId: 'pat-1' });
  });

  test('requires a patient', async () => {
    const res = response();
    await handleRagStatus(request({}), res);
    expect(res.status).toBe(400);
  });
});
