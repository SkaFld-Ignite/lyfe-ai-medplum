// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  collectCategories,
  countBySource,
  DEFAULT_DOCUMENT_FILTERS,
  filterDocuments,
  formatDocumentList,
  toDocumentRow,
} from './patient-documents';

let nextId = 0;
function doc(overrides: Partial<DocumentReference> = {}): WithId<DocumentReference> {
  nextId++;
  return {
    resourceType: 'DocumentReference',
    id: `doc-${nextId}`,
    status: 'current',
    content: [{ attachment: { url: 'Binary/x' } }],
    ...overrides,
  };
}

const tagged = (code: string): DocumentReference['meta'] => ({ tag: [{ system: 'https://lyfe.com/source', code }] });

describe('toDocumentRow', () => {
  test('derives title, type, categories, source, dates and file kind', () => {
    const row = toDocumentRow(
      doc({
        description: '08172026 LABCORP RESULTS .pdf',
        type: { coding: [{ display: 'Laboratory report' }] },
        category: [{ text: 'Labs, Results ,Labs' }, { coding: [{ code: 'LAB', display: 'Laboratory' }] }],
        meta: { ...tagged('drchrono'), lastUpdated: '2026-09-30T10:00:00Z' },
        date: '2026-08-18T09:00:00Z',
      })
    );
    expect(row.title).toBe('08172026 LABCORP RESULTS .pdf');
    expect(row.typeLabel).toBe('Laboratory report');
    expect(row.categories).toEqual(['Labs', 'Results', 'Laboratory']);
    expect(row.source).toBe('drchrono');
    expect(row.date?.toISOString()).toBe('2026-08-18T09:00:00.000Z');
    expect(row.updated?.toISOString()).toBe('2026-09-30T10:00:00.000Z');
    // Typed from the description's extension, since the attachment has no content type.
    expect(row.fileKind).toBe('pdf');
  });

  test('falls back to the attachment title, then a placeholder', () => {
    expect(toDocumentRow(doc({ content: [{ attachment: { title: 'scan.png' } }] })).title).toBe('scan.png');
    expect(toDocumentRow(doc({ content: [{ attachment: {} }] })).title).toBe('Untitled document');
  });

  test('classifies file kinds and tolerates bad dates', () => {
    const image = toDocumentRow(doc({ content: [{ attachment: { contentType: 'image/jpeg' } }], date: 'nope' }));
    expect(image.fileKind).toBe('image');
    expect(image.date).toBeUndefined();
    expect(toDocumentRow(doc({ content: [{ attachment: { contentType: 'text/plain' } }] })).fileKind).toBe('text');
    expect(toDocumentRow(doc({ content: [{ attachment: { contentType: 'application/zip' } }] })).fileKind).toBe(
      'other'
    );
  });
});

describe('filterDocuments', () => {
  const rows = [
    toDocumentRow(
      doc({ description: 'Beta note', meta: tagged('drchrono'), date: '2026-01-02', category: [{ text: 'Notes' }] })
    ),
    toDocumentRow(
      doc({ description: 'Alpha labs', meta: tagged('drchrono'), date: '2026-03-01', type: { text: 'Lab' } })
    ),
    toDocumentRow(doc({ description: 'Zus summary', meta: tagged('zus'), date: '2025-12-01' })),
    toDocumentRow(doc({ description: 'Uploaded scan' })),
  ];
  const titles = (filters = {}): string[] =>
    filterDocuments(rows, { ...DEFAULT_DOCUMENT_FILTERS, ...filters }).map((r) => r.title);

  test('sorts newest first by default, undated last', () => {
    expect(titles()).toEqual(['Alpha labs', 'Beta note', 'Zus summary', 'Uploaded scan']);
  });

  test('sorts by date ascending and by name', () => {
    expect(titles({ sort: 'date-asc' })).toEqual(['Uploaded scan', 'Zus summary', 'Beta note', 'Alpha labs']);
    expect(titles({ sort: 'name-asc' })).toEqual(['Alpha labs', 'Beta note', 'Uploaded scan', 'Zus summary']);
    expect(titles({ sort: 'name-desc' })).toEqual(['Zus summary', 'Uploaded scan', 'Beta note', 'Alpha labs']);
  });

  test('filters by search text across title, type and categories', () => {
    expect(titles({ query: 'LAB' })).toEqual(['Alpha labs']);
    expect(titles({ query: 'notes' })).toEqual(['Beta note']);
  });

  test('filters by source and category', () => {
    // Two sources, not three: the network-sourced summary and the document
    // uploaded here are both Lyfe.
    expect(titles({ source: 'lyfe' })).toEqual(['Zus summary', 'Uploaded scan']);
    expect(titles({ source: 'drchrono' })).toEqual(['Alpha labs', 'Beta note']);
    expect(titles({ categories: ['Notes'] })).toEqual(['Beta note']);
  });

  test('counts sources and categories, and formats a copyable list', () => {
    expect(countBySource(rows)).toEqual({ drchrono: 2, lyfe: 2 });
    expect(collectCategories(rows)).toEqual([{ label: 'Notes', count: 1 }]);
    expect(formatDocumentList(rows.slice(1, 2), 'US/Pacific')).toBe('2026-03-01 — Alpha labs — Lab');
  });
});
