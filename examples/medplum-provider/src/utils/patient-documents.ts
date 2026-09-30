// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import { getDisplayString, getReferenceString } from '@medplum/core';
import type { Attachment, DocumentReference } from '@medplum/fhirtypes';
import { getDocumentTypeDisplay } from '../pages/patient/DocumentReference.utils';
import { getAttachmentContentType } from './document-file-type';
import type { DataSource } from './patient-timeline';
import { getDataSource, toDayKey } from './patient-timeline';

/** What kind of file a document holds, for its icon. */
export type DocumentFileKind = 'pdf' | 'image' | 'text' | 'other';

/** One row of the documents list, derived from a DocumentReference. */
export interface DocumentRow {
  id: string;
  document: WithId<DocumentReference>;
  title: string;
  /** The document type, e.g. "Laboratory report". */
  typeLabel?: string;
  /** Category labels, e.g. DrChrono metatags. */
  categories: string[];
  source: DataSource;
  /** When the document was written (DocumentReference.date). */
  date?: Date;
  /** When the resource was last written to Medplum, e.g. by an import. */
  updated?: Date;
  attachment?: Attachment;
  contentType?: string;
  fileKind: DocumentFileKind;
}

export type DocumentSort = 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc';

export const DOCUMENT_SORT_OPTIONS: { value: DocumentSort; label: string }[] = [
  { value: 'date-desc', label: 'Date (new to old)' },
  { value: 'date-asc', label: 'Date (old to new)' },
  { value: 'name-asc', label: 'Name (A–Z)' },
  { value: 'name-desc', label: 'Name (Z–A)' },
];

export interface DocumentFilters {
  query: string;
  /** Empty means every source. */
  source?: DataSource;
  /** Documents with any of these categories; empty means no category filter. */
  categories: string[];
  sort: DocumentSort;
}

export const DEFAULT_DOCUMENT_FILTERS: DocumentFilters = { query: '', categories: [], sort: 'date-desc' };

function toDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function getFileKind(contentType: string | undefined): DocumentFileKind {
  if (!contentType) {
    return 'other';
  }
  if (contentType === 'application/pdf') {
    return 'pdf';
  }
  if (contentType.startsWith('image/')) {
    return 'image';
  }
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType.endsWith('xml')) {
    return 'text';
  }
  return 'other';
}

function getCategories(doc: DocumentReference): string[] {
  const labels = (doc.category ?? []).flatMap((c) => {
    if (c.coding?.length) {
      return c.coding.map((coding) => coding.display ?? coding.code).filter(Boolean) as string[];
    }
    // DrChrono metatags arrive as one comma-separated text.
    return (c.text ?? '').split(',');
  });
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
}

/**
 * Builds the list row for a document.
 * @param document - The DocumentReference.
 * @returns The row.
 */
export function toDocumentRow(document: WithId<DocumentReference>): DocumentRow {
  const attachment = document.content?.[0]?.attachment;
  const name = getDisplayString(document);
  const contentType = getAttachmentContentType(document, attachment);
  return {
    id: document.id,
    document,
    title: name === getReferenceString(document) ? attachment?.title || 'Untitled document' : name,
    typeLabel: getDocumentTypeDisplay(document),
    categories: getCategories(document),
    source: getDataSource(document),
    date: toDate(document.date),
    updated: toDate(document.meta?.lastUpdated),
    attachment,
    contentType,
    fileKind: getFileKind(contentType),
  };
}

function sortKey(row: DocumentRow): number {
  return (row.date ?? row.updated)?.getTime() ?? 0;
}

/**
 * Applies the search, source, category filters and sort order.
 * @param rows - Every document row.
 * @param filters - The active filters.
 * @returns The matching rows, sorted.
 */
export function filterDocuments(rows: DocumentRow[], filters: DocumentFilters): DocumentRow[] {
  const query = filters.query.trim().toLowerCase();
  const categories = new Set(filters.categories);
  const result = rows.filter((row) => {
    if (filters.source && row.source !== filters.source) {
      return false;
    }
    if (categories.size > 0 && !row.categories.some((c) => categories.has(c))) {
      return false;
    }
    if (query) {
      const haystack = [row.title, row.typeLabel, row.document.description, ...row.categories]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }
    return true;
  });

  const byName = (a: DocumentRow, b: DocumentRow): number => a.title.localeCompare(b.title);
  switch (filters.sort) {
    case 'date-asc':
      return result.sort((a, b) => sortKey(a) - sortKey(b) || byName(a, b));
    case 'name-asc':
      return result.sort(byName);
    case 'name-desc':
      return result.sort((a, b) => byName(b, a));
    default:
      return result.sort((a, b) => sortKey(b) - sortKey(a) || byName(a, b));
  }
}

/**
 * Counts rows per source.
 * @param rows - The rows.
 * @returns Count per source.
 */
export function countBySource(rows: DocumentRow[]): Record<DataSource, number> {
  const counts: Record<DataSource, number> = { drchrono: 0, zus: 0, other: 0 };
  for (const row of rows) {
    counts[row.source]++;
  }
  return counts;
}

/**
 * Every category used by the rows, most common first.
 * @param rows - The rows.
 * @returns Category labels with how many documents carry each.
 */
export function collectCategories(rows: DocumentRow[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const category of row.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Plain-text list of documents, for copying into a note or message.
 * @param rows - The rows to list.
 * @returns One line per document.
 */
export function formatDocumentList(rows: DocumentRow[]): string {
  return rows
    .map((row) => {
      const date = row.date ?? row.updated;
      return [date && toDayKey(date), row.title, row.typeLabel].filter(Boolean).join(' — ');
    })
    .join('\n');
}
