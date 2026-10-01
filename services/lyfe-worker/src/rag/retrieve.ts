// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { embedText } from './bedrock.ts';
import { ragQuery } from './db.ts';
import { ensureRagSchema, RAG_SCHEMA, toVectorLiteral } from './schema.ts';

/**
 * Retrieval: the top-k chunks for one patient, for one question.
 *
 * ## The tenant filter is the security boundary
 *
 * Both `organization_id` and `patient_id` are in the `WHERE` clause, both as
 * bind parameters, on every call. There is no code path that omits either and
 * no argument that makes them optional.
 *
 * `patient_id` alone is not enough. A Medplum patient id is a UUID, so guessing
 * one is impractical — but ids leak: they appear in URLs, in exports, in
 * support tickets, in a CSV someone was sent. If the only filter were the
 * patient, a caller holding an id from another clinic would get that clinic's
 * documents back, which is a PHI breach reached by pasting a string into a
 * search box.
 *
 * With both filters, the organization comes from the caller's own
 * `ProjectMembership` — resolved server-side by the worker's admin client, never
 * taken from the request — so a patient id from another clinic matches zero
 * rows. The caller cannot widen their own scope because they never supply it.
 *
 * This is the same rule the importers were hardened to, stated for reads: the
 * clinic is derived from who is asking, and the request body is trusted only
 * for *what* within that clinic.
 *
 * ## Distance, not similarity
 *
 * `<=>` is pgvector's cosine **distance** operator: 0 is identical, 2 is
 * opposite. `ORDER BY ... ASC` is therefore best-first. Getting this backwards
 * returns the six least relevant chunks in the patient's record, which looks
 * like a bad model rather than a reversed sort.
 */

/** How many chunks a retrieval returns. From the production implementation. */
export const TOP_K_DOCS = 6;

/** How much of a chunk the digest shows. From the production implementation. */
export const SNIPPET_CHARS = 320;

/** Upper bound on a caller-supplied `topK`, so one request cannot read the record. */
const MAX_TOP_K = 24;

export interface DocumentSearchHit {
  documentId: string;
  chunkIndex: number;
  snippet: string;
  /** Cosine distance. Lower is closer. */
  distance: number;
  title: string | null;
  /** `YYYY-MM-DD`, or null when the document had no date. */
  documentDate: string | null;
  contentType: string | null;
}

export interface DocumentSearchResult {
  hits: DocumentSearchHit[];
  /**
   * The hits as the model sees them.
   *
   * Pre-labelled, because the label is what makes a citation possible: the
   * model can only write `[doc:S2]` if something told it that S2 is the second
   * hit. Formatting this at retrieval time rather than in the prompt means the
   * labels cannot drift between the two.
   */
  asText: string;
}

export interface RetrievalContext {
  /** Resolved from the caller's ProjectMembership. Never from a request body. */
  organizationId: string;
  patientId: string;
}

interface ChunkRow {
  content: string;
  chunk_index: number;
  document_id: string;
  distance: number;
  title: string | null;
  document_date: Date | null;
  content_type: string | null;
}

/**
 * Search a patient's indexed documents.
 * @param context - The tenant and patient. Both are applied as filters.
 * @param query - The question, in natural language.
 * @param topK - How many chunks to return. Clamped to {@link MAX_TOP_K}.
 * @returns The hits and the pre-labelled digest.
 */
export async function searchPatientDocuments(
  context: RetrievalContext,
  query: string,
  topK: number = TOP_K_DOCS
): Promise<DocumentSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { hits: [], asText: 'No query provided.' };
  }
  // Ensures the schema exists before the first search of a process. A search
  // against a database where ingest has never run would otherwise fail with
  // `relation does not exist`, which reads as a broken deployment rather than
  // an empty index.
  await ensureRagSchema();

  let embedding: number[];
  try {
    embedding = await embedText(trimmed);
  } catch (err) {
    // Returned rather than thrown. A retrieval tool that throws takes the whole
    // chat turn with it; one that says it could not search lets the model answer
    // from the structured chart and say what it could not see.
    const message = err instanceof Error ? err.message : String(err);
    return { hits: [], asText: `Document search unavailable: ${message}` };
  }

  const limit = Math.max(1, Math.min(Math.trunc(topK) || TOP_K_DOCS, MAX_TOP_K));

  const rows = await ragQuery<ChunkRow>(
    `SELECT c.content,
            c.chunk_index,
            c.document_id,
            (c.embedding <=> $1::vector) AS distance,
            c.title,
            c.document_date,
            c.content_type
       FROM ${RAG_SCHEMA}.document_chunks c
      WHERE c.organization_id = $2
        AND c.patient_id = $3
      ORDER BY c.embedding <=> $1::vector
      LIMIT $4`,
    [toVectorLiteral(embedding), context.organizationId, context.patientId, limit]
  );

  if (rows.length === 0) {
    return {
      hits: [],
      asText:
        'No indexed documents matched. This patient may have no documents indexed yet, or none are relevant to ' +
        'this question. It does not mean the patient has no documents.',
    };
  }

  const hits: DocumentSearchHit[] = rows.map((row) => ({
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    snippet: row.content.length > SNIPPET_CHARS ? `${row.content.slice(0, SNIPPET_CHARS)}…` : row.content,
    distance: Number(row.distance),
    title: row.title,
    documentDate: toIsoDate(row.document_date),
    contentType: row.content_type,
  }));

  return { hits, asText: buildDigest(hits) };
}

/**
 * Format hits for the model.
 *
 * `[doc:S1 | <title> (YYYY-MM-DD) | chunk N]` — the exact shape the production
 * agent used, kept because the chat UI's citation pills parse it and because
 * the model has to be told a label before it can cite one. The title is in the
 * label so a citation is anchored to a document a human can recognise, rather
 * than to an opaque id.
 * @param hits - The hits, best first.
 * @returns The digest text.
 */
export function buildDigest(hits: DocumentSearchHit[]): string {
  return hits
    .map((hit, index) => {
      const label = hit.title ?? `doc=${hit.documentId.slice(0, 8)}`;
      const date = hit.documentDate ? ` (${hit.documentDate})` : '';
      return `[doc:S${index + 1} | ${label}${date} | chunk ${hit.chunkIndex}]\n${hit.snippet}`;
    })
    .join('\n\n');
}

/**
 * Normalise a `date` column to `YYYY-MM-DD`.
 *
 * The driver returns a `date` as a JS `Date` at local midnight. Formatting it
 * with `toISOString()` shifts it a day backwards west of UTC, so a document
 * dated the 1st displays as the previous month. Read in UTC parts instead.
 * @param value - The column value.
 * @returns The ISO date, or null.
 */
function toIsoDate(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return (value as string).slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

/**
 * How much of a patient's record is indexed.
 *
 * Used by the ingest endpoint's response and by the Task output, so "the AI
 * cannot find this" can be answered with a number instead of a guess. Filtered
 * by organization for the same reason the search is.
 * @param context - The tenant and patient.
 * @returns Per-status document counts and the total chunk count.
 */
export async function getIndexStatus(
  context: RetrievalContext
): Promise<{ documents: Record<string, number>; chunks: number }> {
  await ensureRagSchema();
  const statuses = await ragQuery<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count
       FROM ${RAG_SCHEMA}.documents
      WHERE organization_id = $1 AND patient_id = $2
      GROUP BY status`,
    [context.organizationId, context.patientId]
  );
  const chunks = await ragQuery<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM ${RAG_SCHEMA}.document_chunks
      WHERE organization_id = $1 AND patient_id = $2`,
    [context.organizationId, context.patientId]
  );
  return {
    documents: Object.fromEntries(statuses.map((row) => [row.status, Number(row.count)])),
    chunks: Number(chunks[0]?.count ?? 0),
  };
}
