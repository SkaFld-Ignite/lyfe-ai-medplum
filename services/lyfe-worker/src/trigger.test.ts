// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The bulk endpoint must not take instructions about the network pull.
 *
 * It used to: the body carried a `withZus` flag, set from a checkbox in the
 * page, and `chart-import` gated the record pull on it. That put a decision
 * about how complete a patient's chart is in the hands of whoever happened to
 * be clicking, and — worse — the flag was the browser's to send, so the same
 * import behaved differently depending on where it was started from.
 *
 * The pull now always follows a chart. Which patients actually qualify is read
 * server-side from the clinic's Directory configuration, inside the importer.
 * These pin down that the request body can no longer influence any of it.
 */

const send = vi.fn();

vi.mock('./inngest.ts', () => ({
  inngest: { send: (...args: unknown[]) => send(...args) },
  PER_CLINIC_CONCURRENCY: 5,
}));

vi.mock('./medplum.ts', () => ({
  requiredEnv: () => 'https://medplum.example.com/',
  getMedplum: async () => ({
    searchResources: async () => [
      {
        resourceType: 'ProjectMembership',
        access: [{ parameter: [{ name: 'organization', valueReference: { reference: 'Organization/clinic-1' } }] }],
      },
    ],
  }),
}));

vi.mock('@medplum/core', () => ({
  MedplumClient: class {
    setAccessToken(): void {}
    async get(): Promise<unknown> {
      return { profile: { resourceType: 'Practitioner', id: 'prac-1' } };
    }
  },
}));

const { handleBulkImport } = await import('./trigger.ts');

/**
 * A request carrying a JSON body and a bearer token.
 * @param body - What the caller posted.
 * @returns Enough of an IncomingMessage for the handler.
 */
function request(body: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    headers: { authorization: 'Bearer token' },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

/**
 * A response that records what was written to it.
 * @returns The stub, plus the recorded status and body.
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
 * The events the handler asked Inngest to send.
 * @returns One entry per queued patient.
 */
function queuedEvents(): { name: string; data: Record<string, unknown> }[] {
  return send.mock.calls[0][0] as { name: string; data: Record<string, unknown> }[];
}

describe('handleBulkImport', () => {
  beforeEach(() => {
    send.mockClear();
  });

  test('queues a chart import that carries no record-pull flag', async () => {
    const res = response();
    await handleBulkImport(request({ drchronoPatientIds: ['111', '222'] }), res);

    expect(res.status).toBe(202);
    const events = queuedEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.name).toBe('lyfe/chart.import.requested');
      // The absence is the assertion: there is no longer anything in the event
      // that a chart import could consult to decide whether to pull a record.
      expect(event.data).not.toHaveProperty('withZus');
      expect(event.data.organizationId).toBe('clinic-1');
      expect(event.data.requester).toBe('Practitioner/prac-1');
    }
  });

  test('ignores a withZus flag an older build still sends', async () => {
    // A deployed page from before this change keeps posting the flag. It must
    // not be able to switch the record pull off, and it must not fail the run
    // either — so it is simply not read.
    const res = response();
    await handleBulkImport(request({ drchronoPatientIds: ['333'], withZus: false }), res);

    expect(res.status).toBe(202);
    expect(queuedEvents()[0].data).not.toHaveProperty('withZus');
  });
});
