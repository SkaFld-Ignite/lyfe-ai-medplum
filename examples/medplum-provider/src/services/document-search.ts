// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { IMPORT_WORKER_URL } from './bulk-import';

/**
 * Searching a patient's indexed documents, from the browser.
 *
 * The index itself is pgvector over text extracted from `DocumentReference`
 * binaries, built and queried by the lyfe-worker — see
 * `services/lyfe-worker/src/rag/`. It is not reachable from here directly and
 * is not meant to be: `RAG_DATABASE_URL` is a Railway-internal host, and a
 * similarity search is not expressible over the FHIR REST API in the first
 * place. So this is one authenticated POST to the worker.
 *
 * ## The clinic is never sent
 *
 * The caller's own Medplum access token goes in the `Authorization` header and
 * nothing else identifying travels with it. The worker verifies that token
 * against Medplum, resolves the caller's organization from their
 * `ProjectMembership` with its own admin client, and puts *that* organization
 * in the retrieval `WHERE` clause. There is deliberately no `organizationId`
 * field in this request body: if the browser could name a clinic, this would be
 * a PHI disclosure endpoint with a login in front of it. See
 * `services/lyfe-worker/src/rag-http.ts`.
 *
 * ## Why this is the same URL as the import worker
 *
 * There is one worker service. `/api/imports/bulk` and `/api/rag/search` are
 * two routes on it, so they share one piece of configuration rather than
 * growing a second environment variable that would silently be allowed to point
 * somewhere else.
 */

/** One matched chunk. The grain is a chunk, so one document can appear twice. */
export interface DocumentSearchHit {
  /** The `DocumentReference` this chunk came out of. */
  documentId: string;
  /** Which chunk of that document, so a citation can be traced back to a page. */
  chunkIndex: number;
  snippet: string;
  /** Cosine distance. Lower is closer. */
  distance: number;
  title: string | null;
  /** `YYYY-MM-DD`, or null when the document carried no date. */
  documentDate: string | null;
  contentType: string | null;
}

/** What the worker returns from `/api/rag/search`. */
export interface DocumentSearchResult {
  hits: DocumentSearchHit[];
  /**
   * The worker's own prose about the search.
   *
   * Only read when there are no hits, where it is the one thing that can tell
   * "nothing matched" apart from "the embedding call failed" — a distinction
   * the model has to be able to report honestly. When there *are* hits it also
   * carries a pre-numbered digest, which this app does not use; see
   * `toDocumentSearchToolResult` in `src/utils/spaceMessaging.ts` for why.
   */
  asText: string;
}

export interface DocumentSearchRequest {
  patientId: string;
  query: string;
  /** How many chunks to ask for. The worker clamps it. */
  topK?: number;
}

/**
 * Search one patient's indexed documents.
 * @param medplum - Authenticated Medplum client, for the caller's access token.
 * @param request - The patient, the question, and how many chunks to return.
 * @returns The hits, best first, and the worker's note about the search.
 * @throws If no worker is configured or the worker refused the request.
 */
export async function searchPatientDocuments(
  medplum: MedplumClient,
  request: DocumentSearchRequest
): Promise<DocumentSearchResult> {
  if (!IMPORT_WORKER_URL) {
    throw new Error('No document index is configured for this deployment');
  }
  const response = await fetch(`${IMPORT_WORKER_URL.replace(/\/$/, '')}/api/rag/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${medplum.getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Document search failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as DocumentSearchResult;
}
