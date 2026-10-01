// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Observation, Task } from '@medplum/fhirtypes';
import type { LabResult } from './labs';
import { toLabResult } from './labs';

export interface SpecialtyDefinition {
  key: 'gastroenterology' | 'oncology' | 'psychiatry';
  label: string;
  hint: string;
  /** Words matched against condition names; a patient with any match counts once. */
  terms: string[];
}

/** The specialty cards, with the condition terms the old Lyfe dashboard classified by. */
export const DASHBOARD_SPECIALTIES: SpecialtyDefinition[] = [
  {
    key: 'gastroenterology',
    label: 'Gastroenterology',
    hint: 'GI patients',
    terms: ['gastro', 'intestinal', 'bowel', 'stomach', 'liver', 'pancreatic', 'colon', 'crohn', 'ulcerative'],
  },
  {
    key: 'oncology',
    label: 'Oncology',
    hint: 'Cancer patients',
    terms: ['cancer', 'tumor', 'neoplasm', 'malignant', 'carcinoma', 'lymphoma', 'leukemia', 'melanoma', 'sarcoma'],
  },
  {
    key: 'psychiatry',
    label: 'Psychiatry',
    hint: 'Mental health patients',
    terms: ['depression', 'anxiety', 'bipolar', 'schizophrenia', 'ptsd', 'mental', 'psychiatric', 'mood'],
  },
];

/** Every patient, counted by the server. */
export const PATIENT_COUNT_QUERY = { _summary: 'count' };

/**
 * A server-side count of patients with a condition matching any of the terms. `_has` makes the
 * server count each patient once, so nothing is downloaded but the total.
 * @param terms - Condition name terms.
 * @returns The search parameters for `Patient`.
 */
export function patientsWithConditionQuery(terms: string[]): Record<string, string> {
  return { '_has:Condition:patient:code:text': terms.join(','), _summary: 'count' };
}

/**
 * A whole-number percentage, 0 when there is no total.
 * @param part - The part.
 * @param total - The whole.
 * @returns The percentage.
 */
export function percentOf(part: number | undefined, total: number | undefined): number {
  if (!part || !total) {
    return 0;
  }
  return Math.round((part / total) * 100);
}

/**
 * The greeting for an hour of the day, as Lyfe words it.
 * @param hour - 0–23, in the clinic's time zone.
 * @returns "Good morning", "Good afternoon" or "Good evening".
 */
export function greetingFor(hour: number): string {
  if (hour < 12) {
    return 'Good morning';
  }
  return hour < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * The hour of day at the clinic.
 * @param date - The instant.
 * @param timeZone - The clinic's IANA zone.
 * @returns 0–23.
 */
export function clinicHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(date);
  return Number(hour) % 24;
}

/** Task statuses that still need someone to act. */
export const OPEN_TASK_STATUSES = ['draft', 'requested', 'received', 'accepted', 'ready', 'in-progress'];

export type TaskFilter = 'all' | 'urgent' | 'pending';

/**
 * Whether a task is marked urgent, ASAP or stat.
 * @param task - The task.
 * @returns True when urgent.
 */
export function isUrgentTask(task: Task): boolean {
  return task.priority === 'urgent' || task.priority === 'asap' || task.priority === 'stat';
}

/**
 * Whether no one has started a task yet.
 * @param task - The task.
 * @returns True when pending.
 */
export function isPendingTask(task: Task): boolean {
  return task.status !== 'in-progress' && OPEN_TASK_STATUSES.includes(task.status);
}

/**
 * Tasks for one of the inbox tabs.
 * @param tasks - The open tasks.
 * @param filter - The tab.
 * @returns The tasks to show.
 */
export function filterTasks<T extends Task>(tasks: T[], filter: TaskFilter): T[] {
  if (filter === 'urgent') {
    return tasks.filter(isUrgentTask);
  }
  if (filter === 'pending') {
    return tasks.filter(isPendingTask);
  }
  return tasks;
}

export interface CriticalResult extends LabResult {
  patientReference?: string;
}

/**
 * The newest flagged (high, low or abnormal) final lab results, as the old Lyfe dashboard listed
 * them.
 * @param observations - Final lab Observations, newest first.
 * @param limit - How many to keep.
 * @returns The flagged results.
 */
export function pickCriticalResults(observations: Observation[], limit: number): CriticalResult[] {
  return observations
    .map((obs) => ({ ...toLabResult(obs), patientReference: obs.subject?.reference }))
    .filter((result) => result.flag)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
    .slice(0, limit);
}
