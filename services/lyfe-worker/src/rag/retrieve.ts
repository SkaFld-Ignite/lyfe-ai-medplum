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

/**
 * Default number of documents in a summary's context.
 *
 * Ten, and 600 characters each, which is what lyfe-provider-ui spliced into the
 * same prompt from its ten most recent `DocumentExtraction` rows. Treat these
 * as fallbacks only: the authoritative numbers are `CITATION_LIMITS.documents` and
 * `DOCUMENT_EXCERPT_CHARS` in `bots/shared/ai-summary-prompt.ts`, because they
 * are the point at which the prompt builder and the citation index both stop
 * reading, and the worker passes them in explicitly. Asking for more than the
 * prompt will render buys a bigger query and a longer prompt and nothing else;
 * these numbers exist so a caller that does not care still gets the right
 * answer, not so there are two opinions about it.
 */
export const RECENT_DOCUMENTS = 10;

/** Default characters of document text per document. See {@link RECENT_DOCUMENTS}. */
export const RECENT_DOCUMENT_EXCERPT_CHARS = 600;

/** Upper bound on a caller-supplied `topK`, so one request cannot read the record. */
const MAX_TOP_K = 24;

/** Upper bound on how many documents one summary context may carry. */
const MAX_RECENT_DOCUMENTS = 25;

/** Upper bound on an excerpt, so a caller cannot ask for a whole chunk. */
const MAX_EXCERPT_CHARS = 2000;

/**
 * Slack added to the `left()` bound to pay for the metadata header.
 *
 * Chunk 0 of every document begins with the `[DOCUMENT METADATA] … [END
 * METADATA]` block that ingest prepends before chunking, and that block is
 * stripped below rather than counted against the excerpt. Reading a little
 * extra out of Postgres is how the excerpt ends up being the requested number
 * of characters *of document text* rather than of header.
 */
const METADATA_HEADER_ALLOWANCE = 400;

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

interface RecentRow {
  document_id: string;
  title: string | null;
  document_date: Date | null;
  content: string;
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

export interface RecentDocumentExcerpt {
  /** The `DocumentReference` id the chunk was extracted from. */
  documentId: string;
  title: string | null;
  /** `YYYY-MM-DD`, or null when the document had no date. */
  documentDate: string | null;
  /** The document's opening text, metadata header removed and truncated. */
  excerpt: string;
}

/**
 * The patient's most recent documents, as leading excerpts.
 *
 * ## Why this is not a similarity search
 *
 * {@link searchPatientDocuments} answers a question. This answers no question:
 * it is the document context the AI patient summary is written from, and a
 * summary has no query — it is asked to describe the whole patient. So the
 * selection is recency, exactly as the platform this was ported from did it
 * (ten most recent extractions, 600 characters each), and there is no embedding
 * call, which also means this costs one indexed query rather than a Bedrock
 * round trip.
 *
 * ## One row per document
 *
 * `chunk_index = 0` is the whole trick, and `UNIQUE (document_id, chunk_index)`
 * is what makes it exact: there is at most one chunk 0 per document, so the
 * predicate turns a chunk table into a document table without a `DISTINCT ON`
 * or a join. Chunk 0 is also the right chunk — a clinical document leads with
 * what it is about, and the alternative (the chunk nearest some synthetic
 * query) would silently pick a different part of each document run to run and
 * make the summary non-reproducible.
 *
 * ## The tenant filter is still the security boundary
 *
 * Both `organization_id` and `patient_id`, both as bind parameters, same as
 * every other query in this module. This one feeds a prompt rather than an HTTP
 * response, which makes a missing predicate *worse* rather than better: the
 * leak would arrive as another clinic's findings narrated into a patient's
 * summary and stored as a `Composition`, where it reads as a clinical fact
 * about the wrong person.
 * @param context - The tenant and patient. Both are applied as filters.
 * @param options - Bounds on the context returned.
 * @param options.limit - How many documents, newest first.
 * @param options.excerptChars - Characters of document text per document.
 * @returns The excerpts, newest first.
 */
export async function recentDocumentExcerpts(
  context: RetrievalContext,
  options: { limit?: number; excerptChars?: number } = {}
): Promise<RecentDocumentExcerpt[]> {
  await ensureRagSchema();

  const limit = clamp(options.limit ?? RECENT_DOCUMENTS, 1, MAX_RECENT_DOCUMENTS);
  const excerptChars = clamp(options.excerptChars ?? RECENT_DOCUMENT_EXCERPT_CHARS, 1, MAX_EXCERPT_CHARS);

  const rows = await ragQuery<RecentRow>(
    // `left()` bounds what crosses the wire. A chunk can be 3,200 characters
    // and only a few hundred are wanted, so the truncation belongs in the
    // query rather than in JavaScript that has already paid for the transfer.
    //
    // `NULLS LAST` is deliberate: an undated document sorts after every dated
    // one rather than ahead of them, which is what Postgres would do by
    // default for a DESC sort and would put the least datable documents at the
    // top of a list whose whole selection criterion is recency.
    `SELECT c.document_id,
            c.title,
            c.document_date,
            left(c.content, $4) AS content
       FROM ${RAG_SCHEMA}.document_chunks c
      WHERE c.organization_id = $1
        AND c.patient_id = $2
        AND c.chunk_index = 0
      ORDER BY c.document_date DESC NULLS LAST, c.indexed_at DESC
      LIMIT $3`,
    [context.organizationId, context.patientId, limit, excerptChars + METADATA_HEADER_ALLOWANCE]
  );

  return rows.map((row) => ({
    documentId: row.document_id,
    title: row.title,
    documentDate: toIsoDate(row.document_date),
    excerpt: stripMetadataHeader(row.content).slice(0, excerptChars),
  }));
}

/**
 * Remove ingest's metadata header from a chunk.
 *
 * Chunk 0 begins with `[DOCUMENT METADATA] … [END METADATA]`, prepended before
 * chunking so the title is inside the embedded text. In an excerpt it is pure
 * cost: the title and the date are already on the `[D1] <date> | <title>` label
 * the prompt writes, so leaving the header in would spend a quarter of the
 * excerpt budget restating them to the model.
 *
 * Falls through untouched when there is no header, which is the case for a
 * document that had no title, type, date or source to state.
 * @param content - The chunk text.
 * @returns The document's own text.
 */
export function stripMetadataHeader(content: string): string {
  const marker = '[END METADATA]';
  const end = content.indexOf(marker);
  return end === -1 ? content.trim() : content.slice(end + marker.length).trim();
}

/**
 * Clamp a caller-supplied bound.
 * @param value - The requested value.
 * @param min - Lowest allowed.
 * @param max - Highest allowed.
 * @returns The value within range, with a non-finite input falling back to `min`.
 */
function clamp(value: number, min: number, max: number): number {
  const truncated = Math.trunc(value);
  return Number.isFinite(truncated) ? Math.max(min, Math.min(truncated, max)) : min;
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
