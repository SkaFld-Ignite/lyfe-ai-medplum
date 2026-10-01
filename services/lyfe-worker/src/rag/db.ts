// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { PoolClient, QueryResultRow } from 'pg';
import { Pool } from 'pg';

/**
 * The worker's connection to the Postgres that holds the RAG index.
 *
 * ## What this database is, and what it is not
 *
 * It is the **same Postgres instance Medplum runs on**, reached through
 * `RAG_DATABASE_URL`, but the worker only ever touches its own schema. Nothing
 * here reads or writes a Medplum table. The two share an instance for the same
 * reason a search index usually shares a box with the thing it indexes: it is
 * one fewer piece of infrastructure, and the index is worthless without the
 * data anyway.
 *
 * Everything the worker writes is a **derived index, not clinical data**. Not
 * one row is a source of truth. Every row is reconstructible from a
 * `DocumentReference` and its `Binary`, which is where the facts actually live.
 * `DROP SCHEMA lyfe_rag CASCADE` followed by a re-ingest loses exactly nothing
 * — the same claim you can make about a Lucene index, and the reason adding
 * these tables is not a data model change.
 *
 * That claim is a constraint on what may ever be stored here, not just a
 * description of today. If something lands in this schema that cannot be
 * rebuilt from FHIR, the schema has stopped being an index and the rule has
 * been broken.
 *
 * ## Why it is a separate connection and not Medplum's client
 *
 * pgvector similarity search is not expressible over the FHIR REST API. There
 * is no `_sort=cosine` and there never will be. The alternative — fetching
 * every chunk and ranking in JavaScript — is a table scan over the wire.
 *
 * ## Reachability
 *
 * On Railway `RAG_DATABASE_URL` resolves to an internal host, which is not
 * routable from a laptop. That is why {@link ensureRagSchema} is written to run
 * from inside the worker rather than as a local migration script: the only
 * machine that can reach this database is the one that uses it.
 */

/** Longest a single RAG query may run before Postgres aborts it. */
const STATEMENT_TIMEOUT_MS = 60_000;

/**
 * Pool size.
 *
 * Small on purpose. The worker's real concurrency ceiling is Inngest's
 * per-clinic limit (5 by default), and each step uses one client at a time, so
 * a larger pool would only hold idle connections open against a database
 * Medplum is also using.
 */
const POOL_MAX = 4;

let pool: Pool | undefined;

/**
 * Whether the RAG index is configured at all.
 *
 * Checked rather than assumed so the worker still boots, still serves
 * `/health`, and still runs the DrChrono and Zus imports when
 * `RAG_DATABASE_URL` is absent. RAG is an addition to this service, not a
 * precondition for it.
 * @returns True when a connection string is present.
 */
export function isRagConfigured(): boolean {
  return Boolean(process.env.RAG_DATABASE_URL?.trim());
}

/**
 * The shared connection pool.
 *
 * Built once per process. `ssl.rejectUnauthorized: false` applies only when the
 * URL asks for TLS: Railway's internal network terminates inside the project
 * and its certificate is not signed by a public CA, so strict verification
 * fails against a host that is already private.
 * @returns The pool.
 */
export function getRagPool(): Pool {
  if (!pool) {
    const connectionString = process.env.RAG_DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error(
        'RAG_DATABASE_URL is required for document RAG. On Railway it is a reference to the Medplum Postgres; ' +
          'it resolves only inside the Railway network, so this cannot be run from a laptop.'
      );
    }
    pool = new Pool({
      connectionString,
      max: POOL_MAX,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      ...(connectionString.includes('sslmode=require') ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    // Without this an idle client erroring (a database restart, a dropped
    // connection) is an unhandled 'error' event, which takes the whole worker
    // down — including the imports, which have nothing to do with RAG.
    pool.on('error', (err) => {
      console.error('lyfe-rag pool error:', err instanceof Error ? err.message : String(err));
    });
  }
  return pool;
}

/**
 * Run a parameterised query against the RAG schema.
 *
 * Parameterised, always. Every caller in this module passes the organization
 * and patient as bind parameters rather than interpolating them, because the
 * organization filter is the tenant boundary and a boundary spliced into a
 * string is not a boundary.
 * @param sql - The statement, using `$1`-style placeholders.
 * @param params - Values for the placeholders.
 * @returns The result rows.
 */
export async function ragQuery<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getRagPool().query<T>(sql, params);
  return result.rows;
}

/**
 * Run a function inside a transaction.
 *
 * Used for the one write that has to be atomic: replacing a document's chunks.
 * A delete that commits without its insert leaves a document indexed as
 * present but unsearchable, which reads as "the AI cannot see this document"
 * and is the worst of the available failures.
 * @param op - Receives a client bound to the transaction.
 * @returns Whatever `op` resolves to.
 */
export async function ragTransaction<T>(op: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getRagPool().connect();
  try {
    await client.query('BEGIN');
    const result = await op(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close the pool.
 *
 * Only for tests and a deliberate shutdown. The worker is long-lived and the
 * pool is meant to outlive any one run.
 * @returns Resolves once the pool is drained.
 */
export async function closeRagPool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
