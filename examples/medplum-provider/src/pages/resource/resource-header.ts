// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { getDisplayString, getReferenceString } from '@medplum/core';
import type { CodeableConcept, Resource } from '@medplum/fhirtypes';

/** The patient chart section each record type belongs to, for the "back" link. */
export const PATIENT_SECTIONS: Partial<Record<string, { url: string; label: string }>> = {
  AllergyIntolerance: { url: 'allergies', label: 'Allergies' },
  CarePlan: { url: 'careplans', label: 'Care Plans' },
  Condition: { url: 'conditions', label: 'Conditions' },
  Device: { url: 'devices', label: 'Devices' },
  Encounter: { url: 'Encounter', label: 'Encounters' },
  Immunization: { url: 'immunizations', label: 'Immunizations' },
  Observation: { url: 'vitals', label: 'Vitals' },
};

/**
 * Splits a resource type into words: "AllergyIntolerance" to "Allergy intolerance".
 * @param resourceType - The FHIR type.
 * @returns The label.
 */
export function resourceTypeLabel(resourceType: string): string {
  const words = resourceType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function conceptText(concept: CodeableConcept | undefined): string | undefined {
  return concept?.text ?? concept?.coding?.find((c) => c.display)?.display;
}

/**
 * A readable name for a record. Medplum's display string falls back to "CarePlan/1f2e…" for types
 * it has no name rule for, so try the usual naming fields, then the type itself.
 * @param resource - The record.
 * @returns The name.
 */
export function resourceTitle(resource: Resource): string {
  const display = getDisplayString(resource);
  if (display !== getReferenceString(resource)) {
    return display;
  }
  const r = resource as unknown as Record<string, unknown>;
  const fromFields =
    (typeof r.title === 'string' ? r.title : undefined) ??
    conceptText(r.code as CodeableConcept | undefined) ??
    conceptText((r.category as CodeableConcept[] | undefined)?.[0]) ??
    conceptText(r.type as CodeableConcept | undefined);
  return fromFields ?? resourceTypeLabel(resource.resourceType);
}

/**
 * A record's status, from `status` or a `clinicalStatus` concept.
 * @param resource - The record.
 * @returns The status code, if any.
 */
export function resourceStatus(resource: Resource): string | undefined {
  const r = resource as unknown as Record<string, unknown>;
  if (typeof r.status === 'string') {
    return r.status;
  }
  return (r.clinicalStatus as CodeableConcept | undefined)?.coding?.[0]?.code;
}
