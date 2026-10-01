// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import type {
  AllergyIntolerance,
  Appointment,
  Condition,
  DocumentReference,
  Encounter,
  MedicationStatement,
  Observation,
} from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { ConditionEvent, DayRecordsEvent, TimelineEvent, TimelineSources, VisitEvent } from './patient-timeline';
import {
  buildPatientTimeline,
  chartPath,
  countByKind,
  EMPTY_FILTERS,
  filterTimeline,
  getDataSource,
  getRelativeDayLabel,
  getVisitStatusLabel,
  groupByCondition,
  groupByDay,
  hasActiveFilters,
  toDayKey,
  UNCATEGORIZED_GROUP,
} from './patient-timeline';

/**
 * The clinic zone these fixtures are written in.
 *
 * UTC, so the fixture timestamps below read as exactly the day and time they
 * are written as. Grouping is exercised against a real zone in
 * `clinic-time.test.ts`; what matters here is that the timeline's own logic is
 * independent of the machine running the tests.
 */
const TZ = 'UTC';

const P = { reference: 'Patient/p1' };
const tag = (code: string): { tag: { system: string; code: string }[] } => ({
  tag: [{ system: 'https://lyfe.com/source', code }],
});

function sources(overrides: Partial<TimelineSources>): TimelineSources {
  return {
    encounters: [],
    appointments: [],
    conditions: [],
    observations: [],
    diagnosticReports: [],
    documents: [],
    medicationRequests: [],
    medicationStatements: [],
    allergies: [],
    immunizations: [],
    procedures: [],
    ...overrides,
  };
}

function encounter(id: string, start: string, extra: Partial<Encounter> = {}): WithId<Encounter> {
  return {
    resourceType: 'Encounter',
    id,
    status: 'finished',
    class: { code: 'AMB' },
    subject: P,
    period: { start },
    ...extra,
  };
}

function vital(id: string, date: string, extra: Partial<Observation> = {}): WithId<Observation> {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    category: [{ coding: [{ code: 'vital-signs' }] }],
    code: { text: 'Heart rate' },
    subject: P,
    effectiveDateTime: date,
    valueQuantity: { value: 72, unit: '/min' },
    ...extra,
  };
}

function condition(id: string, text: string, extra: Partial<Condition> = {}): WithId<Condition> {
  return { resourceType: 'Condition', id, subject: P, code: { text }, ...extra };
}

describe('buildPatientTimeline', () => {
  test('merges duplicate copies of a visit and keeps the most informative one', () => {
    const { events } = buildPatientTimeline(
      sources({
        encounters: [
          encounter('zus-copy', '2026-09-14T09:30:00Z', { meta: tag('zus'), type: [{ text: 'ambulatory' }] }),
          encounter('ehr', '2026-09-14T09:30:00Z', {
            meta: tag('drchrono'),
            type: [{ text: 'Office Visit, Est Pt.' }],
            appointment: [{ reference: 'Appointment/a1' }],
            participant: [{ individual: { display: 'Dr. Chen' } }],
          }),
        ],
        appointments: [
          {
            resourceType: 'Appointment',
            id: 'a1',
            meta: tag('drchrono'),
            status: 'cancelled',
            start: '2026-09-14T09:30:00Z',
            participant: [],
            description: 'Fatty liver follow-up',
          },
        ],
      }),
      TZ
    );

    expect(events).toHaveLength(1);
    const visit = events[0] as VisitEvent;
    expect(visit.type).toBe('visit');
    expect(visit.encounter?.id).toBe('ehr');
    expect(visit.appointment?.id).toBe('a1');
    expect(visit.encounterIds.sort()).toEqual(['ehr', 'zus-copy']);
    expect(visit.title).toBe('Office Visit, Est Pt.');
    expect(visit.provider).toBe('Dr. Chen');
    // The appointment status wins over the encounter status.
    expect(visit.status).toBe('cancelled');
    expect(visit.reason).toBe('Fatty liver follow-up');
    expect(visit.sources.sort()).toEqual(['drchrono', 'lyfe']);
  });

  test('shows appointments without an encounter as their own visits', () => {
    const appointment: WithId<Appointment> = {
      resourceType: 'Appointment',
      id: 'a2',
      status: 'booked',
      start: '2026-10-01T10:00:00Z',
      appointmentType: { text: 'Colonoscopy consult' },
      participant: [
        { actor: { reference: 'Patient/p1' }, status: 'accepted' },
        { actor: { reference: 'Practitioner/x', display: 'Dr. Patel' }, status: 'accepted' },
        { actor: { reference: 'Location/l', display: 'Main Clinic' }, status: 'accepted' },
      ],
    };
    const [visit] = buildPatientTimeline(sources({ appointments: [appointment] }), TZ).events as VisitEvent[];
    expect(visit.title).toBe('Colonoscopy consult');
    expect(visit.provider).toBe('Dr. Patel');
    expect(visit.location).toBe('Main Clinic');
    expect(visit.id).toBe('visit-a2');
  });

  test('titles visits from the encounter class and flags emergencies', () => {
    const [visit] = buildPatientTimeline(
      sources({ encounters: [encounter('e1', '2026-08-01T22:00:00Z', { class: { code: 'EMER' } })] }),
      TZ
    ).events as VisitEvent[];
    expect(visit.title).toBe('Emergency visit');
    expect(visit.isEmergency).toBe(true);
  });

  test('nests records linked by encounter reference inside the visit', () => {
    const { events } = buildPatientTimeline(
      sources({
        encounters: [encounter('e1', '2026-09-14T09:30:00Z')],
        observations: [
          vital('o1', '2026-09-14T09:40:00Z', { encounter: { reference: 'Encounter/e1' } }),
          // An exact duplicate from another source is dropped.
          vital('o1-copy', '2026-09-14T09:40:00Z', { encounter: { reference: 'Encounter/e1' } }),
        ],
        documents: [
          {
            resourceType: 'DocumentReference',
            id: 'd1',
            status: 'current',
            description: 'Progress note',
            content: [],
            context: { encounter: [{ reference: 'Encounter/e1' }] },
          } satisfies WithId<DocumentReference>,
        ],
      }),
      TZ
    );
    expect(events).toHaveLength(1);
    const visit = events[0] as VisitEvent;
    expect(visit.records.map((r) => [r.kind, r.title, r.detail])).toEqual([
      ['vitals', 'Heart rate', '72 /min'],
      ['document', 'Progress note', undefined],
    ]);
  });

  test('groups unlinked dated records into one card per day', () => {
    const { events } = buildPatientTimeline(
      sources({
        observations: [
          vital('o1', '2026-09-10T08:00:00Z'),
          vital('o2', '2026-09-10T15:00:00Z', {
            code: { text: 'Body weight' },
            valueQuantity: { value: 70, unit: 'kg' },
          }),
          vital('o3', '2026-09-11T08:00:00Z', {
            category: [{ coding: [{ code: 'laboratory' }] }],
            code: { text: 'ALT' },
          }),
        ],
      }),
      TZ
    );
    const days = events as DayRecordsEvent[];
    expect(days.map((d) => [d.type, d.dayKey, d.records.length])).toEqual([
      ['records', '2026-09-11', 1],
      ['records', '2026-09-10', 2],
    ]);
    expect(days[0].records[0].kind).toBe('lab');
  });

  test('merges duplicate conditions by name and day, counting copies and sources', () => {
    const { events } = buildPatientTimeline(
      sources({
        conditions: [
          condition('c1', 'GERD', {
            meta: tag('drchrono'),
            onsetDateTime: '2026-08-20T10:00:00Z',
            code: { text: 'GERD', coding: [{ code: 'K21.9' }] },
            clinicalStatus: { coding: [{ code: 'active' }] },
          }),
          condition('c2', 'gerd ', { meta: tag('zus'), onsetDateTime: '2026-08-20T18:00:00Z' }),
        ],
      }),
      TZ
    );
    const [event] = events as ConditionEvent[];
    expect(events).toHaveLength(1);
    expect(event.copies).toBe(2);
    expect(event.sources.sort()).toEqual(['drchrono', 'lyfe']);
    expect(event.detail).toBe('K21.9');
    expect(event.clinicalStatus).toBe('active');
  });

  test('puts undated items under ongoing care, deduplicated and ordered by kind', () => {
    const med: WithId<MedicationStatement> = {
      resourceType: 'MedicationStatement',
      id: 'm1',
      status: 'active',
      subject: P,
      medicationCodeableConcept: { text: 'Omeprazole' },
      dosage: [{ text: 'daily' }],
    };
    const allergy: WithId<AllergyIntolerance> = {
      resourceType: 'AllergyIntolerance',
      id: 'al1',
      patient: P,
      code: { text: 'Penicillin' },
      reaction: [{ manifestation: [{ text: 'Hives' }] }],
    };
    const { events, ongoing } = buildPatientTimeline(
      sources({
        conditions: [condition('c1', 'Fatty liver'), condition('c2', 'Fatty liver')],
        medicationStatements: [med, { ...med, id: 'm2' }],
        allergies: [allergy],
      }),
      TZ
    );
    expect(events).toEqual([]);
    expect(ongoing.map((i) => [i.kind, i.title, i.detail])).toEqual([
      ['condition', 'Fatty liver', undefined],
      ['medication', 'Omeprazole', 'daily'],
      ['allergy', 'Penicillin', 'Hives'],
    ]);
  });

  test('ignores entered-in-error resources and resources without dates to place', () => {
    const { events } = buildPatientTimeline(
      sources({
        encounters: [
          encounter('bad', '2026-09-01T09:00:00Z', { status: 'entered-in-error' }),
          encounter('no-start', '', { period: {} }),
        ],
        conditions: [
          condition('c1', 'Refuted', {
            onsetDateTime: '2026-09-01',
            verificationStatus: { coding: [{ code: 'entered-in-error' }] },
          }),
        ],
      }),
      TZ
    );
    expect(events).toEqual([]);
  });

  test('sorts events newest first', () => {
    const { events } = buildPatientTimeline(
      sources({
        encounters: [encounter('old', '2025-01-01T09:00:00Z'), encounter('new', '2026-01-01T09:00:00Z')],
      }),
      TZ
    );
    expect(events.map((e) => e.id)).toEqual(['visit-new', 'visit-old']);
  });
});

describe('filtering and grouping', () => {
  const { events } = buildPatientTimeline(
    sources({
      encounters: [
        encounter('e1', '2026-09-14T09:30:00Z', {
          meta: tag('drchrono'),
          type: [{ text: 'Office visit' }],
          participant: [{ individual: { display: 'Dr. Chen' } }],
          diagnosis: [{ condition: { display: 'GERD' } }],
        }),
        encounter('e2', '2026-09-12T11:00:00Z', {
          meta: tag('zus'),
          status: 'cancelled',
          participant: [{ individual: { display: 'Dr. Patel' } }],
        }),
      ],
      observations: [
        vital('o1', '2026-09-14T09:40:00Z', { encounter: { reference: 'Encounter/e1' }, code: { text: 'Pulse' } }),
        vital('o2', '2026-09-10T08:00:00Z', { meta: tag('zus') }),
        vital('o3', '2026-09-10T08:00:00Z', {
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { text: 'ALT' },
        }),
      ],
      conditions: [condition('c1', 'GERD', { onsetDateTime: '2026-09-01T10:00:00Z' })],
    }),
    TZ
  );

  const ids = (list: TimelineEvent[]): string[] => list.map((e) => e.id);

  test('no filters returns everything', () => {
    expect(filterTimeline(events, EMPTY_FILTERS)).toEqual(events);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  test('kind filters trim a day card down to matching records', () => {
    const result = filterTimeline(events, { ...EMPTY_FILTERS, kinds: ['lab'] });
    expect(result).toHaveLength(1);
    const day = result[0] as DayRecordsEvent;
    expect(day.records.map((r) => r.title)).toEqual(['ALT']);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, kinds: ['lab'] })).toBe(true);
  });

  test('provider and status filters keep only matching visits', () => {
    expect(ids(filterTimeline(events, { ...EMPTY_FILTERS, providers: ['Dr. Patel'] }))).toEqual(['visit-e2']);
    expect(ids(filterTimeline(events, { ...EMPTY_FILTERS, statuses: ['finished'] }))).toEqual(['visit-e1']);
  });

  test('source filter matches any merged source', () => {
    expect(ids(filterTimeline(events, { ...EMPTY_FILTERS, sources: ['drchrono'] }))).toEqual(['visit-e1']);
  });

  test('search matches visit fields and nested records', () => {
    expect(ids(filterTimeline(events, { ...EMPTY_FILTERS, query: 'pulse' }))).toEqual(['visit-e1']);
    expect(ids(filterTimeline(events, { ...EMPTY_FILTERS, query: 'gerd' }))).toEqual(['visit-e1', 'condition-c1']);
    expect(filterTimeline(events, { ...EMPTY_FILTERS, query: '   ' })).toEqual(events);
  });

  test('groups by local day', () => {
    expect(groupByDay(events).map((g) => [g.dayKey, g.events.length])).toEqual([
      ['2026-09-14', 1],
      ['2026-09-12', 1],
      ['2026-09-10', 1],
      ['2026-09-01', 1],
    ]);
  });

  test('groups by condition with uncategorized last', () => {
    const groups = groupByCondition(events);
    expect(groups.map((g) => [g.name, ids(g.events)])).toEqual([
      ['GERD', ['visit-e1', 'condition-c1']],
      [UNCATEGORIZED_GROUP, ['visit-e2', 'records-2026-09-10']],
    ]);
  });

  test('counts events per kind for the type filter', () => {
    expect(countByKind(events)).toEqual({ visit: 2, vitals: 1, lab: 1, condition: 1 });
  });
});

describe('helpers', () => {
  test('relative day labels', () => {
    const today = '2026-09-29';
    expect(getRelativeDayLabel('2026-09-29', today)).toBe('Today');
    expect(getRelativeDayLabel('2026-09-28', today)).toBe('Yesterday');
    expect(getRelativeDayLabel('2026-09-30', today)).toBe('Tomorrow');
    expect(getRelativeDayLabel('2026-10-10', today)).toBe('Upcoming');
    expect(getRelativeDayLabel('2026-09-26', today)).toBe(
      new Date(2026, 8, 26).toLocaleDateString(undefined, { weekday: 'long' })
    );
    expect(getRelativeDayLabel('2026-09-01', today)).toBeUndefined();
  });

  test('data source from tags', () => {
    expect(getDataSource({ resourceType: 'Patient', meta: tag('drchrono') })).toBe('drchrono');
    // Everything that is not DrChrono is Lyfe. The Lyfe Data Network's `zus`
    // provenance tag stays in the data, but it is not a third source: a record
    // pulled over the network and one created in Lyfe both read as Lyfe.
    expect(getDataSource({ resourceType: 'Patient', meta: tag('ZUS') })).toBe('lyfe');
    expect(getDataSource({ resourceType: 'Patient' })).toBe('lyfe');
  });

  test('status labels and chart paths', () => {
    expect(getVisitStatusLabel('finished')).toBe('Completed');
    expect(getVisitStatusLabel('mystery')).toBe('mystery');
    expect(getVisitStatusLabel(undefined)).toBeUndefined();
    expect(chartPath('p1', encounter('e1', '2026-01-01'))).toBe('/Patient/p1/Encounter/e1');
    expect(chartPath('p1', condition('c1', 'X'))).toBe('/Patient/p1/Condition/c1');
  });

  test("day keys are the clinic's calendar day, not the viewer's", () => {
    // 16:30 on 14 September at a Pacific clinic. The same instant is already
    // 05:30 on the 15th in Karachi, so a viewer-local key would file this
    // record under the wrong day — which is what put a whole afternoon clinic
    // on the following date.
    const afternoonAtTheClinic = new Date('2026-09-14T23:30:00Z');
    expect(toDayKey(afternoonAtTheClinic, 'US/Pacific')).toBe('2026-09-14');
    expect(toDayKey(afternoonAtTheClinic, 'Asia/Karachi')).toBe('2026-09-15');
  });

  test('day keys hold across a DST transition', () => {
    // US DST ends on 1 November 2026: the day is 25 hours long and the offset
    // changes inside it. Both sides of the change belong to the same day.
    expect(toDayKey(new Date('2026-11-01T08:30:00Z'), 'US/Pacific')).toBe('2026-11-01');
    expect(toDayKey(new Date('2026-11-01T09:30:00Z'), 'US/Pacific')).toBe('2026-11-01');
    expect(toDayKey(new Date('2026-11-02T07:59:00Z'), 'US/Pacific')).toBe('2026-11-01');
    expect(toDayKey(new Date('2026-11-02T08:00:00Z'), 'US/Pacific')).toBe('2026-11-02');
  });
});
