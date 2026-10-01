// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Observation, Task } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  clinicHour,
  filterTasks,
  greetingFor,
  isPendingTask,
  isUrgentTask,
  patientsWithConditionQuery,
  percentOf,
  pickCriticalResults,
} from './dashboard';

function task(status: Task['status'], priority?: Task['priority']): Task {
  return { resourceType: 'Task', status, intent: 'order', priority };
}

function lab(id: string, value: number, date: string, code?: string): Observation {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: `Test ${id}` },
    subject: { reference: 'Patient/p1' },
    valueQuantity: { value },
    effectiveDateTime: date,
    interpretation: code ? [{ coding: [{ code }] }] : undefined,
  };
}

describe('dashboard helpers', () => {
  test('counts patients by condition terms on the server', () => {
    expect(patientsWithConditionQuery(['liver', 'colon'])).toEqual({
      '_has:Condition:patient:code:text': 'liver,colon',
      _summary: 'count',
    });
  });

  test('works out a percentage and guards an empty total', () => {
    expect(percentOf(859, 5949)).toBe(14);
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(undefined, 10)).toBe(0);
  });

  test('greets by the hour at the clinic', () => {
    expect(greetingFor(8)).toBe('Good morning');
    expect(greetingFor(13)).toBe('Good afternoon');
    expect(greetingFor(19)).toBe('Good evening');
    // 03:00 UTC is 20:00 the evening before in Los Angeles.
    expect(clinicHour(new Date('2026-10-02T03:00:00Z'), 'America/Los_Angeles')).toBe(20);
  });

  test('sorts tasks into the inbox tabs', () => {
    const tasks = [task('requested', 'stat'), task('in-progress', 'routine'), task('ready')];
    expect(isUrgentTask(tasks[0])).toBe(true);
    expect(isPendingTask(tasks[1])).toBe(false);
    expect(filterTasks(tasks, 'urgent')).toEqual([tasks[0]]);
    expect(filterTasks(tasks, 'pending')).toEqual([tasks[0], tasks[2]]);
    expect(filterTasks(tasks, 'all')).toHaveLength(3);
  });

  test('lists the newest flagged lab results', () => {
    const results = pickCriticalResults(
      [lab('a', 5, '2026-09-01', 'H'), lab('b', 5, '2026-09-20'), lab('c', 1, '2026-09-10', 'LL')],
      5
    );
    expect(results.map((r) => r.id)).toEqual(['c', 'a']);
    expect(results[0]).toMatchObject({ flag: 'L', patientReference: 'Patient/p1' });
  });
});
