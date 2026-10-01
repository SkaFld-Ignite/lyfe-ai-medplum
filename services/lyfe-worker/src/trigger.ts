// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient } from '@medplum/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inngest } from './inngest.ts';
import { getMedplum } from './medplum.ts';

/**
 * The endpoint the app calls to start a bulk run.
 *
 * The browser cannot send Inngest events itself: doing so needs an event key,
 * and a key that ships in a browser bundle is not a key. So the app posts a
 * list of patients here, and this turns them into events.
 *
 * That makes this the trust boundary, and it is the whole reason the endpoint
 * exists rather than the app talking to Inngest directly. Two rules follow, and
 * both matter more than they look:
 *
 * 1. **The caller's own token is verified against Medplum.** Not a shared
 *    secret, not a header the app sets — the actual session token, checked by
 *    asking Medplum who it belongs to. An unauthenticated caller must not be
 *    able to make this service do work on a clinic's data.
 * 2. **The requester is taken from that token, never from the body.** The
 *    importers resolve which clinic to write into from the requester, so
 *    accepting it from the request would hand any caller any clinic — the same
 *    IDOR the importers were hardened against, reintroduced one layer up.
 *
 * What the body *is* trusted for is which patients to import, because that is
 * bounded by the clinic the token resolves to anyway.
 */

/** Cap on patients accepted in one request, so a typo cannot queue a million. */
const MAX_PATIENTS_PER_REQUEST = 5000;

interface BulkImportBody {
  /** DrChrono patient ids to import. */
  drchronoPatientIds: string[];
  /** Pull each patient's Zus record once their chart lands. */
  withZus?: boolean;
}

/**
 * Handle `POST /api/imports/bulk`.
 * @param req - The request.
 * @param res - The response.
 */
export async function handleBulkImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const token = bearerToken(req);
    if (!token) {
      return send(res, 401, { error: 'Missing bearer token' });
    }

    // Verified by asking Medplum, rather than by decoding the token here.
    // Whether this token is still valid, and who it belongs to, are Medplum's
    // to answer — a local check would drift from it.
    const caller = await identify(token);
    if (!caller) {
      return send(res, 401, { error: 'Token is not valid' });
    }

    const body = (await readJson(req)) as BulkImportBody;
    const ids = (body?.drchronoPatientIds ?? []).map(String).filter(Boolean);
    if (ids.length === 0) {
      return send(res, 400, { error: 'drchronoPatientIds is required and must not be empty' });
    }
    if (ids.length > MAX_PATIENTS_PER_REQUEST) {
      return send(res, 400, { error: `At most ${MAX_PATIENTS_PER_REQUEST} patients per request` });
    }

    // One batch id for the whole run, so the patients of a run can be found as
    // a group afterwards — in Inngest, and on the Task identifiers.
    const batchId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await inngest.send(
      ids.map((drchronoPatientId) => ({
        name: 'lyfe/chart.import.requested' as const,
        data: {
          organizationId: caller.organizationId,
          requester: caller.profile,
          drchronoPatientId,
          withZus: body.withZus !== false,
          batchId,
        },
      }))
    );

    // Returns as soon as the events are accepted. The run belongs to Inngest
    // from here, which is what makes closing the tab irrelevant.
    send(res, 202, { batchId, queued: ids.length });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Who the caller is, as Medplum reports them. */
interface Caller {
  /** e.g. `Practitioner/abc` — what the importers resolve the clinic from. */
  profile: string;
  /** The clinic, for routing and concurrency only. */
  organizationId: string;
}

/**
 * Resolve the caller from their own Medplum token.
 *
 * The two halves are done by two different identities, deliberately:
 *
 * - **who they are** comes from their own token, because that is the only
 *   thing that proves it, and Medplum is asked rather than the token decoded
 *   locally — whether it is still valid is Medplum's to answer
 * - **which clinic they belong to** is looked up by this worker, because a
 *   clinic user cannot read their own `ProjectMembership`: it is in
 *   `projectAdminResourceTypes`, so an AccessPolicy cannot grant it
 *
 * Doing the lookup with the caller's token instead silently returns nothing
 * and reads as "your token is invalid", which is both wrong and the kind of
 * error that sends you looking in the wrong place.
 * @param token - The bearer token from the request.
 * @returns The caller, or undefined when the token is not usable.
 */
async function identify(token: string): Promise<Caller | undefined> {
  const asCaller = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL, fetch });
  asCaller.setAccessToken(token);
  const me = (await asCaller.get('auth/me').catch(() => undefined)) as
    { profile?: { resourceType?: string; id?: string } } | undefined;

  const profile = me?.profile;
  if (!profile?.resourceType || !profile.id) {
    return undefined;
  }
  const reference = `${profile.resourceType}/${profile.id}`;

  // Read from the caller's own membership, the same place the importers read
  // it from, so the two cannot disagree about which clinic this run is for.
  const worker = await getMedplum();
  const memberships = await worker
    .searchResources('ProjectMembership', `profile=${reference}&_count=50`)
    .catch(() => []);
  for (const membership of memberships) {
    for (const access of membership.access ?? []) {
      for (const parameter of access.parameter ?? []) {
        const organization = parameter.valueReference?.reference;
        if (parameter.name === 'organization' && organization?.startsWith('Organization/')) {
          return { profile: reference, organizationId: organization.split('/')[1] };
        }
      }
    }
  }
  return undefined;
}

/**
 * Read the bearer token from a request.
 * @param req - The request.
 * @returns The token, or undefined.
 */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/**
 * Read and parse a JSON request body.
 * @param req - The request.
 * @returns The parsed body.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Send a JSON response.
 * @param res - The response.
 * @param status - HTTP status.
 * @param body - The payload.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
