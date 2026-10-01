// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Condition, MedicationRequest, Observation } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { OverviewSources } from './patient-overview';
import {
  buildPatientOverview,
  classifyBloodPressure,
  classifyHeartRate,
  classifySpo2,
  POLYPHARMACY_THRESHOLD,
} from './patient-overview';

const NOW = new Date('2026-10-01T12:00:00Z');

function sources(partial: Partial<OverviewSources> = {}): OverviewSources {
  return {
    conditions: [],
    medicationRequests: [],
    medicationStatements: [],
    allergies: [],
    vitals: [],
    encounters: [],
    appointments: [],
    ...partial,
  };
}

function condition(text: string, status = 'active'): Condition {
  return {
    resourceType: 'Condition',
    subject: { reference: 'Patient/p' },
    code: { text },
    clinicalStatus: { coding: [{ code: status }] },
  };
}

function med(text: string): MedicationRequest {
  return {
    resourceType: 'MedicationRequest',
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/p' },
    medicationCodeableConcept: { text },
  };
}

describe('classifying vitals', () => {
  test('grades blood pressure by the AHA bands', () => {
    expect(classifyBloodPressure(115, 75).status).toBe('Normal');
    expect(classifyBloodPressure(125, 75).status).toBe('Elevated');
    expect(classifyBloodPressure(132, 70).status).toBe('Stage 1');
    expect(classifyBloodPressure(120, 92).status).toBe('Stage 2');
    expect(classifyBloodPressure(185, 100)).toEqual({ status: 'Crisis', severity: 'critical' });
  });

  test('grades heart rate and oxygen saturation', () => {
    expect(classifyHeartRate(72).severity).toBe('normal');
    expect(classifyHeartRate(130).severity).not.toBe('normal');
    expect(classifySpo2(98).severity).toBe('normal');
    expect(classifySpo2(85).severity).not.toBe('normal');
  });
});

describe('the patient overview', () => {
  test('lists active conditions once each and leaves out resolved ones', () => {
    const overview = buildPatientOverview(
      sources({ conditions: [condition('Diabetes'), condition('Diabetes'), condition('Flu', 'resolved')] }),
      NOW
    );
    expect(overview.conditions.map((c) => c.label)).toEqual(['Diabetes']);
  });

  test('flags severe allergies, polypharmacy and several chronic conditions', () => {
    const overview = buildPatientOverview(
      sources({
        conditions: [condition('A'), condition('B'), condition('C')],
        medicationRequests: Array.from({ length: POLYPHARMACY_THRESHOLD + 1 }, (_, i) => med(`Med ${i}`)),
        allergies: [
          {
            resourceType: 'AllergyIntolerance',
            patient: { reference: 'Patient/p' },
            code: { text: 'Penicillin' },
            criticality: 'high',
          },
        ],
      }),
      NOW
    );
    expect(overview.severeAllergyCount).toBe(1);
    expect(overview.flags.map((f) => f.label)).toEqual(['1 severe allergy', 'Polypharmacy', '3 chronic conditions']);
  });

  test('flags a raised blood pressure from the latest reading', () => {
    const reading: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
      effectiveDateTime: '2026-09-30T10:00:00Z',
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 150 } },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 95 } },
      ],
    };
    const overview = buildPatientOverview(sources({ vitals: [reading] }), NOW);
    expect(overview.flags).toContainEqual(expect.objectContaining({ label: 'BP Stage 2', icon: 'bp' }));
    expect(overview.vitalsDate?.toISOString()).toBe('2026-09-30T10:00:00.000Z');
  });

  test('finds the last and next visits and flags a long gap', () => {
    const overview = buildPatientOverview(
      sources({
        encounters: [
          {
            resourceType: 'Encounter',
            status: 'finished',
            class: { code: 'AMB' },
            period: { start: '2025-01-10T10:00:00Z' },
          },
          {
            resourceType: 'Encounter',
            status: 'finished',
            class: { code: 'AMB' },
            period: { start: '2025-03-10T10:00:00Z' },
          },
        ],
        appointments: [
          {
            resourceType: 'Appointment',
            status: 'booked',
            participant: [],
            start: '2026-11-01T10:00:00Z',
            description: 'Follow-up',
          },
          { resourceType: 'Appointment', status: 'cancelled', participant: [], start: '2026-10-15T10:00:00Z' },
        ],
      }),
      NOW
    );
    expect(overview.lastVisit?.date.toISOString()).toBe('2025-03-10T10:00:00.000Z');
    expect(overview.nextVisit?.reason).toBe('Follow-up');
    expect(overview.flags.some((f) => f.icon === 'visit')).toBe(true);
  });
});
