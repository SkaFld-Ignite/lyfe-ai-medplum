// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Asking for one patient to be pulled again.
 *
 * The endpoint is small, and all four of the things worth pinning down about
 * it are about what it refuses:
 *
 *  - an unauthenticated caller, because this makes a service do real work
 *    against real patient data
 *  - a source nobody has registered, by name rather than with a 404
 *  - a patient in another clinic's compartment, so one clinic cannot burn runs
 *    or open Tasks against another's patient ids
 *
 * and about what it sends when it accepts: the **import's own event**, not a
 * re-sync event of its own. That last assertion is the one that matters most.
 * Everything that keeps a second pull from corrupting a chart — the guard, the
 * per-patient serialisation, the retry budget — lives on the function behind
 * `lyfe/zus.import.requested`. A re-sync that quietly grew its own event would
 * have none of it, and would look fine until the first chart came back wrong.
 */

const send = vi.fn();
vi.mock('./inngest.ts', () => ({ inngest: { send: (...args: unknown[]) => send(...args) } }));

const identify = vi.fn();
vi.mock('./trigger.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, identify: (...args: unknown[]) => identify(...args) };
});

const readResource = vi.fn();
vi.mock('./medplum.ts', () => ({
  getMedplum: async () => ({ readResource: (...args: unknown[]) => readResource(...args) }),
  requiredEnv: () => 'https://medplum.example.com/',
}));

const { handleResync, MANUAL_RESYNC_REASON } = await import('./resync.ts');

const CALLER = { profile: 'Practitioner/dr-who', organizationId: 'org-1' };

/**
 * A request carrying a JSON body.
 * @param props - The request parts.
 * @param props.body - The JSON body.
 * @param props.token - Bearer token, or undefined for no Authorization header.
 * @returns Something `handleResync` will accept as a request.
 */
function request(props: { body: unknown; token?: string }): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(props.body))]) as unknown as IncomingMessage;
  stream.headers = props.token ? { authorization: `Bearer ${props.token}` } : {};
  return stream;
}

/**
 * A response that records what was written to it.
 * @returns The response plus readers for the status and parsed body.
 */
function response(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (payload: string) => {
      body = JSON.parse(payload) as Record<string, unknown>;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

describe('POST /api/imports/resync', () => {
  beforeEach(() => {
    send.mockReset();
    identify.mockReset().mockResolvedValue(CALLER);
    readResource.mockReset().mockResolvedValue({
      resourceType: 'Patient',
      id: 'p1',
      meta: { accounts: [{ reference: 'Organization/org-1' }] },
    });
  });

  test('queues the import’s own event, marked as a manual run', async () => {
    const out = response();
    await handleResync(request({ body: { source: 'zus', patientId: 'p1' }, token: 't' }), out.res);

    expect(out.status()).toBe(202);
    expect(send).toHaveBeenCalledWith({
      name: 'lyfe/zus.import.requested',
      data: {
        organizationId: 'org-1',
        // Taken from the verified token, never from the body — the importer
        // resolves the clinic from it.
        requester: 'Practitioner/dr-who',
        medplumPatientId: 'p1',
        reason: MANUAL_RESYNC_REASON,
      },
    });
  });

  test('refuses a caller with no token', async () => {
    const out = response();
    await handleResync(request({ body: { source: 'zus', patientId: 'p1' } }), out.res);
    expect(out.status()).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a token Medplum does not recognise', async () => {
    identify.mockResolvedValue(undefined);
    const out = response();
    await handleResync(request({ body: { source: 'zus', patientId: 'p1' }, token: 'stale' }), out.res);
    expect(out.status()).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  test('names the sources it has when asked for one it does not', async () => {
    const out = response();
    await handleResync(request({ body: { source: 'epic', patientId: 'p1' }, token: 't' }), out.res);
    expect(out.status()).toBe(400);
    expect(out.body().supported).toEqual(['zus']);
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a patient in another clinic’s compartment', async () => {
    readResource.mockResolvedValue({
      resourceType: 'Patient',
      id: 'p1',
      meta: { accounts: [{ reference: 'Organization/other-clinic' }] },
    });
    const out = response();
    await handleResync(request({ body: { source: 'zus', patientId: 'p1' }, token: 't' }), out.res);
    // 404 rather than 403: whether another clinic has a patient under this id
    // is not something an unrelated caller gets to learn.
    expect(out.status()).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a patient that does not exist', async () => {
    readResource.mockRejectedValue(new Error('not found'));
    const out = response();
    await handleResync(request({ body: { source: 'zus', patientId: 'ghost' }, token: 't' }), out.res);
    expect(out.status()).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a request with no patient', async () => {
    const out = response();
    await handleResync(request({ body: { source: 'zus' }, token: 't' }), out.res);
    expect(out.status()).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
