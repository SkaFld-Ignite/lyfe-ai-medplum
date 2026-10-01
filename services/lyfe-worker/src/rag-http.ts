// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inngest } from './inngest.ts';
import { isRagConfigured } from './rag/db.ts';
import { getIndexStatus, searchPatientDocuments, TOP_K_DOCS } from './rag/retrieve.ts';
import type { Caller } from './trigger.ts';
import { bearerToken, identify, readJson, send } from './trigger.ts';

/**
 * The two RAG endpoints: start an index, and search one.
 *
 * ## The trust boundary is the same one `trigger.ts` describes
 *
 * These reuse `identify` from that module rather than reimplementing it, and
 * the reuse is the point. Both rules it establishes apply here:
 *
 * 1. the caller's **own token** is verified by asking Medplum who it belongs
 *    to, not by decoding anything locally;
 * 2. the **organization comes from that identity**, looked up in the caller's
 *    `ProjectMembership` by the worker's admin client — never read from the
 *    request body.
 *
 * For the import endpoint the second rule prevents writing into another
 * clinic. Here it prevents *reading* out of one, which is the more direct
 * harm: `/api/rag/search` returns the text of clinical documents, so an
 * organization taken from the body would be a PHI disclosure endpoint with an
 * authentication check in front of it.
 *
 * The body is trusted for `patientId` and `query` only, and that is safe for
 * exactly one reason: the retrieval SQL filters on organization **and**
 * patient, so a patient id belonging to another clinic matches zero rows. The
 * caller chooses what to look for within their clinic; they cannot choose the
 * clinic. If that `WHERE` clause ever loses its organization predicate, this
 * endpoint becomes a breach — which is why the filter is asserted in
 * `rag/retrieve.test.ts` rather than left to review.
 */

/** Cap on patients queued by one ingest request. */
const MAX_PATIENTS_PER_REQUEST = 500;

/** Cap on a query string, so an enormous body cannot be sent to Bedrock. */
const MAX_QUERY_CHARS = 2000;

interface IngestBody {
  patientIds?: unknown;
}

interface SearchBody {
  patientId?: unknown;
  query?: unknown;
  topK?: unknown;
}

/**
 * Authenticate, or write the refusal and return undefined.
 * @param req - The request.
 * @param res - The response.
 * @returns The caller, or undefined when the reply has already been sent.
 */
async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<Caller | undefined> {
  const token = bearerToken(req);
  if (!token) {
    send(res, 401, { error: 'Missing bearer token' });
    return undefined;
  }
  const caller = await identify(token);
  if (!caller) {
    // One message for "no token", "expired token" and "token belongs to a
    // membership with no organization". Distinguishing them would tell an
    // unauthenticated caller which of those they achieved.
    send(res, 401, { error: 'Token is not valid' });
    return undefined;
  }
  return caller;
}

/**
 * Handle `POST /api/rag/ingest`.
 *
 * Queues one `lyfe/rag.ingest.requested` per patient and returns immediately.
 * Indexing a patient's documents takes minutes and the browser must not hold a
 * connection open for it — the same reason the bulk import endpoint returns
 * 202 and hands the run to Inngest.
 * @param req - The request.
 * @param res - The response.
 * @returns Nothing; the reply is written to `res`.
 */
export async function handleRagIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const caller = await authenticate(req, res);
    if (!caller) {
      return;
    }
    if (!isRagConfigured()) {
      send(res, 503, {
        error:
          'Document RAG is not configured on this worker: RAG_DATABASE_URL is unset. On Railway it is a ' +
          'reference to the Medplum Postgres.',
      });
      return;
    }

    const body = (await readJson(req)) as IngestBody;
    const patientIds = Array.isArray(body?.patientIds) ? body.patientIds.map(String).filter(Boolean) : [];
    if (patientIds.length === 0) {
      send(res, 400, { error: 'patientIds is required and must not be empty' });
      return;
    }
    if (patientIds.length > MAX_PATIENTS_PER_REQUEST) {
      send(res, 400, { error: `At most ${MAX_PATIENTS_PER_REQUEST} patients per request` });
      return;
    }

    const batchId = `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await inngest.send(
      patientIds.map((patientId) => ({
        name: 'lyfe/rag.ingest.requested' as const,
        // organizationId is the caller's, resolved above. A patient id from
        // another clinic will still be queued, and the run will index nothing
        // because the Medplum search runs under the worker's org-scoped client
        // — but the chunks could only ever be written under the caller's own
        // organization, so there is no cross-tenant write to be had here.
        data: { organizationId: caller.organizationId, requester: caller.profile, patientId, batchId },
      }))
    );

    send(res, 202, { batchId, queued: patientIds.length });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Handle `POST /api/rag/search`.
 *
 * Synchronous, unlike ingest: this is one embedding call and one indexed query,
 * and the caller is a chat turn waiting for an answer.
 * @param req - The request.
 * @param res - The response.
 * @returns Nothing; the reply is written to `res`.
 */
export async function handleRagSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const caller = await authenticate(req, res);
    if (!caller) {
      return;
    }
    if (!isRagConfigured()) {
      send(res, 503, { error: 'Document RAG is not configured on this worker: RAG_DATABASE_URL is unset.' });
      return;
    }

    const body = (await readJson(req)) as SearchBody;
    const patientId = typeof body?.patientId === 'string' ? body.patientId.trim() : '';
    const query = typeof body?.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_CHARS) : '';
    if (!patientId) {
      send(res, 400, { error: 'patientId is required' });
      return;
    }
    if (!query) {
      send(res, 400, { error: 'query is required' });
      return;
    }
    const topK = typeof body?.topK === 'number' ? body.topK : TOP_K_DOCS;

    // The organization is the caller's, full stop. It is not in the body, it
    // cannot be overridden by the body, and it goes straight into the WHERE
    // clause.
    const result = await searchPatientDocuments({ organizationId: caller.organizationId, patientId }, query, topK);
    send(res, 200, result);
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Handle `POST /api/rag/status`.
 *
 * How much of a patient's record is indexed. POST rather than GET because the
 * patient id is PHI-adjacent and belongs in a body rather than in a URL that
 * lands in every access log between here and the browser.
 * @param req - The request.
 * @param res - The response.
 * @returns Nothing; the reply is written to `res`.
 */
export async function handleRagStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const caller = await authenticate(req, res);
    if (!caller) {
      return;
    }
    if (!isRagConfigured()) {
      send(res, 503, { error: 'Document RAG is not configured on this worker: RAG_DATABASE_URL is unset.' });
      return;
    }
    const body = (await readJson(req)) as SearchBody;
    const patientId = typeof body?.patientId === 'string' ? body.patientId.trim() : '';
    if (!patientId) {
      send(res, 400, { error: 'patientId is required' });
      return;
    }
    const status = await getIndexStatus({ organizationId: caller.organizationId, patientId });
    send(res, 200, status);
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
