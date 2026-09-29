// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColor } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconClipboardText,
  IconCut,
  IconFileText,
  IconFlask,
  IconHeartbeat,
  IconPill,
  IconStethoscope,
  IconVaccine,
} from '@tabler/icons-react';
import type { DataSource, RecordKind, TimelineEventKind, TimelineRecord } from '../../utils/patient-timeline';

export interface KindConfig {
  label: string;
  plural: string;
  color: MantineColor;
  icon: Icon;
}

export const KIND_CONFIG: Record<TimelineEventKind, KindConfig> = {
  visit: { label: 'Visit', plural: 'Visits', color: 'indigo', icon: IconStethoscope },
  condition: { label: 'Condition', plural: 'Conditions', color: 'violet', icon: IconHeartbeat },
  vitals: { label: 'Vitals', plural: 'Vitals', color: 'pink', icon: IconActivityHeartbeat },
  lab: { label: 'Lab result', plural: 'Labs & diagnostics', color: 'teal', icon: IconFlask },
  medication: { label: 'Medication', plural: 'Medications', color: 'blue', icon: IconPill },
  allergy: { label: 'Allergy', plural: 'Allergies', color: 'red', icon: IconAlertTriangle },
  immunization: { label: 'Immunization', plural: 'Immunizations', color: 'green', icon: IconVaccine },
  procedure: { label: 'Procedure', plural: 'Procedures', color: 'orange', icon: IconCut },
  observation: { label: 'Observation', plural: 'Observations', color: 'cyan', icon: IconClipboardText },
  document: { label: 'Document', plural: 'Documents', color: 'gray', icon: IconFileText },
};

/** Order of kinds in the type filter. */
export const KIND_ORDER: TimelineEventKind[] = [
  'visit',
  'condition',
  'vitals',
  'lab',
  'medication',
  'allergy',
  'immunization',
  'procedure',
  'observation',
  'document',
];

export const SOURCE_CONFIG: Record<DataSource, { label: string; color: MantineColor }> = {
  drchrono: { label: 'From EHR', color: 'green' },
  zus: { label: 'From Zus', color: 'cyan' },
  other: { label: 'Lyfe', color: 'gray' },
};

/** Filter-menu labels for sources. */
export const SOURCE_FILTER_LABELS: Record<DataSource, string> = {
  drchrono: 'EHR (DrChrono)',
  zus: 'Lyfe Data Network (Zus)',
  other: 'Entered in Lyfe',
};

/**
 * Formats a date like "Sep 14, 2026" in the viewer's locale.
 * @param date - The date.
 * @returns The formatted date.
 */
export function formatMediumDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Formats a time like "9:15 AM" in the viewer's locale.
 * @param date - The date.
 * @returns The formatted time.
 */
export function formatShortTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Day sections rendered at first, and added by each "Show older" click. */
export const DAYS_PER_PAGE = 20;

/** Ongoing-care items shown before "Show all". */
export const ONGOING_PREVIEW_COUNT = 8;

/**
 * Summary like "2 vitals · 1 document" for a list of records.
 * @param records - The records.
 * @returns The summary text.
 */
export function summarizeRecords(records: TimelineRecord[]): string {
  const counts = new Map<RecordKind, number>();
  for (const record of records) {
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${(n === 1 ? KIND_CONFIG[kind].label : KIND_CONFIG[kind].plural).toLowerCase()}`)
    .join(' · ');
}
