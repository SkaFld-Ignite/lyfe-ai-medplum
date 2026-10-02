// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * What these pin down.
 *
 * Only the four things that can quietly destroy clinical data, plus the one
 * that quietly loses it:
 *
 * 1. Verification fails closed. lyfe-provider-ui computed the wrong digest and
 *    had an unsigned fallback, so every real DrChrono event was answered
 *    `200 {verified: true}` and dropped. A wrong secret, a missing header and a
 *    body-HMAC — the thing the legacy code actually sent — must all be 401 with
 *    nothing queued.
 * 2. A redelivery is a no-op. DrChrono resends at +1h, +3h and +7h, and an
 *    operator can resend by hand forever.
 * 3. Tenants are isolated. Clinic B's secret must not open clinic A's URL, and
 *    a requester that belongs to another clinic must not be usable.
 * 4. An unknown event is handled explicitly. Not mapped onto something else,
 *    not silently swallowed.
 * 5. A claimed delivery whose work fails to queue is released, or the
 *    provider's retry — which exists for exactly that — gets discarded as a
 *    duplicate of nothing.
 *
 * Mocked at the boundary only: Inngest, and a Medplum client standing in for the
 * server. The credential records are built with the real `encryptSecret`, so the
 * real decryption path runs rather than a stubbed one.
 */
import type { Basic, Resource } from '@medplum/fhirtypes';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CONFIG_PREFIX,
  deriveEncryptionKey,
  ENCRYPTION_KEY_SECRET_NAME,
  encryptSecret,
  INTEGRATION_SYSTEM,
  SECRET_PREFIX,
} from '../../../../examples/medplum-provider/bots/shared/credentials.ts';

const send = vi.fn();
vi.mock('../inngest.ts', () => ({
  inngest: { send: (...args: unknown[]) => send(...args) },
  PER_CLINIC_CONCURRENCY: 5,
}));

const { handleWebhook, parseWebhookUrl } = await import('./receive.ts');
const { DELIVERY_SYSTEM } = await import('./delivery-claim.ts');

/** A real 32-byte key, so encryption and decryption are the real thing. */
const KEY_MATERIAL = 'a'.repeat(64);
const KEY = deriveEncryptionKey({ material: KEY_MATERIAL });

const SECRET_A = 'clinic-a-secret-token-high-entropy';
const SECRET_B = 'clinic-b-secret-token-high-entropy';

/**
 * Build a credential record the way the Integrations bot would have saved it.
 * @param props - What the clinic configured.
 * @param props.organizationId - The clinic.
 * @param props.secret - Its webhook secret.
 * @param props.requester - The configured requester profile.
 * @param props.events - Optional event allow-list.
 * @returns The record.
 */
function credentialRecord(props: {
  organizationId: string;
  secret: string;
  requester: string;
  events?: string;
}): Basic {
  const extension = [
    { url: `${SECRET_PREFIX}webhookSecret`, valueString: encryptSecret({ plaintext: props.secret, key: KEY }) },
    { url: `${CONFIG_PREFIX}webhookRequester`, valueString: props.requester },
  ];
  if (props.events !== undefined) {
    extension.push({ url: `${CONFIG_PREFIX}webhookEvents`, valueString: props.events });
  }
  return {
    resourceType: 'Basic',
    id: `cred-${props.organizationId}`,
    identifier: [{ system: INTEGRATION_SYSTEM, value: 'drchrono' }],
    subject: { reference: `Organization/${props.organizationId}` },
    code: { text: 'drchrono credentials' },
    extension,
  };
}

/** The fake Medplum server the receiver talks to. */
interface FakeMedplum {
  readonly claims: Map<string, Basic>;
  readonly deleted: string[];
  searchResources(type: string, query: string): Promise<Resource[]>;
  createResourceIfNoneExist<T extends Resource>(resource: T, query: string): Promise<T & { id: string }>;
  deleteResource(type: string, id: string): Promise<void>;
}

/**
 * Build the fake Medplum server.
 *
 * `createResourceIfNoneExist` is modelled as the server actually behaves — an
 * atomic "return the existing match, else create" — because that is the whole
 * basis of the dedup claim. A fake that always created would hide the bug this
 * is here to prevent.
 * @param props - The world this server knows about.
 * @param props.records - Credential records, keyed by organization id.
 * @param props.memberships - Organization each profile is scoped to.
 * @returns The fake.
 */
function fakeMedplum(props: { records: Record<string, Basic>; memberships: Record<string, string[]> }): FakeMedplum {
  const claims = new Map<string, Basic>();
  const deleted: string[] = [];
  let counter = 0;

  return {
    claims,
    deleted,
    async searchResources(type: string, query: string): Promise<Resource[]> {
      if (type === 'ProjectMembership') {
        const profile = decodeURIComponent(new URLSearchParams(query).get('profile') ?? '');
        return (props.memberships[profile] ?? []).map((organization) => ({
          resourceType: 'ProjectMembership',
          id: 'm',
          project: { reference: 'Project/p' },
          user: { reference: 'User/u' },
          profile: { reference: profile },
          access: [
            {
              policy: { reference: 'AccessPolicy/a' },
              parameter: [{ name: 'organization', valueReference: { reference: organization } }],
            },
          ],
        })) as unknown as Resource[];
      }
      if (type === 'Basic') {
        const subject = new URLSearchParams(query).get('subject') ?? '';
        const organizationId = subject.split('/')[1];
        const record = props.records[organizationId];
        return record ? [record] : [];
      }
      return [];
    },
    async createResourceIfNoneExist<T extends Resource>(resource: T, query: string): Promise<T & { id: string }> {
      const value = new URLSearchParams(query).get('identifier') ?? '';
      const existing = claims.get(value);
      if (existing) {
        return existing as T & { id: string };
      }
      const created = { ...resource, id: `claim-${++counter}` } as T & { id: string };
      claims.set(value, created as unknown as Basic);
      return created;
    },
    async deleteResource(_type: string, id: string): Promise<void> {
      deleted.push(id);
    },
  };
}

/** A captured response. */
interface Captured {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Drive one request through the receiver.
 * @param props - The request.
 * @param props.method - HTTP method.
 * @param props.url - The callback URL, including any query string.
 * @param props.headers - Request headers, lower-cased.
 * @param props.body - The raw body.
 * @param props.medplum - The fake server.
 * @returns The status and parsed body.
 */
async function call(props: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  medplum: FakeMedplum;
}): Promise<Captured> {
  const route = parseWebhookUrl(props.url);
  if (!route) {
    throw new Error(`not a webhook url: ${props.url}`);
  }
  const req = Readable.from([Buffer.from(props.body ?? '')]) as unknown as IncomingMessage;
  (req as { method?: string }).method = props.method;
  (req as { headers?: Record<string, string> }).headers = props.headers ?? {};

  const captured: Captured = { status: 0, body: {} };
  const res = {
    headersSent: false,
    writeHead(status: number): void {
      captured.status = status;
    },
    end(payload: string): void {
      captured.body = JSON.parse(payload) as Record<string, unknown>;
    },
  } as unknown as ServerResponse;

  await handleWebhook({ req, res, route, medplum: props.medplum as never });
  return captured;
}

/**
 * Headers for a well-formed DrChrono delivery.
 * @param props - What the delivery carries.
 * @param props.secret - The token DrChrono sends verbatim as the signature.
 * @param props.event - The event name.
 * @param props.delivery - The delivery id, omitted to simulate one without.
 * @returns The headers.
 */
function headers(props: { secret: string; event: string; delivery?: string }): Record<string, string> {
  const out: Record<string, string> = {
    'x-drchrono-signature': props.secret,
    'x-drchrono-event': props.event,
    'content-type': 'application/json',
  };
  if (props.delivery !== undefined) {
    out['x-drchrono-delivery'] = props.delivery;
  }
  return out;
}

/** A PATIENT_MODIFY body in DrChrono's real `{receiver, object}` shape. */
const PATIENT_BODY = JSON.stringify({
  receiver: { id: 77, callback_url: 'https://worker.example.com/api/webhooks/drchrono/clinic-a' },
  object: { id: 12345, first_name: 'Ada', last_name: 'Lovelace' },
});

/**
 * Build the standard two-clinic world.
 * @returns A fake server where clinic-a and clinic-b are both configured.
 */
function twoClinics(): FakeMedplum {
  return fakeMedplum({
    records: {
      'clinic-a': credentialRecord({ organizationId: 'clinic-a', secret: SECRET_A, requester: 'Practitioner/prac-a' }),
      'clinic-b': credentialRecord({ organizationId: 'clinic-b', secret: SECRET_B, requester: 'Practitioner/prac-b' }),
    },
    memberships: {
      'Practitioner/prac-a': ['Organization/clinic-a'],
      'Practitioner/prac-b': ['Organization/clinic-b'],
    },
  });
}

beforeEach(() => {
  send.mockReset();
  process.env[ENCRYPTION_KEY_SECRET_NAME] = KEY_MATERIAL;
});

describe('routing', () => {
  test('a callback URL yields exactly its provider and organization', () => {
    expect(parseWebhookUrl('/api/webhooks/drchrono/clinic-a')).toMatchObject({
      provider: 'drchrono',
      organizationId: 'clinic-a',
    });
  });

  test('traversal and extra segments are not a route at all', () => {
    // The organization in this path is the tenant. A parser that accepted a
    // third segment, or a dot-dot, would be a cross-tenant bug rather than a
    // 404.
    expect(parseWebhookUrl('/api/webhooks/drchrono/clinic-a/extra')).toBeUndefined();
    expect(parseWebhookUrl('/api/webhooks/drchrono/..')).toBeUndefined();
    expect(parseWebhookUrl('/api/webhooks/drchrono')).toBeUndefined();
    expect(parseWebhookUrl('/api/rag/search')).toBeUndefined();
  });

  test('an unregistered provider is a 404, not a crash', async () => {
    const medplum = twoClinics();
    const res = await call({ method: 'POST', url: '/api/webhooks/athena/clinic-a', medplum });
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('signature verification fails closed', () => {
  test('the right secret is accepted and queues the import', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([
      {
        name: 'lyfe/chart.import.requested',
        data: {
          organizationId: 'clinic-a',
          requester: 'Practitioner/prac-a',
          batchId: 'hook-d-1',
          // Normalised from the number DrChrono actually sends.
          drchronoPatientId: '12345',
        },
      },
    ]);
  });

  test('a wrong secret is rejected and queues nothing', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: 'not-the-secret-at-all-not-at-all', event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  test('a missing signature is rejected, never read as a verification ping', async () => {
    // This is the legacy bug exactly: an unsigned POST took a branch that
    // answered 200 `verified: true`, which is how a broken signature check
    // stayed invisible for the life of the integration.
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: { 'x-drchrono-event': 'PING' },
      body: JSON.stringify({ receiver: {}, object: {} }),
      medplum,
    });
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('verified');
    expect(send).not.toHaveBeenCalled();
  });

  test('the HMAC the legacy code sent is rejected', async () => {
    // lyfe-provider-ui compared `HMAC-SHA256(secret, rawBody)`. DrChrono sends
    // the token itself. If this ever passes, the contract has been misread
    // again.
    const { createHmac } = await import('node:crypto');
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({
        secret: createHmac('sha256', SECRET_A).update(PATIENT_BODY).digest('hex'),
        event: 'PATIENT_MODIFY',
        delivery: 'd-1',
      }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('tenant isolation', () => {
  test("clinic B's secret does not open clinic A's URL", async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_B, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  test("each clinic's delivery runs as its own requester", async () => {
    const medplum = twoClinics();
    await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-b',
      headers: headers({ secret: SECRET_B, event: 'PATIENT_MODIFY', delivery: 'd-9' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(send.mock.calls[0][0][0].data).toMatchObject({
      organizationId: 'clinic-b',
      requester: 'Practitioner/prac-b',
    });
  });

  test('a requester scoped to another clinic is refused, not honoured', async () => {
    // The stored requester is a lookup key, not a grant. Without this check an
    // admin of clinic A could name clinic B's practitioner and have A's events
    // import into B's chart.
    const medplum = fakeMedplum({
      records: {
        'clinic-a': credentialRecord({
          organizationId: 'clinic-a',
          secret: SECRET_A,
          requester: 'Practitioner/prac-b',
        }),
      },
      memberships: { 'Practitioner/prac-b': ['Organization/clinic-b'] },
    });
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  test('an organization with no integration is a 404', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-z',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  test('a missing webhook secret is a 5xx so the provider retries, not a 200', async () => {
    const record = credentialRecord({ organizationId: 'clinic-a', secret: SECRET_A, requester: 'Practitioner/prac-a' });
    record.extension = record.extension?.filter((ext) => !ext.url?.endsWith('webhookSecret'));
    const medplum = fakeMedplum({
      records: { 'clinic-a': record },
      memberships: { 'Practitioner/prac-a': ['Organization/clinic-a'] },
    });
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(503);
  });
});

describe('idempotency', () => {
  test('a redelivery is a no-op', async () => {
    const medplum = twoClinics();
    const delivery = headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-42' });

    const first = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: delivery,
      body: PATIENT_BODY,
      medplum,
    });
    const second = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: delivery,
      body: PATIENT_BODY,
      medplum,
    });

    expect(first.body.accepted).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ accepted: false, duplicate: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('the same delivery id at two clinics is two deliveries', async () => {
    // Delivery ids are only unique within a provider. Keying the claim without
    // the organization would silently drop one clinic's event as a duplicate of
    // another's, which is the worst possible failure here.
    const medplum = twoClinics();
    await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'same' }),
      body: PATIENT_BODY,
      medplum,
    });
    await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-b',
      headers: headers({ secret: SECRET_B, event: 'PATIENT_MODIFY', delivery: 'same' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('the claim is namespaced by provider and clinic', async () => {
    const medplum = twoClinics();
    await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-7' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect([...medplum.claims.keys()]).toEqual([`${DELIVERY_SYSTEM}|drchrono:clinic-a:d-7`]);
  });

  test('a delivery that would cause work but carries no delivery id is refused', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  test('a claim is released when the work fails to queue', async () => {
    // Otherwise the provider's retry — which exists for exactly this — is
    // discarded as a duplicate of work that never started.
    send.mockRejectedValueOnce(new Error('inngest unreachable'));
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-5' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(res.status).toBe(500);
    expect(medplum.deleted).toHaveLength(1);
  });
});

describe('event handling', () => {
  test('an unknown event is acknowledged, named, and queues nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'SOMETHING_NEW', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });

    // 200, because three retries will not teach us what SOMETHING_NEW is. But
    // reported and logged, because the legacy code mapped every unrecognised
    // event onto "ehr.sync.completed" and nobody could have known.
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.intents).toEqual([
      { kind: 'unknown', reason: 'DrChrono sent SOMETHING_NEW, which this adapter does not map' },
    ]);
    expect(warn.mock.calls.flat().join(' ')).toContain('SOMETHING_NEW');
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a signed PING is acknowledged without claiming or queuing', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PING' }),
      body: JSON.stringify({ receiver: {}, object: {} }),
      medplum,
    });
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([{ kind: 'ignore', reason: 'verification ping' }]);
    expect(medplum.claims.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  test("a clinic's event allow-list suppresses an event the adapter can map", async () => {
    const medplum = fakeMedplum({
      records: {
        'clinic-a': credentialRecord({
          organizationId: 'clinic-a',
          secret: SECRET_A,
          requester: 'Practitioner/prac-a',
          events: 'PATIENT_CREATE, PATIENT_MODIFY',
        }),
      },
      memberships: { 'Practitioner/prac-a': ['Organization/clinic-a'] },
    });
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'APPOINTMENT_CREATE', delivery: 'd-1' }),
      body: JSON.stringify({ receiver: {}, object: { id: 1, patient: 5 } }),
      medplum,
    });
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([
      { kind: 'ignore', reason: "APPOINTMENT_CREATE is not in this clinic's webhookEvents list" },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  test('an allow-listed event still runs', async () => {
    const medplum = fakeMedplum({
      records: {
        'clinic-a': credentialRecord({
          organizationId: 'clinic-a',
          secret: SECRET_A,
          requester: 'Practitioner/prac-a',
          events: 'PATIENT_MODIFY',
        }),
      },
      memberships: { 'Practitioner/prac-a': ['Organization/clinic-a'] },
    });
    await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: PATIENT_BODY,
      medplum,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a body with no usable patient id is acknowledged rather than retried forever', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'APPOINTMENT_CREATE', delivery: 'd-1' }),
      body: JSON.stringify({ receiver: {}, object: { id: 9 } }),
      medplum,
    });
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([
      { kind: 'ignore', reason: 'APPOINTMENT_CREATE carried no usable patient id in object.patient' },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  test('an authentic delivery with an unparseable body is a 400', async () => {
    const medplum = twoClinics();
    const res = await call({
      method: 'POST',
      url: '/api/webhooks/drchrono/clinic-a',
      headers: headers({ secret: SECRET_A, event: 'PATIENT_MODIFY', delivery: 'd-1' }),
      body: 'not json',
      medplum,
    });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the GET ownership handshake', () => {
  test('answers the HMAC DrChrono expects', async () => {
    const { createHmac } = await import('node:crypto');
    const medplum = twoClinics();
    const res = await call({
      method: 'GET',
      url: '/api/webhooks/drchrono/clinic-a?msg=abc123',
      medplum,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ secret_token: createHmac('sha256', SECRET_A).update('abc123').digest('hex') });
  });

  test("each clinic's challenge is signed with its own secret", async () => {
    const medplum = twoClinics();
    const a = await call({ method: 'GET', url: '/api/webhooks/drchrono/clinic-a?msg=same', medplum });
    const b = await call({ method: 'GET', url: '/api/webhooks/drchrono/clinic-b?msg=same', medplum });
    expect(a.body.secret_token).not.toEqual(b.body.secret_token);
  });

  test('refuses to sign anything that could be a document', async () => {
    const medplum = twoClinics();
    expect((await call({ method: 'GET', url: '/api/webhooks/drchrono/clinic-a', medplum })).status).toBe(400);
    expect(
      (
        await call({
          method: 'GET',
          url: `/api/webhooks/drchrono/clinic-a?msg=${encodeURIComponent('{"a":1}')}`,
          medplum,
        })
      ).status
    ).toBe(400);
    expect(
      (await call({ method: 'GET', url: `/api/webhooks/drchrono/clinic-a?msg=${'x'.repeat(300)}`, medplum })).status
    ).toBe(400);
  });

  test('the handshake never reveals the secret itself', async () => {
    const medplum = twoClinics();
    const res = await call({ method: 'GET', url: '/api/webhooks/drchrono/clinic-a?msg=abc123', medplum });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_A);
  });
});
