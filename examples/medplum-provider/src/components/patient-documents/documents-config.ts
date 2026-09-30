// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColor } from '@mantine/core';
import type { DataSource } from '../../utils/patient-timeline';

/** Rows per page of the documents list. */
export const DOCUMENTS_PER_PAGE = 25;

/** Category chips shown on a row before "+N more". */
export const VISIBLE_CATEGORY_COUNT = 4;

/** Filter chip order, and the label and color for each source. */
export const DOCUMENT_SOURCES: { source: DataSource; label: string; badge: string; color: MantineColor }[] = [
  { source: 'zus', label: 'Zus/HIE', badge: 'From Zus/HIE', color: 'blue' },
  { source: 'other', label: 'Lyfe', badge: 'Added in Lyfe', color: 'violet' },
  { source: 'drchrono', label: 'DrChrono', badge: 'From DrChrono', color: 'green' },
];

/**
 * Formats a date like "Sep 27, 2026" in the viewer's locale.
 * @param date - The date.
 * @returns The formatted date.
 */
export function formatDocumentDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
