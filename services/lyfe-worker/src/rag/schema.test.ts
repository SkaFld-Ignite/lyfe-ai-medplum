// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The migration, with Postgres mocked at the driver boundary.
 *
 * It cannot be run against the real database from a developer machine —
 * `RAG_DATABASE_URL` is a Railway internal host that does not resolve outside
 * the Railway network — so what is pinned here is the shape of the DDL and the
 * two behaviours that would otherwise only be discovered in production: that
 * every statement is idempotent, and that a missing pgvector grant fails
 * loudly instead of quietly building an index with no similarity search in it.
 */

const ragQuery = vi.fn();
const poolQuery = vi.fn();

vi.mock('./db.ts', () => ({
  ragQuery: (...args: unknown[]) => ragQuery(...args),
  getRagPool: () => ({ query: poolQuery }),
  isRagConfigured: () => true,
}));

const { dropRagSchema, EMBEDDING_DIMENSIONS, ensureRagSchema, RAG_SCHEMA, toVectorLiteral, __resetSchemaState } =
  await import('./schema.ts');

/**
 * Every statement the migration issued, whitespace-normalised.
 * @returns The statements.
 */
function statements(): string[] {
  return ragQuery.mock.calls.map((call) => (call[0] as string).replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSchemaState();
  ragQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_extension')) {
      return [{ nspname: 'public' }];
    }
    return [];
  });
});

describe('ensureRagSchema', () => {
  test('creates the schema, the extension and both tables', async () => {
    await ensureRagSchema();
    const sql = statements().join('\n');
    expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS ${RAG_SCHEMA}`);
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${RAG_SCHEMA}.document_chunks`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${RAG_SCHEMA}.documents`);
  });

  test('every statement is idempotent, so it is safe on every run', async () => {
    // The migration runs as the first step of every ingest. If any statement
    // were not IF NOT EXISTS, the second ingest of the day would fail.
    await ensureRagSchema();
    for (const sql of statements()) {
      if (sql.startsWith('SELECT')) {
        continue;
      }
      expect(sql).toMatch(/IF NOT EXISTS/);
    }
  });

  test('lives in its own schema, where Medplum migrations cannot collide with it', async () => {
    await ensureRagSchema();
    expect(RAG_SCHEMA).toBe('lyfe_rag');
    for (const sql of statements().filter((s) => s.includes('CREATE TABLE'))) {
      expect(sql).toContain('lyfe_rag.');
    }
  });

  test('declares the embedding column at the width Titan returns', async () => {
    await ensureRagSchema();
    const chunks = statements().find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS lyfe_rag.document_chunks'));
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(chunks).toContain('embedding "public".vector(1024) NOT NULL');
  });

  test('qualifies the vector type with the schema the extension actually landed in', async () => {
    // Hard-coding `vector(1024)` works until the extension turns out to live
    // somewhere off the worker's search_path, and then fails with
    // `type "vector" does not exist` — which reads as pgvector not being
    // installed when it is.
    ragQuery.mockImplementation(async (sql: string) =>
      sql.includes('pg_extension') ? [{ nspname: 'extensions' }] : []
    );
    await ensureRagSchema();
    const chunks = statements().find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS lyfe_rag.document_chunks'));
    expect(chunks).toContain('"extensions".vector(1024)');
  });

  test('carries the columns retrieval filters on, on the chunk row itself', async () => {
    // Denormalised deliberately: the tenant filter must not depend on a join,
    // because a join is a second thing that can be wrong and what it would be
    // wrong about is which clinic's PHI comes back.
    await ensureRagSchema();
    const chunks = statements().find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS lyfe_rag.document_chunks'));
    expect(chunks).toContain('organization_id text NOT NULL');
    expect(chunks).toContain('patient_id text NOT NULL');
    expect(chunks).toContain('document_id text NOT NULL');
  });

  test('indexes the tenant pair, which is what bounds the kNN scan', async () => {
    await ensureRagSchema();
    const sql = statements().join('\n');
    expect(sql).toContain('document_chunks_tenant_idx');
    expect(sql).toContain('(organization_id, patient_id)');
  });

  test('builds no vector index — the scan is bounded to one patient', async () => {
    // Deliberate, and documented in schema.ts. An approximate index trades
    // recall for speed that a few hundred rows do not need.
    await ensureRagSchema();
    const sql = statements().join('\n');
    expect(sql).not.toContain('ivfflat');
    expect(sql).not.toContain('hnsw');
  });

  test('keys chunks on (document_id, chunk_index), which is the rebuild key', async () => {
    await ensureRagSchema();
    const chunks = statements().find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS lyfe_rag.document_chunks'));
    expect(chunks).toContain('UNIQUE (document_id, chunk_index)');
  });

  test('runs once per process, however many ingests call it', async () => {
    await ensureRagSchema();
    const first = ragQuery.mock.calls.length;
    await ensureRagSchema();
    await ensureRagSchema();
    expect(ragQuery.mock.calls.length).toBe(first);
  });

  test('fails loudly when pgvector cannot be created, naming the grant needed', async () => {
    // Degrading here would mean an index with no similarity search in it,
    // which looks like working software and answers every question with "no
    // documents matched".
    ragQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE EXTENSION')) {
        throw new Error('permission denied to create extension "vector"');
      }
      return [];
    });
    await expect(ensureRagSchema()).rejects.toThrow(/Could not create the pgvector extension/);
    await expect(ensureRagSchema()).rejects.toThrow(/needs CREATE on the database/);
  });

  test('does not remember a failure, so fixing the grant takes effect without a redeploy', async () => {
    let allowed = false;
    ragQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('CREATE EXTENSION') && !allowed) {
        throw new Error('permission denied');
      }
      if (sql.includes('pg_extension')) {
        return [{ nspname: 'public' }];
      }
      return [];
    });
    await expect(ensureRagSchema()).rejects.toThrow();
    allowed = true;
    await expect(ensureRagSchema()).resolves.toBeUndefined();
  });

  test('reports a vector extension that reports as created but is not in the catalogue', async () => {
    ragQuery.mockImplementation(async () => []);
    await expect(ensureRagSchema()).rejects.toThrow(/not in pg_extension/);
  });
});

describe('dropRagSchema', () => {
  test('is a single cascading drop, because the whole schema is rebuildable', async () => {
    // This is the recovery path for a dimension change or a chunking change:
    // drop and re-ingest, rather than migrating data that was never
    // authoritative.
    poolQuery.mockResolvedValue({ rows: [] });
    await dropRagSchema();
    expect((poolQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ')).toBe('DROP SCHEMA IF EXISTS lyfe_rag CASCADE');
  });
});

describe('toVectorLiteral', () => {
  test('formats as the pgvector text literal the ::vector cast expects', () => {
    expect(toVectorLiteral([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });

  test('handles a full-width vector', () => {
    const literal = toVectorLiteral(new Array(EMBEDDING_DIMENSIONS).fill(0));
    expect(literal.split(',')).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(literal.startsWith('[')).toBe(true);
    expect(literal.endsWith(']')).toBe(true);
  });
});
