// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColor } from '@mantine/core';
import type { DataSource } from '../../utils/patient-timeline';

/** Rows per page of the documents list. */
export const DOCUMENTS_PER_PAGE = 25;

/** Category chips shown on a row before "+N more". */
export const VISIBLE_CATEGORY_COUNT = 4;

/**
 * Filter chip order, and the label and color for each source.
 *
 * Two sources, matching {@link DataSource}: Lyfe (anything not from the
 * connected EHR, whether it arrived over the Lyfe Data Network or was created
 * here) and DrChrono.
 */
export const DOCUMENT_SOURCES: { source: DataSource; label: string; badge: string; color: MantineColor }[] = [
  { source: 'lyfe', label: 'Lyfe', badge: 'From Lyfe', color: 'violet' },
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
