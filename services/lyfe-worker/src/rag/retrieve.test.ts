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

const {
  buildDigest,
  getIndexStatus,
  recentDocumentExcerpts,
  RECENT_DOCUMENT_EXCERPT_CHARS,
  RECENT_DOCUMENTS,
  searchPatientDocuments,
  SNIPPET_CHARS,
  TOP_K_DOCS,
} = await import('./retrieve.ts');

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

/**
 * The document context the AI patient summary is written from.
 *
 * Not a similarity search: a summary asks no question, so the selection is
 * recency, exactly as the platform this was ported from did it. Which makes the
 * `WHERE` clause the only thing standing between a summary and another clinic's
 * documents — and a leak here is worse than one through the search endpoint,
 * because it would arrive as another patient's findings narrated into this
 * patient's chart and stored as a `Composition`.
 */
describe('recentDocumentExcerpts', () => {
  /**
   * One chunk-0 row as the driver returns it.
   * @param overrides - Fields to change.
   * @returns A row.
   */
  function recentRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      document_id: 'doc-1',
      title: 'Nephrology consult',
      document_date: new Date('2026-07-02T00:00:00Z'),
      content: '[DOCUMENT METADATA]\nTITLE: Nephrology consult\n[END METADATA]\n\nImpression: eGFR 38.',
      ...overrides,
    };
  }

  test('filters on the organization AND the patient, both as bind parameters', () => {
    ragQuery.mockResolvedValue([]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }).then(() => {
      const sql = lastSql();
      expect(sql).toContain('WHERE c.organization_id = $1');
      expect(sql).toContain('AND c.patient_id = $2');
      expect(lastParams()[0]).toBe('clinic-1');
      expect(lastParams()[1]).toBe('pat-1');
    });
  });

  test('selects one row per document via chunk_index = 0', () => {
    // `UNIQUE (document_id, chunk_index)` makes this exact rather than merely
    // likely: there is at most one chunk 0 per document, so the predicate turns
    // a chunk table into a document table with no DISTINCT and no join.
    ragQuery.mockResolvedValue([]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }).then(() => {
      expect(lastSql()).toContain('AND c.chunk_index = 0');
    });
  });

  test('orders by document date, newest first, with undated documents last', () => {
    // A DESC sort puts NULLs first by default in Postgres, which would head a
    // recency-selected list with the least datable documents in the record.
    ragQuery.mockResolvedValue([]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }).then(() => {
      expect(lastSql()).toContain('ORDER BY c.document_date DESC NULLS LAST, c.indexed_at DESC');
    });
  });

  test('bounds the transfer in the query rather than after it', async () => {
    ragQuery.mockResolvedValue([]);
    await recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }, { excerptChars: 600 });
    expect(lastSql()).toContain('left(c.content, $4) AS content');
    // The excerpt budget plus the header allowance, because the header is
    // stripped below rather than counted against the excerpt.
    expect(lastParams()[3]).toBe(1000);
  });

  test('strips ingest’s metadata header, which the prompt label already states', () => {
    ragQuery.mockResolvedValue([recentRow()]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }).then((excerpts) => {
      expect(excerpts[0].excerpt).toBe('Impression: eGFR 38.');
    });
  });

  test('leaves content alone when a document had no header to strip', () => {
    ragQuery.mockResolvedValue([recentRow({ content: 'Impression: eGFR 38.' })]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }).then((excerpts) => {
      expect(excerpts[0].excerpt).toBe('Impression: eGFR 38.');
    });
  });

  test('truncates the excerpt to the requested budget of document text', () => {
    const body = 'y'.repeat(900);
    ragQuery.mockResolvedValue([recentRow({ content: `[DOCUMENT METADATA]\nTITLE: T\n[END METADATA]\n\n${body}` })]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }, { excerptChars: 600 }).then(
      (excerpts) => {
        expect(excerpts[0].excerpt).toHaveLength(600);
      }
    );
  });

  test('returns the document id and a normalised date for the citation', () => {
    ragQuery.mockResolvedValue([recentRow()]);
    return recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }).then((excerpts) => {
      expect(excerpts[0]).toMatchObject({
        documentId: 'doc-1',
        title: 'Nephrology consult',
        documentDate: '2026-07-02',
      });
    });
  });

  test('a patient with nothing indexed yields an empty list, not an error', async () => {
    ragQuery.mockResolvedValue([]);
    await expect(recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' })).resolves.toEqual([]);
  });

  test('clamps a caller’s limit so one call cannot read the whole record', async () => {
    ragQuery.mockResolvedValue([]);
    await recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }, { limit: 10_000 });
    expect(lastParams()[2]).toBe(25);
    await recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' }, { limit: 0 });
    expect(lastParams()[2]).toBe(1);
  });

  test('defaults to the production numbers when the caller asks for nothing', async () => {
    ragQuery.mockResolvedValue([]);
    await recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' });
    expect(lastParams()[2]).toBe(RECENT_DOCUMENTS);
    expect(lastParams()[3]).toBe(RECENT_DOCUMENT_EXCERPT_CHARS + 400);
  });

  test('ensures the schema, so an index that has never run reads as empty', async () => {
    // Without it the first read of a process fails with `relation does not
    // exist`, which looks like a broken deployment rather than an empty index.
    ragQuery.mockResolvedValue([]);
    await recentDocumentExcerpts({ organizationId: 'clinic-1', patientId: 'pat-1' });
    expect(ensureRagSchema).toHaveBeenCalled();
  });
});
