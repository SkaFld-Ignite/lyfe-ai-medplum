// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { getRagPool, ragQuery } from './db.ts';

/**
 * The `lyfe_rag` schema, and the migration that creates it.
 *
 * ## Everything in here is derived. Nothing in here is clinical data.
 *
 * Read that as a rule about what may be stored, not a note about what happens
 * to be stored. Each row is a chunk of text extracted from a `DocumentReference`'s
 * `Binary`, plus the embedding of that text, plus the ids needed to find it
 * again. The `DocumentReference` is the record; this is an index over it.
 *
 * The test to apply to any column added here: **can it be recomputed by
 * re-reading FHIR?** Chunk text, embeddings, titles, dates, content types and
 * page counts all can. A provider's note typed into this schema could not, and
 * would not belong.
 *
 * Because of that, dropping the whole thing is a recoverable operation:
 *
 * ```sql
 * DROP SCHEMA lyfe_rag CASCADE;   -- then re-ingest
 * ```
 *
 * This is also why the schema carries no foreign keys into Medplum's tables, no
 * triggers on them, and no expectation that a Medplum row still exists. A
 * `DocumentReference` deleted upstream leaves orphan chunks, which the next
 * ingest of that patient clears. An orphan in an index is stale data; an orphan
 * in a clinical table would be a correctness problem.
 *
 * ## Why its own schema
 *
 * `lyfe_rag`, not `public`. Medplum owns `public` and migrates it on every
 * upgrade — it creates, alters and drops tables there without consulting
 * anything else in the database. A table named `document_chunks` sitting in
 * `public` is a name collision waiting for a release. In its own schema, the
 * worker's tables and Medplum's migrations cannot see each other.
 *
 * ## Why the migration lives in the worker
 *
 * `RAG_DATABASE_URL` is a Railway internal reference. It resolves inside the
 * Railway network and nowhere else, so a `psql` script on a developer's machine
 * cannot run it — it fails at DNS. The only process that can reach this
 * database is the worker, so the worker owns the DDL, runs it idempotently, and
 * runs it as the first step of any ingest.
 */

/** The schema every object here lives in. */
export const RAG_SCHEMA = 'lyfe_rag';

/**
 * Embedding width, fixed by the model.
 *
 * Bedrock Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) at 1024
 * dimensions. **Deliberately not** the 1536 of the production Next.js app,
 * which used OpenAI `text-embedding-3-small` through the Vercel AI Gateway.
 * Bedrock is the only inference this worker has credentials for, and this index
 * is new, so there is no stored vector to stay compatible with and the
 * dimension change costs nothing.
 *
 * Changing it later is not an `ALTER TYPE`: existing vectors would be
 * meaningless at a new width. It is a `DROP SCHEMA` and a re-ingest — which is
 * precisely the operation this schema is designed to make safe.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Where `CREATE EXTENSION vector` is installed, resolved rather than assumed.
 *
 * `CREATE EXTENSION` puts the extension in one schema and the `vector` type is
 * only reachable unqualified when that schema is on `search_path`. Hard-coding
 * `vector(1024)` in the DDL works right up until the extension turns out to
 * live somewhere the worker's `search_path` does not include, and then fails
 * with `type "vector" does not exist` — which reads like pgvector is not
 * installed when in fact it is, just elsewhere. Asking the catalogue removes
 * the guess.
 */
let vectorTypeName: string | undefined;

/** Memoised so the DDL runs once per process rather than once per ingest. */
let migration: Promise<void> | undefined;

/**
 * Create the schema, the extension and the tables, idempotently.
 *
 * Safe to call on every run and from every step: each statement is
 * `IF NOT EXISTS`, and the whole thing is memoised per process anyway.
 * @returns Resolves once the schema is present.
 */
export async function ensureRagSchema(): Promise<void> {
  migration ??= migrate().catch((err: unknown) => {
    // Not remembered on failure. A missing grant that an operator then fixes
    // should take effect without redeploying the worker.
    migration = undefined;
    throw err;
  });
  return migration;
}

/**
 * The DDL itself.
 * @returns Resolves once every statement has been applied.
 */
async function migrate(): Promise<void> {
  await ragQuery(`CREATE SCHEMA IF NOT EXISTS ${RAG_SCHEMA}`);

  // pgvector. Installed into `public` so that Medplum's own connections — which
  // do not know about `lyfe_rag` — can still resolve the type if they ever need
  // to, and because that is where every pgvector guide assumes it is.
  //
  // This is the one statement that genuinely needs a privilege the worker might
  // not have, so the failure is reported rather than swallowed. Degrading here
  // would mean silently building an index with no similarity search in it,
  // which looks like working software and answers every question with "no
  // documents matched".
  try {
    await ragQuery('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not create the pgvector extension: ${message}\n` +
        'Document RAG cannot work without it. The role in RAG_DATABASE_URL needs CREATE on the database ' +
        '(superuser or rds_superuser on managed Postgres), or an operator must run ' +
        '`CREATE EXTENSION vector;` once by hand. This is reported rather than worked around because an ' +
        'index without vector search would answer every question with "no documents matched".'
    );
  }

  const vectorType = await resolveVectorType();

  // ---------------------------------------------------------------- chunks
  //
  // The grain is one row per (document, chunk). `document_id` is the rebuild
  // key: re-ingesting a document deletes by it and re-inserts, so a second run
  // replaces rather than duplicates.
  //
  // `organization_id` and `patient_id` are denormalised onto every chunk, and
  // that is not an accident. They are the tenant filter, and retrieval must be
  // able to apply it without a join — a join is a second table that can be
  // wrong, and the thing it would be wrong about is which clinic's PHI comes
  // back.
  //
  // `title`, `document_date` and `content_type` are denormalised too, for a
  // duller reason: the retrieval digest labels every hit
  // `[doc:S1 | <title> (YYYY-MM-DD) | chunk N]`, and resolving six titles
  // through six FHIR reads on every search would make the cheap half of the
  // query the slow half. They are display copies of FHIR fields, so they are
  // exactly as derived as the rest of the row and go stale harmlessly.
  await ragQuery(`
    CREATE TABLE IF NOT EXISTS ${RAG_SCHEMA}.document_chunks (
      id               bigserial PRIMARY KEY,
      organization_id  text        NOT NULL,
      patient_id       text        NOT NULL,
      document_id      text        NOT NULL,
      chunk_index      integer     NOT NULL,
      content          text        NOT NULL,
      embedding        ${vectorType}(${EMBEDDING_DIMENSIONS}) NOT NULL,
      token_estimate   integer     NOT NULL DEFAULT 0,
      title            text,
      document_date    date,
      content_type     text,
      extractor        text        NOT NULL,
      embedding_model  text        NOT NULL,
      indexed_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT document_chunks_doc_chunk_key UNIQUE (document_id, chunk_index)
    )
  `);

  // The selective predicate on every retrieval, in the order the query filters.
  // This index is what keeps the kNN scan bounded to one patient's chunks
  // instead of the whole corpus.
  await ragQuery(`
    CREATE INDEX IF NOT EXISTS document_chunks_tenant_idx
      ON ${RAG_SCHEMA}.document_chunks (organization_id, patient_id)
  `);

  // For the delete half of a re-ingest.
  await ragQuery(`
    CREATE INDEX IF NOT EXISTS document_chunks_document_idx
      ON ${RAG_SCHEMA}.document_chunks (document_id)
  `);

  // ---------------------------------------------------------------- NO VECTOR INDEX
  //
  // There is deliberately no `ivfflat` or `hnsw` index on `embedding`, and the
  // reasoning is worth writing down because the absence looks like an omission.
  //
  // Every retrieval filters to one patient first. A patient has tens of
  // documents and so hundreds of chunks; the corpus is 2,823 documents in
  // total, which is a few tens of thousands of chunks. An exact scan over one
  // patient's few hundred rows is sub-millisecond, and it is *exact* — an
  // approximate index trades recall for speed that is not needed here. The
  // production Next.js app ran with no vector index at all on a comparable
  // corpus for the same reason.
  //
  // An index starts to earn its cost when a single query's candidate set passes
  // roughly 50,000 rows — which here means either a corpus an order of
  // magnitude larger, or a query that searches across patients instead of
  // within one. At that point:
  //
  //   CREATE INDEX ON lyfe_rag.document_chunks
  //     USING hnsw (embedding vector_cosine_ops);
  //
  // HNSW rather than IVFFlat because it needs no training pass and tolerates
  // incremental inserts, which is what an index fed by per-patient ingests
  // gets. It must use `vector_cosine_ops` to match the `<=>` operator the
  // retrieval query uses; a different opclass is silently not used.

  // ---------------------------------------------------------------- documents
  //
  // One row per document, recording what the last ingest of it did. Not
  // required for retrieval — it exists so that "why is this document not
  // searchable" has an answer, which during the OCR work is most of the
  // questions. `status = 'skipped'` with a reason is how a TIFF that Textract
  // refused is distinguished from a document nobody has tried yet.
  await ragQuery(`
    CREATE TABLE IF NOT EXISTS ${RAG_SCHEMA}.documents (
      document_id      text PRIMARY KEY,
      organization_id  text        NOT NULL,
      patient_id       text        NOT NULL,
      status           text        NOT NULL,
      extractor        text,
      content_type     text,
      chunk_count      integer     NOT NULL DEFAULT 0,
      page_count       integer,
      char_count       integer,
      error            text,
      indexed_at       timestamptz NOT NULL DEFAULT now()
    )
  `);

  await ragQuery(`
    CREATE INDEX IF NOT EXISTS documents_tenant_idx
      ON ${RAG_SCHEMA}.documents (organization_id, patient_id)
  `);
}

/**
 * Find the schema-qualified name of pgvector's `vector` type.
 *
 * Resolved from `pg_extension`, so wherever the extension actually landed —
 * `public`, `extensions`, or somewhere an operator chose years ago — the DDL
 * refers to it correctly.
 * @returns e.g. `public.vector`.
 */
async function resolveVectorType(): Promise<string> {
  if (vectorTypeName) {
    return vectorTypeName;
  }
  const rows = await ragQuery<{ nspname: string }>(
    `SELECT n.nspname
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'vector'`
  );
  if (rows.length === 0) {
    throw new Error(
      'pgvector reports as created but is not in pg_extension. The RAG index cannot be built against this database.'
    );
  }
  // Quoted, because a schema name is an identifier and an unquoted one would be
  // folded to lower case — fine for `public`, wrong for anything else.
  vectorTypeName = `"${rows[0].nspname}".vector`;
  return vectorTypeName;
}

/**
 * Format a `number[]` as a pgvector literal.
 *
 * `[0.1,0.2,...]`. The driver has no mapping for the extension's type, so the
 * value is sent as text and cast with `$n::vector` at the call site. Taken
 * unchanged from the production implementation's `toPgVectorLiteral`.
 * @param embedding - The embedding.
 * @returns The literal.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Drop everything, for a rebuild.
 *
 * This is a safe operation, and that is the whole point of the schema's design:
 * it destroys an index, not a record. Exposed so a dimension change or a
 * chunking change has an obvious path — drop, then re-ingest — rather than an
 * in-place migration of data that was never authoritative.
 * @returns Resolves once the schema is gone.
 */
export async function dropRagSchema(): Promise<void> {
  await getRagPool().query(`DROP SCHEMA IF EXISTS ${RAG_SCHEMA} CASCADE`);
  migration = undefined;
}

/** Test seam: forget the memoised migration and resolved type. */
export function __resetSchemaState(): void {
  migration = undefined;
  vectorTypeName = undefined;
}
