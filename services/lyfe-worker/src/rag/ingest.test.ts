// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ExtractModule from './extract.ts';

/**
 * Ingest, with Medplum, Postgres and Bedrock all mocked at their boundaries.
 *
 * The behaviour that matters most here is that **a second ingest replaces a
 * document's chunks rather than adding to them**. Duplication is not cosmetic:
 * retrieval returns six chunks, so six copies of one paragraph crowd out five
 * other documents and the model answers from one source while believing it
 * consulted six. Nothing errors, and the answer looks plausible.
 *
 * Second is that **no single document can fail the run**. A patient with 40
 * documents and one TIFF must end with 39 indexed.
 */

const download = vi.fn();
const search = vi.fn();
const extractTextMock = vi.fn();
const embedTexts = vi.fn();
const ragQuery = vi.fn();
const transactionQuery = vi.fn();

vi.mock('./db.ts', () => ({
  ragQuery: (...args: unknown[]) => ragQuery(...args),
  ragTransaction: async (op: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
    op({ query: transactionQuery }),
  isRagConfigured: () => true,
}));

vi.mock('./bedrock.ts', () => ({
  embedTexts: (...args: unknown[]) => embedTexts(...args),
  EMBEDDING_MODEL: 'amazon.titan-embed-text-v2:0',
}));

vi.mock('./extract.ts', async () => {
  const actual = await vi.importActual<typeof ExtractModule>('./extract.ts');
  return { ...actual, extractText: (...args: unknown[]) => extractTextMock(...args) };
});

const { ExtractSkipped } = await import('./extract.ts');
const { ingestDocument, isStepLevelFailure, listPatientDocuments, toPatientDocument } = await import('./ingest.ts');

const medplum = { download, search } as never;

const document = {
  id: 'doc-1',
  url: 'https://medplum.example.com/fhir/R4/Binary/bin-1',
  contentType: 'application/pdf',
  metadata: {
    title: 'Cardiology consult',
    documentType: 'Consult note',
    documentDate: '2026-03-14T09:00:00Z',
    source: 'MEDPLUM',
  },
};

/**
 * Every SQL statement issued, across both the pool and the transaction.
 * @returns The statements, whitespace-normalised.
 */
function allSql(): string[] {
  return [...ragQuery.mock.calls, ...transactionQuery.mock.calls].map((call) =>
    (call[0] as string).replace(/\s+/g, ' ').trim()
  );
}

/**
 * The statements issued inside the transaction, in order.
 * @returns The statements, whitespace-normalised.
 */
function transactionSql(): string[] {
  return transactionQuery.mock.calls.map((call) => (call[0] as string).replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  download.mockResolvedValue({ arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 body').buffer });
  extractTextMock.mockResolvedValue({
    text: 'Patient reports intermittent chest pain on exertion. Echo shows preserved function.',
    path: 'pdf-digital',
    pageCount: 2,
    confidence: 1,
    ocrPages: 0,
  });
  embedTexts.mockImplementation(async (texts: string[]) => texts.map(() => new Array(1024).fill(0.1)));
  ragQuery.mockResolvedValue([]);
  transactionQuery.mockResolvedValue({ rows: [] });
});

describe('re-ingest replaces rather than duplicates', () => {
  test('deletes the document chunks before inserting, in the same transaction', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });

    const statements = transactionSql();
    const deleteIndex = statements.findIndex((sql) => sql.startsWith('DELETE FROM lyfe_rag.document_chunks'));
    const insertIndex = statements.findIndex((sql) => sql.startsWith('INSERT INTO lyfe_rag.document_chunks'));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(deleteIndex);
  });

  test('deletes by document_id, which is the rebuild key', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });

    const deleteCall = transactionQuery.mock.calls.find((call) =>
      (call[0] as string).includes('DELETE FROM lyfe_rag.document_chunks')
    );
    expect((deleteCall?.[0] as string).replace(/\s+/g, ' ')).toContain('WHERE document_id = $1');
    expect(deleteCall?.[1]).toEqual(['doc-1']);
  });

  test('is not an upsert, which would strand surplus chunks from a longer previous run', async () => {
    // A re-extraction can legitimately produce FEWER chunks — a better PDF
    // text layer, a cap that now applies. An ON CONFLICT upsert would leave
    // the extra rows from last time behind, still matching queries, attached
    // to text the document no longer contains.
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const insert = transactionSql().find((sql) => sql.startsWith('INSERT INTO lyfe_rag.document_chunks'));
    expect(insert).not.toContain('ON CONFLICT');
  });

  test('two identical ingests issue identical writes, so the index does not grow', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const first = transactionSql();
    vi.clearAllMocks();
    download.mockResolvedValue({ arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 body').buffer });
    extractTextMock.mockResolvedValue({
      text: 'Patient reports intermittent chest pain on exertion. Echo shows preserved function.',
      path: 'pdf-digital',
      pageCount: 2,
      confidence: 1,
      ocrPages: 0,
    });
    embedTexts.mockImplementation(async (texts: string[]) => texts.map(() => new Array(1024).fill(0.1)));
    ragQuery.mockResolvedValue([]);
    transactionQuery.mockResolvedValue({ rows: [] });

    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    expect(transactionSql()).toEqual(first);
  });

  test('the ledger row is upserted on document_id, not appended', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const ledger = allSql().find((sql) => sql.includes('INSERT INTO lyfe_rag.documents'));
    expect(ledger).toContain('ON CONFLICT (document_id) DO UPDATE');
  });
});

describe('what is written', () => {
  test('stamps the tenant and the patient onto every chunk row', async () => {
    // Retrieval filters on these without a join, so they have to be here.
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const insert = transactionQuery.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO lyfe_rag.document_chunks')
    );
    const values = insert?.[1] as unknown[];
    expect(values[0]).toBe('org-a');
    expect(values[1]).toBe('pat-1');
    expect(values[2]).toBe('doc-1');
  });

  test('casts the embedding to ::vector, since the driver has no mapping for it', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const insert = transactionSql().find((sql) => sql.startsWith('INSERT INTO lyfe_rag.document_chunks'));
    expect(insert).toContain('::vector');
  });

  test('embeds the metadata header along with the body', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const embedded = (embedTexts.mock.calls[0][0] as string[]).join('\n');
    expect(embedded).toContain('TITLE: Cardiology consult');
    expect(embedded).toContain('chest pain');
  });

  test('truncates a FHIR instant to a date, because the column is a date', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const values = transactionQuery.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO lyfe_rag.document_chunks')
    )?.[1] as unknown[];
    expect(values[8]).toBe('2026-03-14');
  });

  test('records the extractor path, so free paths are tellable from billable ones', async () => {
    await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    const values = transactionQuery.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO lyfe_rag.document_chunks')
    )?.[1] as unknown[];
    expect(String(values[10])).toContain(':pdf-digital');
  });

  test('inserts all chunks in one statement rather than one round trip each', async () => {
    extractTextMock.mockResolvedValue({
      text: 'q'.repeat(20_000),
      path: 'xml-strip',
      pageCount: 1,
      confidence: 1,
      ocrPages: 0,
    });
    const result = await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    expect(result.chunkCount).toBeGreaterThan(5);
    expect(transactionSql().filter((sql) => sql.startsWith('INSERT INTO lyfe_rag.document_chunks'))).toHaveLength(1);
  });

  test('fails rather than mis-filing when the embedder returns the wrong count', async () => {
    embedTexts.mockResolvedValue([new Array(1024).fill(0.1), new Array(1024).fill(0.2)]);
    extractTextMock.mockResolvedValue({
      text: 'One short chunk only.',
      path: 'text-utf8',
      pageCount: 1,
      confidence: 1,
      ocrPages: 0,
    });
    const result = await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('Embedding count mismatch');
    expect(transactionQuery).not.toHaveBeenCalled();
  });
});

describe('one document never fails the run', () => {
  test('a TIFF is recorded as skipped and returns, it does not throw', async () => {
    extractTextMock.mockRejectedValue(new ExtractSkipped('Textract rejects raw TIFF'));
    const result = await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('TIFF');
    expect(allSql().some((sql) => sql.includes('INSERT INTO lyfe_rag.documents'))).toBe(true);
  });

  test('a corrupt document is recorded as failed and returns', async () => {
    extractTextMock.mockRejectedValue(new Error('Could not read PDF: xref table is broken'));
    const result = await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('xref');
  });

  test('a document yielding almost no text is skipped, not indexed as noise', async () => {
    // The unknown-utf8 path decodes arbitrary binary and produces mojibake,
    // which still competes in a similarity ranking against real text.
    extractTextMock.mockResolvedValue({
      text: 'ï¿½ï¿½',
      path: 'unknown-utf8',
      pageCount: 1,
      confidence: 1,
      ocrPages: 0,
    });
    const result = await ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document });
    expect(result.status).toBe('skipped');
    expect(embedTexts).not.toHaveBeenCalled();
    // Any chunks from a previous, better extraction are cleared, so the index
    // does not keep serving text the document no longer yields.
    expect(allSql().some((sql) => sql.includes('DELETE FROM lyfe_rag.document_chunks'))).toBe(true);
  });

  test('a rate limit is rethrown, because that is the step’s problem and retrying fixes it', async () => {
    // Recording 40 documents as failed because the quota reset in 11 seconds
    // would be the wrong response: the step should retry.
    extractTextMock.mockRejectedValue(new Error('Too Many Requests'));
    await expect(ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document })).rejects.toThrow(
      /Too Many Requests/
    );
  });

  test('the index database being unreachable is rethrown too', async () => {
    extractTextMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.3:5432'));
    await expect(ingestDocument({ medplum, organizationId: 'org-a', patientId: 'pat-1', document })).rejects.toThrow(
      /ECONNREFUSED/
    );
  });
});

describe('isStepLevelFailure', () => {
  test('treats rate limits and database outages as the step’s problem', () => {
    expect(isStepLevelFailure(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isStepLevelFailure(new Error('throttled'))).toBe(true);
    expect(isStepLevelFailure(new Error('connect ECONNREFUSED'))).toBe(true);
    expect(isStepLevelFailure(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  test('treats a bad document as the document’s problem', () => {
    expect(isStepLevelFailure(new Error('Could not read PDF'))).toBe(false);
    expect(isStepLevelFailure(new Error('HTTP 404 Not Found'))).toBe(false);
    expect(isStepLevelFailure(new Error('unsupported document format'))).toBe(false);
  });
});

describe('toPatientDocument', () => {
  test('handles an absolute attachment URL', () => {
    const parsed = toPatientDocument({
      resourceType: 'DocumentReference',
      id: 'd1',
      status: 'current',
      content: [
        { attachment: { url: 'https://medplum.example.com/fhir/R4/Binary/b1', contentType: 'application/pdf' } },
      ],
    });
    expect(parsed?.url).toBe('https://medplum.example.com/fhir/R4/Binary/b1');
  });

  test('handles a relative Binary/<id> reference, which some documents use', () => {
    const parsed = toPatientDocument({
      resourceType: 'DocumentReference',
      id: 'd1',
      status: 'current',
      content: [{ attachment: { url: 'Binary/b1' } }],
    });
    // Passed through untouched. MedplumClient.download rewrites this form into
    // a FHIR URL itself, so one call covers both.
    expect(parsed?.url).toBe('Binary/b1');
    expect(parsed?.contentType).toBeNull();
  });

  test('drops a DocumentReference with no attachment URL', () => {
    expect(
      toPatientDocument({
        resourceType: 'DocumentReference',
        id: 'd1',
        status: 'current',
        content: [{ attachment: { contentType: 'application/pdf' } }],
      })
    ).toBeUndefined();
  });

  test('prefers the attachment title, falling back to the description', () => {
    const withTitle = toPatientDocument({
      resourceType: 'DocumentReference',
      id: 'd1',
      status: 'current',
      description: 'desc',
      content: [{ attachment: { url: 'Binary/b1', title: 'FIBROSCAN RADIOLOGY ORDER' } }],
    });
    expect(withTitle?.metadata.title).toBe('FIBROSCAN RADIOLOGY ORDER');

    const withoutTitle = toPatientDocument({
      resourceType: 'DocumentReference',
      id: 'd1',
      status: 'current',
      description: 'Discharge summary',
      content: [{ attachment: { url: 'Binary/b1' } }],
    });
    expect(withoutTitle?.metadata.title).toBe('Discharge summary');
  });

  test('takes only the first content entry, so one document is not indexed twice', () => {
    const parsed = toPatientDocument({
      resourceType: 'DocumentReference',
      id: 'd1',
      status: 'current',
      content: [
        { attachment: { url: 'Binary/pdf', contentType: 'application/pdf' } },
        { attachment: { url: 'Binary/txt', contentType: 'text/plain' } },
      ],
    });
    expect(parsed?.url).toBe('Binary/pdf');
  });
});

describe('listPatientDocuments', () => {
  beforeEach(() => {
    search.mockReset();
  });

  /**
   * @param count - How many entries the page holds.
   * @param offset - Where the page starts, so ids are unique.
   * @returns A search bundle.
   */
  function page(count: number, offset = 0): unknown {
    return {
      resourceType: 'Bundle',
      entry: Array.from({ length: count }, (_unused, i) => ({
        resource: {
          resourceType: 'DocumentReference',
          id: `doc-${offset + i}`,
          status: 'current',
          content: [{ attachment: { url: `Binary/bin-${offset + i}` } }],
        },
      })),
    };
  }

  test('pages until the server returns a short page', async () => {
    // An unpaged search silently stops at the server default, which would
    // index the first 20 documents and report success.
    search.mockResolvedValueOnce(page(100, 0)).mockResolvedValueOnce(page(12, 100));
    const documents = await listPatientDocuments(medplum, 'pat-1', 400);
    expect(documents).toHaveLength(112);
    expect(search).toHaveBeenCalledTimes(2);
    expect(String(search.mock.calls[1][1])).toContain('_offset=100');
  });

  test('stops at the cap, so one patient cannot run forever', async () => {
    search.mockResolvedValue(page(100, 0));
    const documents = await listPatientDocuments(medplum, 'pat-1', 10);
    expect(documents).toHaveLength(10);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('scopes the search to the patient', async () => {
    search.mockResolvedValue(page(0));
    await listPatientDocuments(medplum, 'pat-1', 400);
    expect(String(search.mock.calls[0][1])).toContain('patient=Patient/pat-1');
  });

  test('searches sequentially, never in parallel', async () => {
    // Concurrent Medplum searches from one client share a rate-limit bucket,
    // so parallelising them turns a slow read into a 429.
    let concurrent = 0;
    let peak = 0;
    search.mockImplementation(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      concurrent--;
      return page(100, 0);
    });
    await listPatientDocuments(medplum, 'pat-1', 250);
    expect(peak).toBe(1);
  });
});
