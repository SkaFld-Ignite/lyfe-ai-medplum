// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Appointment, Bundle, Location, Patient, Practitioner } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { OverviewAppointment } from './scheduling-overview';
import {
  addDays,
  buildOverviewAppointments,
  countPatients,
  filterOverviewAppointments,
  fromLocalIsoDate,
  getAppointmentsForDay,
  getColorForKey,
  getInitials,
  getLocationOptions,
  getProviderOptions,
  getStatusDisplay,
  groupByProvider,
  isInactiveStatus,
  PROVIDER_COLORS,
  searchAppointments,
  startOfDay,
  toLocalIsoDate,
  UNASSIGNED_PROVIDER_KEY,
} from './scheduling-overview';

const patient: Patient = {
  resourceType: 'Patient',
  id: 'p1',
  name: [{ given: ['Homer'], family: 'Simpson' }],
  identifier: [
    { system: 'https://example.com/other', value: 'OTHER-1' },
    { type: { coding: [{ code: 'MR' }] }, system: 'https://example.com/mrn', value: 'MRN-001' },
  ],
  telecom: [
    { system: 'phone', value: '555-0100' },
    { system: 'email', value: 'homer@example.com' },
  ],
  generalPractitioner: [{ reference: 'Practitioner/dr1', display: 'Dr. Alice Smith' }],
};

const practitioner: Practitioner = {
  resourceType: 'Practitioner',
  id: 'dr1',
  name: [{ prefix: ['Dr.'], given: ['Alice'], family: 'Smith' }],
};

const location: Location = { resourceType: 'Location', id: 'loc1', name: 'Main Clinic' };

function appointment(overrides: Partial<Appointment> & { id: string }): Appointment {
  return {
    resourceType: 'Appointment',
    status: 'booked',
    start: '2026-09-29T09:00:00.000Z',
    end: '2026-09-29T09:30:00.000Z',
    participant: [
      { actor: { reference: 'Patient/p1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/dr1' }, status: 'accepted' },
      { actor: { reference: 'Location/loc1' }, status: 'accepted' },
    ],
    ...overrides,
  };
}

function bundleOf(appointments: Appointment[], includes = [patient, practitioner, location]): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: [
      ...appointments.map((resource) => ({ resource, search: { mode: 'match' as const } })),
      ...includes.map((resource) => ({ resource, search: { mode: 'include' as const } })),
    ],
  };
}

function row(overrides: Partial<OverviewAppointment> & { id: string }): OverviewAppointment {
  const { id, ...rest } = overrides;
  return {
    appointment: { resourceType: 'Appointment', id, status: 'booked', participant: [] },
    start: new Date(2026, 8, 29, 9, 0),
    end: new Date(2026, 8, 29, 9, 30),
    durationMinutes: 30,
    providerKey: 'Practitioner/dr1',
    providerName: 'Alice Smith',
    typeLabel: 'Appointment',
    isVirtual: false,
    ...rest,
  };
}

describe('buildOverviewAppointments', () => {
  test('resolves included patient, practitioner and location', () => {
    const [result] = buildOverviewAppointments(
      bundleOf([
        appointment({
          id: 'a1',
          appointmentType: { text: 'Follow-up' },
          reasonCode: [{ text: 'Knee pain' }],
          comment: 'Bring imaging',
        }),
      ])
    );

    expect(result.appointment.id).toBe('a1');
    expect(result.durationMinutes).toBe(30);
    expect(result.patient).toEqual({
      reference: 'Patient/p1',
      id: 'p1',
      name: 'Homer Simpson',
      mrn: 'MRN-001',
      email: 'homer@example.com',
      phone: '555-0100',
      primaryProvider: 'Dr. Alice Smith',
    });
    expect(result.providerKey).toBe('Practitioner/dr1');
    expect(result.providerName).toBe('Dr. Alice Smith');
    expect(result.locationKey).toBe('Location/loc1');
    expect(result.locationName).toBe('Main Clinic');
    expect(result.typeLabel).toBe('Follow-up');
    expect(result.reason).toBe('Knee pain');
    expect(result.notes).toBe('Bring imaging');
    expect(result.isVirtual).toBe(false);
  });

  test('falls back to participant display names when resources are not included', () => {
    const [result] = buildOverviewAppointments(
      bundleOf(
        [
          appointment({
            id: 'a1',
            participant: [
              { actor: { reference: 'Patient/p2', display: 'Marge Simpson' }, status: 'accepted' },
              { actor: { reference: 'Practitioner/dr2', display: 'Dr. Nick' }, status: 'accepted' },
              { actor: { reference: 'Location/loc2', display: 'Annex' }, status: 'accepted' },
            ],
          }),
        ],
        []
      )
    );

    expect(result.patient).toEqual({ reference: 'Patient/p2', id: 'p2', name: 'Marge Simpson' });
    expect(result.providerName).toBe('Dr. Nick');
    expect(result.locationName).toBe('Annex');
  });

  test('marks appointments without a practitioner as unassigned', () => {
    const [result] = buildOverviewAppointments(
      bundleOf([appointment({ id: 'a1', participant: [{ actor: { reference: 'Patient/p1' }, status: 'accepted' }] })])
    );
    expect(result.providerKey).toBe(UNASSIGNED_PROVIDER_KEY);
    expect(result.providerName).toBe('Unassigned provider');
    expect(result.locationKey).toBeUndefined();
  });

  test('groups display-only providers (e.g. DrChrono imports) by name', () => {
    const [result] = buildOverviewAppointments(
      bundleOf([
        appointment({
          id: 'a1',
          participant: [
            { actor: { reference: 'Patient/p1' }, status: 'accepted' },
            { actor: { display: 'DrChrono Practice' }, status: 'accepted' },
          ],
        }),
      ])
    );
    expect(result.providerKey).toBe('display:DrChrono Practice');
    expect(result.providerName).toBe('DrChrono Practice');
  });

  test('derives the end from minutesDuration when end is missing', () => {
    const [result] = buildOverviewAppointments(
      bundleOf([appointment({ id: 'a1', end: undefined, minutesDuration: 15 })])
    );
    expect(result.durationMinutes).toBe(15);
    expect(result.end.toISOString()).toBe('2026-09-29T09:15:00.000Z');
  });

  test('detects virtual visits from the appointment or service type', () => {
    const rows = buildOverviewAppointments(
      bundleOf([
        appointment({ id: 'a1', appointmentType: { text: 'Telehealth visit' } }),
        appointment({ id: 'a2', serviceType: [{ coding: [{ code: 'VR', display: 'Virtual' }] }] }),
        appointment({ id: 'a3', appointmentType: { text: 'Office visit' } }),
      ])
    );
    expect(rows.map((r) => r.isVirtual)).toEqual([true, true, false]);
  });

  test('uses the description when there is no reason code', () => {
    const [result] = buildOverviewAppointments(bundleOf([appointment({ id: 'a1', description: 'Annual physical' })]));
    expect(result.reason).toBe('Annual physical');
    expect(result.typeLabel).toBe('Appointment');
  });

  test('skips appointments that cannot be placed on the calendar', () => {
    const rows = buildOverviewAppointments(
      bundleOf([
        appointment({ id: 'no-start', start: undefined }),
        appointment({ id: 'no-end', end: undefined }),
        appointment({ id: 'bad-date', start: 'not-a-date' }),
        appointment({ id: 'ok' }),
      ])
    );
    expect(rows.map((r) => r.appointment.id)).toEqual(['ok']);
  });

  test('ignores included Appointments and sorts by start time', () => {
    const included: Appointment = appointment({ id: 'included-only' });
    const rows = buildOverviewAppointments({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        { resource: appointment({ id: 'late', start: '2026-09-29T15:00:00Z', end: '2026-09-29T15:30:00Z' }) },
        { resource: appointment({ id: 'early', start: '2026-09-29T08:00:00Z', end: '2026-09-29T08:30:00Z' }) },
        { resource: included, search: { mode: 'include' } },
      ],
    });
    expect(rows.map((r) => r.appointment.id)).toEqual(['early', 'late']);
  });

  test('handles an empty bundle', () => {
    expect(buildOverviewAppointments({ resourceType: 'Bundle', type: 'searchset' })).toEqual([]);
  });
});

describe('status display', () => {
  test('maps FHIR statuses to labels and colors', () => {
    expect(getStatusDisplay('booked')).toEqual({ label: 'Scheduled', color: 'blue' });
    expect(getStatusDisplay('fulfilled')).toEqual({ label: 'Completed', color: 'gray' });
    expect(getStatusDisplay('cancelled')).toEqual({ label: 'Cancelled', color: 'red' });
    expect(getStatusDisplay('noshow')).toEqual({ label: 'No show', color: 'orange' });
  });

  test('falls back to the raw status for unknown values', () => {
    expect(getStatusDisplay('mystery' as Appointment['status'])).toEqual({ label: 'mystery', color: 'gray' });
  });

  test('treats only cancelled and entered-in-error as inactive', () => {
    expect(isInactiveStatus('cancelled')).toBe(true);
    expect(isInactiveStatus('entered-in-error')).toBe(true);
    expect(isInactiveStatus('noshow')).toBe(false);
    expect(isInactiveStatus('booked')).toBe(false);
  });
});

describe('colors and initials', () => {
  test('gives each key a stable palette color', () => {
    const color = getColorForKey('Practitioner/dr1');
    expect(PROVIDER_COLORS).toContain(color);
    expect(getColorForKey('Practitioner/dr1')).toBe(color);
  });

  test('uses gray for unassigned', () => {
    expect(getColorForKey(UNASSIGNED_PROVIDER_KEY)).toBe('gray');
  });

  test('builds up to two initials', () => {
    expect(getInitials('Homer Jay Simpson')).toBe('HJ');
    expect(getInitials('  marge  ')).toBe('M');
    expect(getInitials('')).toBe('');
  });
});

describe('local dates', () => {
  test('round-trips local ISO dates', () => {
    const date = new Date(2026, 0, 5, 23, 59);
    expect(toLocalIsoDate(date)).toBe('2026-01-05');
    expect(fromLocalIsoDate('2026-01-05')).toEqual(new Date(2026, 0, 5));
  });

  test('rejects malformed or impossible dates', () => {
    expect(fromLocalIsoDate(undefined)).toBeUndefined();
    expect(fromLocalIsoDate('2026-1-5')).toBeUndefined();
    expect(fromLocalIsoDate('2026-02-30')).toBeUndefined();
  });

  test('adds days and finds the start of day', () => {
    expect(addDays(new Date(2026, 11, 31), 1)).toEqual(new Date(2027, 0, 1));
    expect(startOfDay(new Date(2026, 5, 1, 14, 30))).toEqual(new Date(2026, 5, 1));
  });
});

describe('filtering and grouping', () => {
  const rows = [
    row({
      id: 'a1',
      locationKey: 'Location/loc1',
      locationName: 'Main Clinic',
      patient: { reference: 'Patient/p1', id: 'p1', name: 'Homer Simpson', mrn: 'MRN-001' },
      reason: 'Knee pain',
    }),
    row({
      id: 'a2',
      providerKey: 'Practitioner/dr2',
      providerName: 'Bob Jones',
      locationKey: 'Location/loc2',
      locationName: 'Annex',
      patient: { reference: 'Patient/p2', id: 'p2', name: 'Marge Simpson' },
      start: new Date(2026, 8, 30, 10, 0),
    }),
    row({
      id: 'a3',
      providerKey: UNASSIGNED_PROVIDER_KEY,
      providerName: 'Unassigned provider',
      appointment: { resourceType: 'Appointment', id: 'a3', status: 'cancelled', participant: [] },
      patient: { reference: 'Patient/p1', id: 'p1', name: 'Homer Simpson' },
    }),
  ];

  test('lists provider options with unassigned last', () => {
    expect(getProviderOptions(rows)).toEqual([
      { key: 'Practitioner/dr1', label: 'Alice Smith' },
      { key: 'Practitioner/dr2', label: 'Bob Jones' },
      { key: UNASSIGNED_PROVIDER_KEY, label: 'Unassigned provider' },
    ]);
  });

  test('lists location options sorted by name', () => {
    expect(getLocationOptions(rows)).toEqual([
      { key: 'Location/loc2', label: 'Annex' },
      { key: 'Location/loc1', label: 'Main Clinic' },
    ]);
  });

  test('hides cancelled appointments unless asked', () => {
    const noFilters = { providers: [], locations: [], showCancelled: false };
    expect(filterOverviewAppointments(rows, noFilters).map((r) => r.appointment.id)).toEqual(['a1', 'a2']);
    expect(
      filterOverviewAppointments(rows, { ...noFilters, showCancelled: true }).map((r) => r.appointment.id)
    ).toEqual(['a1', 'a2', 'a3']);
  });

  test('filters by provider and location', () => {
    expect(
      filterOverviewAppointments(rows, { providers: ['Practitioner/dr2'], locations: [], showCancelled: true }).map(
        (r) => r.appointment.id
      )
    ).toEqual(['a2']);
    // Appointments with no location never match a location filter.
    expect(
      filterOverviewAppointments(rows, { providers: [], locations: ['Location/loc1'], showCancelled: true }).map(
        (r) => r.appointment.id
      )
    ).toEqual(['a1']);
  });

  test('picks out a single local day', () => {
    expect(getAppointmentsForDay(rows, new Date(2026, 8, 30)).map((r) => r.appointment.id)).toEqual(['a2']);
  });

  test('searches name, MRN, reason and type case-insensitively', () => {
    expect(searchAppointments(rows, 'marge').map((r) => r.appointment.id)).toEqual(['a2']);
    expect(searchAppointments(rows, 'mrn-001').map((r) => r.appointment.id)).toEqual(['a1']);
    expect(searchAppointments(rows, 'KNEE').map((r) => r.appointment.id)).toEqual(['a1']);
    expect(searchAppointments(rows, '   ')).toBe(rows);
  });

  test('groups by provider with unassigned last', () => {
    const groups = groupByProvider(rows);
    expect(groups.map((g) => g.providerName)).toEqual(['Alice Smith', 'Bob Jones', 'Unassigned provider']);
    expect(groups[2].color).toBe('gray');
  });

  test('counts distinct patients', () => {
    expect(countPatients(rows)).toBe(2);
    expect(countPatients([row({ id: 'no-patient' })])).toBe(0);
  });
});
