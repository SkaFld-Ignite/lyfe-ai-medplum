// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { withMedplum429Retry } from '../../../../examples/medplum-provider/bots/shared/batch.ts';
import { EMBEDDING_MODEL, embedTexts } from './bedrock.ts';
import { ragQuery, ragTransaction } from './db.ts';
import type { DocumentMetadata } from './extract.ts';
import {
  buildMetadataHeader,
  chunkText,
  EXTRACTOR_VERSION,
  ExtractSkipped,
  extractText,
  stripNullBytes,
} from './extract.ts';
import { RAG_SCHEMA, toVectorLiteral } from './schema.ts';

/**
 * Ingest: `DocumentReference` → text → chunks → embeddings → rows.
 *
 * ## Re-ingest replaces, it never appends
 *
 * This is the property the whole design turns on, and it is why `document_id`
 * is the key rather than a surrogate. Running ingest twice on a patient must
 * leave the index identical, not doubled. A duplicated chunk is not a cosmetic
 * problem: retrieval returns the top six chunks, and six copies of one
 * paragraph crowds out five other documents, so the model answers from one
 * document while believing it looked at six.
 *
 * So every document's write is `DELETE WHERE document_id = $1` then `INSERT`,
 * both inside one transaction. Not an upsert on `(document_id, chunk_index)`:
 * a re-extraction can produce *fewer* chunks than last time — a better PDF text
 * layer, a cap that now applies — and an upsert would leave the surplus chunks
 * from the previous run behind as orphans that still match queries.
 *
 * ## Why no document is a reason to fail the run
 *
 * A patient with 40 documents where one is a TIFF should end with 39 documents
 * indexed, not zero. Each document is caught individually, recorded in
 * `lyfe_rag.documents` with its status, and the run continues. The counts come
 * back so the Task shows `indexed: 39, skipped: 1` rather than a failure that
 * says nothing about the other 39.
 */

/**
 * Text shorter than this is treated as nothing.
 *
 * Guards the `unknown-utf8` path, which decodes arbitrary binary as UTF-8 and
 * produces mojibake. Indexing that noise means embedding garbage that can
 * still win a similarity ranking against real text, which is worse than the
 * document being absent.
 */
const MIN_INDEXABLE_CHARS = 20;

/** Status recorded per document in `lyfe_rag.documents`. */
export type IngestStatus = 'indexed' | 'skipped' | 'failed';

export interface IngestDocumentResult {
  documentId: string;
  status: IngestStatus;
  chunkCount: number;
  path?: string;
  reason?: string;
}

export interface PatientDocument {
  id: string;
  /** Absolute URL, or `Binary/<id>`. Both forms occur. */
  url: string;
  contentType: string | null;
  metadata: DocumentMetadata;
}

/**
 * Find a patient's documents.
 *
 * Paged explicitly rather than with `searchResources`'s convenience, because a
 * patient's document count is unbounded and a single unpaged search silently
 * stops at the server's default count — which would index the first 20
 * documents and report success.
 *
 * Sequential, never `Promise.all`: concurrent Medplum searches from one client
 * share one rate-limit bucket, so parallelising them converts a slow read into
 * a 429.
 * @param medplum - The worker's admin client.
 * @param patientId - The patient.
 * @param maxDocuments - Hard cap, so a pathological patient cannot run forever.
 * @returns The documents that have retrievable bytes.
 */
export async function listPatientDocuments(
  medplum: MedplumClient,
  patientId: string,
  maxDocuments: number
): Promise<PatientDocument[]> {
  const out: PatientDocument[] = [];
  const pageSize = 100;
  let offset = 0;

  for (;;) {
    const bundle = await withMedplum429Retry(
      () =>
        medplum.search(
          'DocumentReference',
          `patient=Patient/${patientId}&status=current&_count=${pageSize}&_offset=${offset}&_sort=-date`
        ),
      `list documents for Patient/${patientId}`
    );
    const entries = bundle.entry ?? [];
    for (const entry of entries) {
      const document = entry.resource as DocumentReference | undefined;
      const parsed = document ? toPatientDocument(document) : undefined;
      if (parsed) {
        out.push(parsed);
      }
      if (out.length >= maxDocuments) {
        return out;
      }
    }
    if (entries.length < pageSize) {
      return out;
    }
    offset += pageSize;
  }
}

/**
 * Pull the fields ingest needs off a `DocumentReference`.
 *
 * `content[0]` only. A `DocumentReference` may carry several renditions of the
 * same document — a PDF and its plain-text equivalent, say — and indexing both
 * would put the same content in the index twice under one document id. The
 * first is the server's preferred rendition.
 * @param document - The resource.
 * @returns The parsed document, or undefined when there are no bytes to fetch.
 */
export function toPatientDocument(document: DocumentReference): PatientDocument | undefined {
  const attachment = document.content?.[0]?.attachment;
  if (!attachment?.url || !document.id) {
    return undefined;
  }
  const type = document.type;
  return {
    id: document.id,
    url: attachment.url,
    contentType: attachment.contentType ?? null,
    metadata: {
      title: attachment.title ?? document.description ?? null,
      documentType: type?.text ?? type?.coding?.[0]?.display ?? type?.coding?.[0]?.code ?? null,
      documentDate: document.date ?? null,
      source: 'MEDPLUM',
    },
  };
}

/**
 * Ingest one document.
 *
 * Returns rather than throws for anything that is this document's problem. It
 * throws only for failures that are the *run's* problem — a 429, the database
 * being unreachable — because those should retry the step, and retrying is
 * exactly the wrong response to a TIFF.
 * @param props - Ingest inputs.
 * @param props.medplum - The worker's admin client, used to download the Binary.
 * @param props.organizationId - The tenant. Resolved from the caller, never from a request body.
 * @param props.patientId - The patient the chunks are filed under.
 * @param props.document - The document to ingest.
 * @returns What happened to this document.
 */
export async function ingestDocument(props: {
  medplum: MedplumClient;
  organizationId: string;
  patientId: string;
  document: PatientDocument;
}): Promise<IngestDocumentResult> {
  const { medplum, organizationId, patientId, document } = props;
  const label = document.metadata.title ?? `DocumentReference/${document.id}`;

  try {
    // One call for both URL forms. `MedplumClient.download` rewrites a
    // `Binary/<id>` reference into a FHIR URL, and for an absolute URL on the
    // server's own origin it still attaches the Authorization header — which a
    // bare `fetch` would not, and the Binary endpoint requires.
    const blob = await withMedplum429Retry(() => medplum.download(document.url), `download ${document.url}`);
    const bytes = Buffer.from(await blob.arrayBuffer());

    const extracted = await extractText(bytes, document.contentType, label);

    // The metadata header goes on before chunking, so the title is inside the
    // embedded text of at least the first chunk. See `buildMetadataHeader`.
    const header = buildMetadataHeader(document.metadata);
    const body = header ? `${header}\n\n${extracted.text}` : extracted.text;
    const text = stripNullBytes(body);

    if (extracted.text.trim().length < MIN_INDEXABLE_CHARS) {
      // The header alone is not a document. Recorded so "why is this not
      // searchable" has an answer, with the path that produced nothing.
      await recordDocument({
        documentId: document.id,
        organizationId,
        patientId,
        status: 'skipped',
        extractor: `${EXTRACTOR_VERSION}:${extracted.path}`,
        contentType: document.contentType,
        chunkCount: 0,
        pageCount: extracted.pageCount,
        charCount: extracted.text.length,
        error: `Extracted only ${extracted.text.length} characters via ${extracted.path}`,
      });
      await deleteDocumentChunks(document.id);
      return {
        documentId: document.id,
        status: 'skipped',
        chunkCount: 0,
        path: extracted.path,
        reason: 'no extractable text',
      };
    }

    const chunks = chunkText(text);
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: ${chunks.length} chunks, ${embeddings.length} embeddings`);
    }

    await ragTransaction(async (client) => {
      // Delete-then-insert, in one transaction. See the note at the top of this
      // file on why this is not an upsert.
      await client.query(`DELETE FROM ${RAG_SCHEMA}.document_chunks WHERE document_id = $1`, [document.id]);

      const columnsPerRow = 12;
      const placeholders: string[] = [];
      const values: unknown[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const base = i * columnsPerRow;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector, ` +
            `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`
        );
        values.push(
          organizationId,
          patientId,
          document.id,
          chunks[i].index,
          chunks[i].text,
          toVectorLiteral(embeddings[i]),
          chunks[i].tokenEstimate,
          document.metadata.title,
          // A FHIR `instant` or `dateTime` truncated to its date part. The
          // column is `date` because retrieval only ever shows the day.
          document.metadata.documentDate?.slice(0, 10) ?? null,
          document.contentType,
          `${EXTRACTOR_VERSION}:${extracted.path}`,
          EMBEDDING_MODEL
        );
      }
      // One multi-VALUES insert rather than a statement per chunk: a 40-chunk
      // C-CDA would otherwise be 40 round trips inside the transaction.
      await client.query(
        `INSERT INTO ${RAG_SCHEMA}.document_chunks
           (organization_id, patient_id, document_id, chunk_index, content, embedding,
            token_estimate, title, document_date, content_type, extractor, embedding_model)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    });

    await recordDocument({
      documentId: document.id,
      organizationId,
      patientId,
      status: 'indexed',
      extractor: `${EXTRACTOR_VERSION}:${extracted.path}`,
      contentType: document.contentType,
      chunkCount: chunks.length,
      pageCount: extracted.pageCount,
      charCount: text.length,
      error: null,
    });

    return { documentId: document.id, status: 'indexed', chunkCount: chunks.length, path: extracted.path };
  } catch (err) {
    if (err instanceof ExtractSkipped) {
      await recordDocument({
        documentId: document.id,
        organizationId,
        patientId,
        status: 'skipped',
        extractor: null,
        contentType: document.contentType,
        chunkCount: 0,
        pageCount: null,
        charCount: null,
        error: err.message,
      });
      return { documentId: document.id, status: 'skipped', chunkCount: 0, reason: err.message };
    }
    // Rate limits and database failures belong to the step, not the document.
    // Rethrown so `withStepTimeout` can turn a 429 into a RetryAfterError and
    // Inngest can retry the step rather than marking 40 documents failed.
    if (isStepLevelFailure(err)) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordDocument({
      documentId: document.id,
      organizationId,
      patientId,
      status: 'failed',
      extractor: null,
      contentType: document.contentType,
      chunkCount: 0,
      pageCount: null,
      charCount: null,
      error: message,
    }).catch(() => undefined);
    return { documentId: document.id, status: 'failed', chunkCount: 0, reason: message };
  }
}

/**
 * Is this failure about the run rather than this document?
 *
 * Only two categories qualify, and both are things a retry genuinely fixes: a
 * rate limit, and the index database being unreachable. Everything else — a
 * corrupt PDF, a 404 on a Binary, an unsupported format — is this document's
 * problem and must not take the other 39 with it.
 * @param err - The thrown error.
 * @returns True when the error should abort the step.
 */
export function isStepLevelFailure(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/too many requests|throttl|\b429\b/.test(message)) {
    return true;
  }
  return /econnrefused|enotfound|connection terminated|too many clients|rag_database_url|pgvector/.test(message);
}

/**
 * Remove a document's chunks.
 * @param documentId - The document.
 * @returns Resolves once deleted.
 */
async function deleteDocumentChunks(documentId: string): Promise<void> {
  await ragQuery(`DELETE FROM ${RAG_SCHEMA}.document_chunks WHERE document_id = $1`, [documentId]);
}

/**
 * Record what the last ingest of a document did.
 * @param row - The ledger row.
 * @param row.documentId - The DocumentReference this describes.
 * @param row.organizationId - The tenant, so the ledger is scopeable like the chunks.
 * @param row.patientId - The patient the document belongs to.
 * @param row.status - `indexed`, `skipped` or `failed`.
 * @param row.extractor - Which extractor ran, versioned, or null when none did.
 * @param row.contentType - The declared content type, for a format-by-format breakdown.
 * @param row.chunkCount - How many chunks landed.
 * @param row.pageCount - Pages the extractor reported.
 * @param row.charCount - Characters indexed, for spotting documents that yielded almost nothing.
 * @param row.error - Why it was skipped or failed.
 * @returns Resolves once written.
 */
async function recordDocument(row: {
  documentId: string;
  organizationId: string;
  patientId: string;
  status: IngestStatus;
  extractor: string | null;
  contentType: string | null;
  chunkCount: number;
  pageCount: number | null;
  charCount: number | null;
  error: string | null;
}): Promise<void> {
  await ragQuery(
    `INSERT INTO ${RAG_SCHEMA}.documents
       (document_id, organization_id, patient_id, status, extractor, content_type,
        chunk_count, page_count, char_count, error, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (document_id) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       patient_id      = EXCLUDED.patient_id,
       status          = EXCLUDED.status,
       extractor       = EXCLUDED.extractor,
       content_type    = EXCLUDED.content_type,
       chunk_count     = EXCLUDED.chunk_count,
       page_count      = EXCLUDED.page_count,
       char_count      = EXCLUDED.char_count,
       error           = EXCLUDED.error,
       indexed_at      = now()`,
    [
      row.documentId,
      row.organizationId,
      row.patientId,
      row.status,
      row.extractor,
      row.contentType,
      row.chunkCount,
      row.pageCount,
      row.charCount,
      // Truncated: an error column is for reading, and a 40kB stack trace in a
      // status field is not read by anyone.
      row.error?.slice(0, 1000) ?? null,
    ]
  );
}
