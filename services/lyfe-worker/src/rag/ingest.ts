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
import { isTransientAwsFailure } from './ocr.ts';
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
  /**
   * A short slug for why, when this is not `indexed`.
   *
   * The thing a count cannot tell you. `documents-failed: 151` is where this
   * work started; `skipped:document-unavailable 138, failed:unknown 13` is a
   * sentence an operator can act on. Aggregated onto the run's Task by
   * `rag-index`, because the per-document ledger lives in `lyfe_rag`, which
   * resolves only inside the Railway network and which nothing reads back.
   */
  reasonCode?: string;
  /** Pages lost on a document that was otherwise indexed. */
  pageErrors?: number;
}

/**
 * Raised when the document's bytes could not be fetched for a reason a retry
 * fixes — Medplum rate-limiting the Binary read, or answering 5xx.
 *
 * Its own class because the alternative is matching on prose, and the whole
 * reason this file is being changed is that matching on prose put transient
 * failures in the permanent bucket.
 */
export class BinaryFetchError extends Error {
  /** @param message - What the server answered. */
  constructor(message: string) {
    super(message);
    this.name = 'BinaryFetchError';
  }
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
    const bytes = await downloadDocumentBytes(medplum, document.url);

    const extracted = await extractText(bytes, document.contentType, label);

    // The metadata header goes on before chunking, so the title is inside the
    // embedded text of at least the first chunk. See `buildMetadataHeader`.
    const header = buildMetadataHeader(document.metadata);
    const body = header ? `${header}\n\n${extracted.text}` : extracted.text;
    const text = stripNullBytes(body);

    if (extracted.text.trim().length < MIN_INDEXABLE_CHARS) {
      // The header alone is not a document. Recorded so "why is this not
      // searchable" has an answer, with the path that produced nothing.
      report(document, 'skipped', 'no-extractable-text', `nothing extractable via ${extracted.path}`);
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
        reasonCode: 'no-extractable-text',
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

    // A document can be indexed and still be incomplete: `pdf.ts` and `tiff.ts`
    // both keep going when one page fails, which is the right behaviour and was
    // previously invisible. Written into the ledger and logged, so "searchable"
    // and "searchable in full" are distinguishable afterwards.
    const lostPages = extracted.pageErrors?.length ?? 0;
    if (lostPages > 0) {
      report(
        document,
        'indexed',
        'pages-lost',
        `${lostPages} of ${extracted.pageCount} pages failed: ${extracted.pageErrors?.[0]?.error ?? ''}`
      );
    }

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
      error:
        lostPages > 0
          ? `Indexed without ${lostPages} of ${extracted.pageCount} pages: ${extracted.pageErrors?.[0]?.error ?? ''}`
          : null,
    });

    return {
      documentId: document.id,
      status: 'indexed',
      chunkCount: chunks.length,
      path: extracted.path,
      ...(lostPages > 0 ? { pageErrors: lostPages } : {}),
    };
  } catch (err) {
    if (err instanceof ExtractSkipped) {
      report(document, 'skipped', err.code, err.message);
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
      return {
        documentId: document.id,
        status: 'skipped',
        chunkCount: 0,
        reason: err.message,
        reasonCode: err.code,
      };
    }
    // Rate limits and database failures belong to the step, not the document.
    // Rethrown so `withStepTimeout` can turn a 429 into a RetryAfterError and
    // Inngest can retry the step rather than marking 40 documents failed.
    if (isStepLevelFailure(err)) {
      report(document, 'retrying', 'transient', err instanceof Error ? err.message : String(err));
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    report(document, 'failed', 'unknown', message);
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
    }).catch((writeErr: unknown) => {
      // The ledger is the only durable record of this failure and it has just
      // been lost. Swallowing that silently is how a count ends up being the
      // only evidence a document ever existed.
      console.error(
        `[lyfe-rag] could not record the failure of DocumentReference/${document.id}: ` +
          `${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
      );
    });
    return { documentId: document.id, status: 'failed', chunkCount: 0, reason: message, reasonCode: 'unknown' };
  }
}

/**
 * Say, out loud, what happened to a document that was not plainly indexed.
 *
 * This module used to log nothing at all. Every reason went into
 * `lyfe_rag.documents.error` and stopped there — a table in a database whose
 * connection string resolves only inside the Railway private network (see
 * `db.ts`), which nothing reads back, and which no operator has ever opened.
 * The only thing that left the worker was four integers on a `Task`, so a batch
 * reporting `151 failed` was not a question anyone could answer, only one they
 * could restate.
 *
 * One line per non-indexed document. It names the resource, so the next step is
 * `GET /DocumentReference/<id>` rather than a database no one can reach.
 * @param document - The document.
 * @param status - What happened.
 * @param code - The grouping slug.
 * @param reason - The detail.
 */
function report(document: PatientDocument, status: string, code: string, reason: string): void {
  console.warn(
    `[lyfe-rag] ${status} ${code} DocumentReference/${document.id} ` +
      `(${document.contentType ?? 'no content type'}): ${reason.slice(0, 300)}`
  );
}

/**
 * Fetch a document's bytes, and insist that the server actually sent them.
 *
 * ## `MedplumClient.download` does not check the response
 *
 * It is `fetchWithRetry(...).blob()` with no `response.ok` test anywhere in the
 * chain, so a 404, a 403 on an expired storage URL, or a 429 the client's own
 * two retries did not outlast all come back as a **`Blob` of the error body**
 * and not as a thrown error. The old code then handed those bytes to
 * `extractText` as though they were the document.
 *
 * What that looks like downstream is the reason this is worth the paragraph. A
 * Medplum rate-limit body is a JSON `OperationOutcome`; the `DocumentReference`
 * says `application/pdf`; so extraction takes the PDF branch, `unpdf` and
 * `pdf-lib` both refuse the JSON, and the document is recorded as
 * **`Could not read PDF <title>`**. A transient rate limit is filed, permanently,
 * as a corrupt document — with a message that sends the next person to look at
 * the PDF, which is fine.
 *
 * One call for both URL forms. `downloadResponse` rewrites a `Binary/<id>`
 * reference into a FHIR URL, and for an absolute URL on the server's own origin
 * it still attaches the Authorization header — which a bare `fetch` would not,
 * and the Binary endpoint requires.
 * @param medplum - The worker's admin client.
 * @param url - The attachment URL, absolute or `Binary/<id>`.
 * @returns The document's bytes.
 */
async function downloadDocumentBytes(medplum: MedplumClient, url: string): Promise<Buffer> {
  const response = await withMedplum429Retry(() => medplum.downloadResponse(url), `download ${url}`);
  if (!response.ok) {
    // The body is an OperationOutcome or an S3 error document — a few hundred
    // bytes, and the only place the actual reason is written down.
    const detail = await response
      .text()
      .then((text) => text.slice(0, 300).replace(/\s+/g, ' ').trim())
      .catch(() => '');
    const where = `${url} answered HTTP ${response.status}`;
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      // The run's problem. Rethrown so the step retries rather than filing a
      // rate limit as a broken document.
      throw new BinaryFetchError(`${where}${detail ? `: ${detail}` : ''}`);
    }
    // 404, 410, 403 on a signed URL that has expired: this document's problem,
    // and no number of retries produces the bytes.
    throw new ExtractSkipped(`${where}${detail ? `: ${detail}` : ''}`, 'document-unavailable');
  }
  return Buffer.from(await response.arrayBuffer());
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
  // Typed first, prose second. An AWS service error and a Medplum non-OK
  // response both say what they are in a field; the message is a fallback for
  // the errors that carry nothing else, not the primary test. It used to be the
  // only test, which is how Textract's `ThrottlingException` — message `Rate
  // exceeded`, matching none of the patterns below — was recorded as a document
  // that permanently failed, while `ocr.ts` had gone to the trouble of leaving
  // it out of its permanent list precisely so it would be retried.
  if (err instanceof BinaryFetchError || isTransientAwsFailure(err)) {
    return true;
  }
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/too many requests|throttl|\b429\b|rate exceeded/.test(message)) {
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
