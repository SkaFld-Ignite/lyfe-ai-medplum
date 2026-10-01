// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { formatLooseDate, toActivityRow } from './care-plan-utils';

const TZ = 'America/Los_Angeles';

describe('formatting a loose date', () => {
  test('reads a compact YYYYMMDD date, as Zus sends it', () => {
    expect(formatLooseDate('19870817', TZ)).toBe('Aug 17, 1987');
  });

  test('reads a FHIR date and keeps other text as given', () => {
    expect(formatLooseDate('2026-01-06', TZ)).toBe('Jan 6, 2026');
    expect(formatLooseDate('every morning', TZ)).toBe('every morning');
    expect(formatLooseDate(undefined, TZ)).toBeUndefined();
  });
});

describe('a care plan activity row', () => {
  test('names the activity by its code and dates it from scheduledString', () => {
    const row = toActivityRow(
      {
        detail: {
          kind: 'Task',
          code: { text: 'Hepatitis B Immunity' },
          status: 'scheduled',
          scheduledString: '19870817',
          performer: [{ display: 'Dr. Yip' }],
        },
      },
      0,
      TZ
    );
    expect(row).toMatchObject({
      title: 'Hepatitis B Immunity',
      kind: 'Task',
      status: 'scheduled',
      when: 'Aug 17, 1987',
      performer: 'Dr. Yip',
    });
  });

  test('shows a scheduled period as a range', () => {
    const row = toActivityRow(
      {
        detail: {
          status: 'in-progress',
          description: 'Diet plan',
          scheduledPeriod: { start: '2026-01-01', end: '2026-03-01' },
        },
      },
      1,
      TZ
    );
    expect(row.title).toBe('Diet plan');
    expect(row.when).toBe('Jan 1, 2026 – Mar 1, 2026');
  });

  test('falls back to the referenced activity', () => {
    expect(toActivityRow({ reference: { display: 'Referral to cardiology' } }, 2, TZ).title).toBe(
      'Referral to cardiology'
    );
  });
});
