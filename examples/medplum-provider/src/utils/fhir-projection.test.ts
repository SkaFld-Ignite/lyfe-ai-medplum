// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { getReferenceString } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { collectCitableSources } from '../../bots/shared/spaces-ai.ts';
import { hasProjection, projectBundle, projectResource, projectToolResult } from './fhir-projection';

/**
 * The references a bundle makes citable, computed exactly the way
 * `extractResourceRefs` in `./spaceMessaging.ts` computes them.
 * @param bundle - A bundle, projected or not.
 * @returns The reference strings, in order.
 */
function refsOf(bundle: unknown): string[] {
  const entries = (bundle as Bundle).entry ?? [];
  return entries
    .map((entry) => (entry.resource ? getReferenceString(entry.resource) : undefined))
    .filter((ref): ref is string => !!ref);
}

/**
 * The `match` rows of a raw bundle, as references.
 * @param bundle - The raw bundle.
 * @returns The reference strings of the rows that are not `_include`d.
 */
function matchRefsOf(bundle: Bundle): string[] {
  return (bundle.entry ?? [])
    .filter((entry) => entry.search?.mode !== 'include')
    .map((entry) => (entry.resource ? getReferenceString(entry.resource) : undefined))
    .filter((ref): ref is string => !!ref);
}

/**
 * What the summary bot sees: the projected bundle as a stored tool message.
 * @param bundle - The projected bundle.
 * @returns The references the bot would number `S1`, `S2`, …
 */
function botSources(bundle: unknown): string[] {
  return collectCitableSources([{ role: 'tool', content: JSON.stringify(bundle) }]);
}

/**
 * FHIR scaffolding every real resource carries and no answer needs.
 * @param resourceType - The resource type the scaffolding belongs to.
 * @param id - The resource id, echoed into the narrative the way a server does.
 * @returns The scaffolding fields, to spread onto a fixture resource.
 */
function scaffolding(resourceType: string, id: string): Record<string, unknown> {
  return {
    meta: {
      versionId: '0d9f2c4e-1f3b-4a1e-9c2a-8b6d5e4f3a2b',
      lastUpdated: '2026-09-30T11:04:22.119Z',
      author: { reference: 'Practitioner/8a7b6c5d-4e3f-2a1b-9c8d-7e6f5a4b3c2d' },
      project: '3f2e1d0c-9b8a-7654-3210-fedcba987654',
      compartment: [{ reference: 'Project/3f2e1d0c-9b8a-7654-3210-fedcba987654' }],
    },
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p><b>Generated Narrative with Details</b></p><p><b>id</b>: ${id}</p><p><b>resourceType</b>: ${resourceType}</p><p>This narrative is machine generated and duplicates every structured field above it.</p></div>`,
    },
    extension: [
      {
        url: 'https://drchrono.com/fhir/StructureDefinition/sync-source',
        valueString: 'drchrono',
      },
      {
        url: 'https://drchrono.com/fhir/StructureDefinition/external-id',
        valueString: `${resourceType.toLowerCase()}-${id}`,
      },
    ],
    identifier: [
      { system: 'https://drchrono.com/api', value: `${resourceType}-${id}` },
      { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${id}` },
    ],
    implicitRules: undefined,
  };
}

/**
 * A realistic week of clinic appointments, with the patients `_include` pulls along.
 *
 * Sized to the incident this change was written for: ~2,100 characters per raw Appointment entry
 * and ~2,500 per raw Patient, which is what a Medplum deployment carrying US Core profiles and a
 * DrChrono sync returns.
 * @param appointments - How many matched Appointment rows.
 * @param patients - How many `_include`d Patient rows.
 * @returns The searchset bundle.
 */
function weekOfAppointments(appointments: number, patients: number): Bundle {
  const entry: Bundle['entry'] = [];
  for (let i = 0; i < appointments; i++) {
    const id = `appt-${String(i).padStart(4, '0')}-9c2a-8b6d5e4f3a2b`;
    const patientId = `pat-${String(i % patients).padStart(4, '0')}-4e3f-2a1b9c8d7e6f`;
    entry.push({
      fullUrl: `https://api.lyfeco.ai/fhir/R4/Appointment/${id}`,
      search: { mode: 'match' },
      resource: {
        resourceType: 'Appointment',
        id,
        ...scaffolding('Appointment', id),
        status: 'booked',
        serviceType: [
          { coding: [{ system: 'http://snomed.info/sct', code: '394802001', display: 'General medicine' }] },
        ],
        appointmentType: { coding: [{ code: 'FOLLOWUP', display: 'Follow-up' }] },
        reasonCode: [{ text: 'Hypertension follow-up' }],
        description: 'Routine 20 minute follow-up',
        comment: 'Patient asked for the earliest slot',
        start: `2026-09-${String(28 + (i % 3)).padStart(2, '0')}T${String(8 + (i % 8)).padStart(2, '0')}:00:00.000Z`,
        end: `2026-09-${String(28 + (i % 3)).padStart(2, '0')}T${String(8 + (i % 8)).padStart(2, '0')}:20:00.000Z`,
        minutesDuration: 20,
        created: '2026-09-01T09:00:00.000Z',
        participant: [
          {
            actor: { reference: `Patient/${patientId}`, display: `Patient Number ${i % patients}` },
            required: 'required',
            status: 'accepted',
          },
          {
            actor: { reference: 'Practitioner/prac-0001-aaaa-bbbb-cccc', display: 'Dr Alice Mercer' },
            required: 'required',
            status: 'accepted',
          },
          {
            actor: { reference: 'Location/loc-0001-aaaa-bbbb-cccc', display: 'Exam Room 3' },
            required: 'optional',
            status: 'accepted',
          },
        ],
      },
    });
  }
  for (let i = 0; i < patients; i++) {
    const id = `pat-${String(i).padStart(4, '0')}-4e3f-2a1b9c8d7e6f`;
    entry.push({
      fullUrl: `https://api.lyfeco.ai/fhir/R4/Patient/${id}`,
      search: { mode: 'include' },
      resource: {
        resourceType: 'Patient',
        id,
        ...scaffolding('Patient', id),
        active: true,
        name: [{ use: 'official', given: ['Patient'], family: `Number ${i}` }],
        telecom: [
          { system: 'phone', value: `555-010-${String(i).padStart(4, '0')}`, use: 'mobile' },
          { system: 'email', value: `patient${i}@example.com`, use: 'home' },
        ],
        gender: i % 2 === 0 ? 'female' : 'male',
        birthDate: `19${50 + (i % 45)}-0${1 + (i % 9)}-1${i % 9}`,
        address: [
          {
            use: 'home',
            line: [`${100 + i} Example Street`, 'Apartment 4B'],
            city: 'Springfield',
            state: 'IL',
            postalCode: '62704',
            country: 'US',
          },
        ],
        maritalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', code: 'M', display: 'Married' }],
        },
        contact: [
          {
            relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'C' }] }],
            name: { given: ['Emergency'], family: `Contact ${i}` },
            telecom: [{ system: 'phone', value: `555-020-${String(i).padStart(4, '0')}` }],
          },
        ],
        // US Core race and ethnicity, which every Medplum deployment in a US clinic carries and
        // which no clinical question has ever needed.
        ...{
          extension: [
            {
              url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
              extension: [
                {
                  url: 'ombCategory',
                  valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.238', code: '2106-3', display: 'White' },
                },
                { url: 'text', valueString: 'White' },
              ],
            },
            {
              url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
              extension: [
                {
                  url: 'ombCategory',
                  valueCoding: {
                    system: 'urn:oid:2.16.840.1.113883.6.238',
                    code: '2186-5',
                    display: 'Not Hispanic or Latino',
                  },
                },
                { url: 'text', valueString: 'Not Hispanic or Latino' },
              ],
            },
          ],
        },
        communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en', display: 'English' }] } }],
        generalPractitioner: [{ reference: 'Practitioner/prac-0001-aaaa-bbbb-cccc', display: 'Dr Alice Mercer' }],
        managingOrganization: { reference: 'Organization/org-0001-aaaa-bbbb-cccc', display: 'Springfield Family Care' },
      },
    });
  }
  return { resourceType: 'Bundle', type: 'searchset', total: appointments, entry };
}

describe('projectBundle - citations', () => {
  test('keeps every matched row, in order, with its reference intact', () => {
    const bundle = weekOfAppointments(43, 40);
    const projected = projectBundle(bundle);

    expect(refsOf(projected)).toEqual(matchRefsOf(bundle));
    expect((projected as unknown as Bundle).entry).toHaveLength(43);
  });

  test('drops the rows _include volunteered, which is where the 40 duplicate source cards came from', () => {
    const bundle = weekOfAppointments(43, 40);
    const projected = projectBundle(bundle);

    expect(refsOf(bundle).filter((ref) => ref.startsWith('Patient/'))).toHaveLength(40);
    expect(refsOf(projected).filter((ref) => ref.startsWith('Patient/'))).toHaveLength(0);
    // Not lost: the patient's name and reference are on every Appointment row that pointed at one.
    const first = (projected as { entry: { resource: Record<string, unknown> }[] }).entry[0].resource;
    expect(first.patient).toBe('Patient Number 0 (Patient/pat-0000-4e3f-2a1b9c8d7e6f)');
  });

  test('leaves a bundle whole when the server set no search mode at all', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: { resourceType: 'Patient', id: 'p1' } }, { resource: { resourceType: 'Patient', id: 'p2' } }],
    };

    expect(refsOf(projectBundle(bundle))).toEqual(['Patient/p1', 'Patient/p2']);
  });

  test('the summary bot numbers the projected bundle exactly as the UI does', () => {
    const bundle = weekOfAppointments(43, 40);
    const projected = projectBundle(bundle);

    // This is the tripwire the module comment names: `Sn` is a position in this list. The two
    // sides must agree about what is in it, whatever the projection chooses to drop.
    expect(botSources(projected)).toEqual(refsOf(projected));
    expect(botSources(projected)).toEqual(matchRefsOf(bundle));
  });

  test('a projected resource never carries a top-level reference key', () => {
    // Both citation readers prefer `reference` over `resourceType/id`, so one here would silently
    // re-point the card.
    const projected = projectResource({
      resourceType: 'Patient',
      id: 'p1',
      reference: 'Patient/somebody-else',
      name: [{ given: ['Jane'], family: 'Doe' }],
    });

    expect(projected).not.toHaveProperty('reference');
    expect(getReferenceString(projected as never)).toBe('Patient/p1');
  });

  test('an empty result set stays an empty entry array rather than becoming a citable Bundle', () => {
    const bundle: Bundle = { resourceType: 'Bundle', id: 'b1', type: 'searchset', total: 0, entry: [] };
    const projected = projectBundle(bundle);

    expect((projected as unknown as Bundle).entry).toEqual([]);
    expect(botSources(projected)).toEqual([]);
    expect(botSources(bundle)).toEqual([]);
  });
});

describe('projectBundle - what is kept and what is dropped', () => {
  const bundle = weekOfAppointments(1, 1);
  const projected = projectBundle(bundle);
  const entries = projected.entry as { resource: Record<string, unknown> }[];

  test('an Appointment keeps when, with whom, where and why', () => {
    expect(entries[0].resource).toEqual({
      resourceType: 'Appointment',
      id: 'appt-0000-9c2a-8b6d5e4f3a2b',
      status: 'booked',
      start: '2026-09-28T08:00:00.000Z',
      end: '2026-09-28T08:20:00.000Z',
      type: 'Follow-up',
      reason: 'Hypertension follow-up',
      patient: 'Patient Number 0 (Patient/pat-0000-4e3f-2a1b9c8d7e6f)',
      practitioners: ['Dr Alice Mercer (Practitioner/prac-0001-aaaa-bbbb-cccc)'],
      location: 'Exam Room 3 (Location/loc-0001-aaaa-bbbb-cccc)',
    });
  });

  test('a Patient read on its own keeps demographics and contact', () => {
    expect(projectResource(bundle.entry?.[1].resource)).toEqual({
      resourceType: 'Patient',
      id: 'pat-0000-4e3f-2a1b9c8d7e6f',
      name: 'Patient Number 0',
      birthDate: '1950-01-10',
      gender: 'female',
      phone: '555-010-0000',
      email: 'patient0@example.com',
    });
  });

  test('falls back to the description when no reason code was coded', () => {
    const projectedAppointment = projectResource({
      resourceType: 'Appointment',
      id: 'a1',
      description: 'Annual physical',
      comment: 'Bring last year*s labs',
    }) as Record<string, unknown>;

    expect(projectedAppointment.reason).toBe('Annual physical');
  });

  test('drops meta, narrative, extensions and fullUrl', () => {
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain('meta');
    expect(serialized).not.toContain('text.div');
    expect(serialized).not.toContain('xmlns');
    expect(serialized).not.toContain('extension');
    expect(serialized).not.toContain('fullUrl');
    expect(serialized).not.toContain('https://api.lyfeco.ai');
  });

  test('keeps the bundle total, so the model can say how many there were', () => {
    expect(projected.total).toBe(1);
    expect(projected.type).toBe('searchset');
  });

  test('keeps a next link and drops the self link', () => {
    const paged = projectBundle({
      resourceType: 'Bundle',
      type: 'searchset',
      link: [
        { relation: 'self', url: 'https://api.lyfeco.ai/fhir/R4/Appointment?_count=20' },
        { relation: 'next', url: 'https://api.lyfeco.ai/fhir/R4/Appointment?_count=20&_offset=20' },
      ],
    });

    expect(paged.next).toBe('https://api.lyfeco.ai/fhir/R4/Appointment?_count=20&_offset=20');
    expect(JSON.stringify(paged)).not.toContain('_count=20"');
  });
});

describe('projectBundle - size', () => {
  /*
   * The whole point of the change, pinned so a projection that starts forwarding fields again
   * fails here rather than two minutes into a clinician's question.
   *
   * The ratio is the headline number but the weaker guard, because it moves with how bloated the
   * fixture's raw side is. The per-row budget is the one that actually holds a future change to
   * account: a matched Appointment row is ~420 characters and there is no field left to add that
   * would not be visible in the `toEqual` above.
   */
  test('cuts a realistic week of appointments by more than an order of magnitude', () => {
    const bundle = weekOfAppointments(43, 40);
    const before = JSON.stringify(bundle).length;
    const after = JSON.stringify(projectBundle(bundle)).length;
    const rows = ((projectBundle(bundle) as unknown as Bundle).entry ?? []).length;

    expect(before).toBeGreaterThan(150_000);
    expect(after * 10).toBeLessThan(before);
    expect(after).toBeLessThan(20_000);
    expect(after / rows).toBeLessThan(450);
  });
});

describe('projectResource - clinical content is never guessed at', () => {
  test('an unknown resource type is forwarded unchanged', () => {
    const resource = {
      resourceType: 'NutritionOrder',
      id: 'n1',
      meta: { versionId: '1' },
      status: 'active',
      oralDiet: { type: [{ text: 'Low sodium' }], schedule: [{ repeat: { frequency: 3, period: 1 } }] },
    };

    expect(hasProjection('NutritionOrder')).toBe(false);
    expect(projectResource(resource)).toBe(resource);
  });

  test('a dosage with no sig text is forwarded whole rather than summarised', () => {
    const doseAndRate = [{ doseQuantity: { value: 500, unit: 'mg' } }];
    const projected = projectResource({
      resourceType: 'MedicationRequest',
      id: 'mr1',
      status: 'active',
      medicationCodeableConcept: { text: 'Metformin' },
      dosageInstruction: [{ timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } }, doseAndRate }],
    }) as Record<string, unknown>;

    expect(projected.medication).toBe('Metformin');
    expect((projected.dosage as Record<string, unknown>[])[0].doseAndRate).toEqual(doseAndRate);
  });

  test('a dosage with a sig uses it', () => {
    const projected = projectResource({
      resourceType: 'MedicationRequest',
      id: 'mr2',
      medicationCodeableConcept: { text: 'Metformin' },
      dosageInstruction: [{ text: '500 mg by mouth twice daily' }],
    }) as Record<string, unknown>;

    expect(projected.dosage).toEqual(['500 mg by mouth twice daily']);
  });

  test('a contained medication is resolved rather than left as a #fragment', () => {
    const projected = projectResource({
      resourceType: 'MedicationRequest',
      id: 'mr3',
      contained: [{ resourceType: 'Medication', id: 'med1', code: { text: 'Lisinopril 10 mg' } }],
      medicationReference: { reference: '#med1' },
    }) as Record<string, unknown>;

    expect(projected.medication).toBe('Lisinopril 10 mg');
  });

  test('a blood pressure keeps both of its components, which is where its value lives', () => {
    const projected = projectResource({
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { text: 'Blood pressure panel' },
      effectiveDateTime: '2026-09-30T10:00:00Z',
      component: [
        { code: { text: 'Systolic' }, valueQuantity: { value: 142, unit: 'mmHg' } },
        { code: { text: 'Diastolic' }, valueQuantity: { value: 88, unit: 'mmHg' } },
      ],
    }) as Record<string, unknown>;

    expect(projected.component).toEqual([
      { code: 'Systolic', value: '142 mmHg' },
      { code: 'Diastolic', value: '88 mmHg' },
    ]);
  });

  test('a Condition keeps its code, onset and clinical status', () => {
    const projected = projectResource({
      resourceType: 'Condition',
      id: 'c1',
      code: { coding: [{ code: '38341003', display: 'Hypertension' }] },
      clinicalStatus: { coding: [{ code: 'active' }] },
      onsetDateTime: '2019-04-02',
      recordedDate: '2019-04-03',
      subject: { reference: 'Patient/p1', display: 'Jane Doe' },
    }) as Record<string, unknown>;

    expect(projected).toEqual({
      resourceType: 'Condition',
      id: 'c1',
      code: 'Hypertension',
      clinicalStatus: 'active',
      onset: '2019-04-02',
      recordedDate: '2019-04-03',
      patient: 'Jane Doe (Patient/p1)',
    });
  });
});

describe('projectToolResult', () => {
  test('leaves a single-resource read at full fidelity', () => {
    const patient = {
      resourceType: 'Patient',
      id: 'p1',
      meta: { versionId: '2' },
      name: [{ given: ['Jane'], family: 'Doe' }],
    } as const;

    expect(projectToolResult(patient as never)).toBe(patient);
  });

  test('projects a bundle', () => {
    const projected = projectToolResult(weekOfAppointments(2, 2)) as Record<string, unknown>;

    expect(projected.resourceType).toBe('Bundle');
    expect(JSON.stringify(projected)).not.toContain('xmlns');
  });
});
