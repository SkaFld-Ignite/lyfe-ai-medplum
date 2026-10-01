// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as SchemaModule from './schema.ts';

/**
 * Retrieval, with the database and Bedrock mocked at the boundary.
 *
 * The first describe block is the security test and it is not a formality.
 * `searchPatientDocuments` returns the text of clinical documents. If its
 * `WHERE` clause ever loses the organization predicate, or starts taking the
 * organization from somewhere a caller controls, this service becomes a PHI
 * disclosure endpoint with a login page in front of it. The failure is
 * invisible in manual testing — a single-tenant dev environment returns
 * exactly the same rows either way — so it has to be pinned here.
 */

const ragQuery = vi.fn();
const embedText = vi.fn();
const ensureRagSchema = vi.fn();

vi.mock('./db.ts', () => ({
  ragQuery: (...args: unknown[]) => ragQuery(...args),
  isRagConfigured: () => true,
}));

vi.mock('./bedrock.ts', () => ({
  embedText: (...args: unknown[]) => embedText(...args),
  EMBEDDING_MODEL: 'amazon.titan-embed-text-v2:0',
}));

vi.mock('./schema.ts', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('./schema.ts');
  return { ...actual, ensureRagSchema: () => ensureRagSchema() };
});

const { buildDigest, getIndexStatus, searchPatientDocuments, SNIPPET_CHARS, TOP_K_DOCS } =
  await import('./retrieve.ts');

/**
 * The SQL passed to the most recent `ragQuery` call, whitespace-normalised.
 * @returns The statement.
 */
function lastSql(): string {
  const calls = ragQuery.mock.calls;
  return (calls[calls.length - 1][0] as string).replace(/\s+/g, ' ');
}

/**
 * The parameters passed to the most recent `ragQuery` call.
 * @returns The bind parameters.
 */
function lastParams(): unknown[] {
  const calls = ragQuery.mock.calls;
  return calls[calls.length - 1][1] as unknown[];
}

/**
 * One row as the driver returns it.
 * @param overrides - Fields to change.
 * @returns A chunk row.
 */
function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    content: 'Patient reports intermittent chest pain on exertion.',
    chunk_index: 0,
    document_id: 'doc-abcdef12-3456',
    distance: 0.21,
    title: 'Cardiology consult',
    document_date: new Date('2026-03-14T00:00:00Z'),
    content_type: 'application/pdf',
    ...overrides,
  };
}

describe('tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedText.mockResolvedValue(new Array(1024).fill(0.1));
    ragQuery.mockResolvedValue([]);
  });

  test('filters on organization AND patient, both as bind parameters', async () => {
    await searchPatientDocuments({ organizationId: 'org-a', patientId: 'pat-1' }, 'chest pain');

    const sql = lastSql();
    expect(sql).toContain('c.organization_id = $2');
    expect(sql).toContain('c.patient_id = $3');

    const params = lastParams();
    expect(params[1]).toBe('org-a');
    expect(params[2]).toBe('pat-1');
  });

  test('never interpolates the organization into the SQL string', async () => {
    // A tenant boundary spliced into a string is not a boundary. If this ever
    // regresses, an organization id containing a quote is an injection AND the
    // filter stops being enforceable by the database.
    await searchPatientDocuments({ organizationId: "org-'; DROP TABLE --", patientId: 'pat-1' }, 'q');
    expect(lastSql()).not.toContain('DROP TABLE');
    expect(lastParams()).toContain("org-'; DROP TABLE --");
  });

  test('a patient id from another clinic returns nothing rather than that clinic rows', async () => {
    // The database enforces this; here we pin that both halves of the
    // predicate reach it, which is the part this module controls.
    ragQuery.mockResolvedValue([]);
    const result = await searchPatientDocuments(
      { organizationId: 'org-a', patientId: 'patient-belonging-to-org-b' },
      'chest pain'
    );
    expect(result.hits).toEqual([]);
    expect(lastParams()[1]).toBe('org-a');
  });

  test('the status query is filtered the same way', async () => {
    await getIndexStatus({ organizationId: 'org-a', patientId: 'pat-1' });
    for (const call of ragQuery.mock.calls) {
      const sql = (call[0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain('organization_id = $1');
      expect(sql).toContain('patient_id = $2');
      expect(call[1]).toEqual(['org-a', 'pat-1']);
    }
  });
});

describe('searchPatientDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedText.mockResolvedValue(new Array(1024).fill(0.1));
    ragQuery.mockResolvedValue([]);
  });

  test('ranks by cosine distance ascending, so the closest chunk is first', async () => {
    // `<=>` is a DISTANCE operator: 0 is identical. Sorting it descending
    // returns the six least relevant chunks in the record, which looks like a
    // bad model rather than a reversed sort.
    await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q');
    const sql = lastSql();
    expect(sql).toContain('ORDER BY c.embedding <=> $1::vector');
    expect(sql).not.toContain('DESC');
  });

  test('defaults to the proven top-k of 6', async () => {
    await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q');
    expect(TOP_K_DOCS).toBe(6);
    expect(lastParams()[3]).toBe(6);
  });

  test('clamps a caller-supplied topK so one request cannot read the whole record', async () => {
    await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q', 10_000);
    expect(lastParams()[3]).toBe(24);
  });

  test('clamps a nonsensical topK to something usable', async () => {
    await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q', -5);
    expect(lastParams()[3]).toBe(1);
  });

  test('does not embed or query an empty question', async () => {
    const result = await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, '   ');
    expect(result.hits).toEqual([]);
    expect(embedText).not.toHaveBeenCalled();
    expect(ragQuery).not.toHaveBeenCalled();
  });

  test('says it could not search when embedding fails, rather than throwing', async () => {
    // A retrieval tool that throws takes the whole chat turn with it. One that
    // reports the outage lets the model answer from the structured chart and
    // say what it could not see.
    embedText.mockRejectedValue(new Error('ThrottlingException'));
    const result = await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'chest pain');
    expect(result.hits).toEqual([]);
    expect(result.asText).toContain('Document search unavailable');
    expect(result.asText).toContain('Throttling');
  });

  test('an empty index does not read as "the patient has no documents"', async () => {
    const result = await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q');
    expect(result.asText).toContain('no documents indexed yet');
    // The distinction matters: the model must not tell a clinician a document
    // does not exist when it simply has not been indexed.
    expect(result.asText).toContain('does not mean the patient has no documents');
  });

  test('maps rows to hits and truncates the snippet', async () => {
    ragQuery.mockResolvedValue([row({ content: 'c'.repeat(SNIPPET_CHARS + 100) })]);
    const [hit] = (await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q')).hits;
    expect(hit.snippet).toHaveLength(SNIPPET_CHARS + 1);
    expect(hit.snippet.endsWith('…')).toBe(true);
    expect(hit.documentId).toBe('doc-abcdef12-3456');
    expect(hit.distance).toBe(0.21);
  });

  test('leaves a short snippet untouched, with no ellipsis', async () => {
    ragQuery.mockResolvedValue([row({ content: 'short' })]);
    const [hit] = (await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q')).hits;
    expect(hit.snippet).toBe('short');
  });

  test('formats the document date without shifting it a day west of UTC', async () => {
    ragQuery.mockResolvedValue([row({ document_date: new Date('2026-03-14T00:00:00Z') })]);
    const [hit] = (await searchPatientDocuments({ organizationId: 'o', patientId: 'p' }, 'q')).hits;
    expect(hit.documentDate).toBe('2026-03-14');
  });
});

describe('buildDigest', () => {
  /**
   * @param overrides - Fields to change.
   * @returns A hit.
   */
  function hit(overrides: Partial<Record<string, unknown>> = {}): never {
    return {
      documentId: 'abcdef1234567890',
      chunkIndex: 2,
      snippet: 'Ejection fraction 55%.',
      distance: 0.1,
      title: 'Echocardiogram report',
      documentDate: '2026-03-14',
      contentType: 'application/pdf',
      ...overrides,
    } as never;
  }

  test('uses the exact label format the chat UI parses for citations', () => {
    // `[doc:S1 | <title> (YYYY-MM-DD) | chunk N]`, from the production agent.
    // The model can only write `[doc:S1]` if something told it what S1 is, so
    // this format is the contract between retrieval and the citation pills.
    expect(buildDigest([hit()])).toBe(
      '[doc:S1 | Echocardiogram report (2026-03-14) | chunk 2]\nEjection fraction 55%.'
    );
  });

  test('numbers hits from S1 upward in rank order', () => {
    const digest = buildDigest([hit(), hit({ title: 'Second' }), hit({ title: 'Third' })]);
    expect(digest).toContain('[doc:S1 |');
    expect(digest).toContain('[doc:S2 | Second');
    expect(digest).toContain('[doc:S3 | Third');
  });

  test('falls back to a short document id when a document has no title', () => {
    expect(buildDigest([hit({ title: null })])).toContain('[doc:S1 | doc=abcdef12 (2026-03-14) | chunk 2]');
  });

  test('omits the date entirely when there is none', () => {
    expect(buildDigest([hit({ documentDate: null })])).toContain('[doc:S1 | Echocardiogram report | chunk 2]');
  });
});
