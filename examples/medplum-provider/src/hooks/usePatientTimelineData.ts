// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient, WithId } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { Resource, ResourceType } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { DRCHRONO_SOURCE_TAG } from '../utils/data-source';
import type { PatientTimeline, TimelineSources } from '../utils/patient-timeline';
import { buildPatientTimeline } from '../utils/patient-timeline';

/** Records requested per resource type (the server's maximum page size). */
export const TIMELINE_PAGE_SIZE = 1000;

const SOURCE_TYPES: Record<keyof TimelineSources, ResourceType> = {
  encounters: 'Encounter',
  appointments: 'Appointment',
  conditions: 'Condition',
  observations: 'Observation',
  diagnosticReports: 'DiagnosticReport',
  documents: 'DocumentReference',
  medicationRequests: 'MedicationRequest',
  medicationStatements: 'MedicationStatement',
  allergies: 'AllergyIntolerance',
  immunizations: 'Immunization',
  procedures: 'Procedure',
};

/**
 * Loads every resource type shown on the timeline for one patient, in parallel. Only resources
 * imported from DrChrono are requested.
 * @param medplum - The Medplum client.
 * @param patientId - The patient id.
 * @returns The resources by type, and the types that had more than one page.
 */
export async function fetchTimelineSources(
  medplum: MedplumClient,
  patientId: string
): Promise<{ sources: TimelineSources; truncatedTypes: ResourceType[] }> {
  const keys = Object.keys(SOURCE_TYPES) as (keyof TimelineSources)[];
  const results = await Promise.all(
    keys.map((key) =>
      medplum.search(
        SOURCE_TYPES[key],
        { patient: `Patient/${patientId}`, _tag: DRCHRONO_SOURCE_TAG, _count: String(TIMELINE_PAGE_SIZE) },
        { cache: 'no-cache' }
      )
    )
  );

  const sources = {} as Record<keyof TimelineSources, WithId<Resource>[]>;
  const truncatedTypes: ResourceType[] = [];
  keys.forEach((key, i) => {
    const bundle = results[i];
    sources[key] = (bundle.entry ?? []).map((entry) => entry.resource).filter(Boolean) as WithId<Resource>[];
    if (bundle.link?.some((link) => link.relation === 'next')) {
      truncatedTypes.push(SOURCE_TYPES[key]);
    }
  });
  return { sources: sources as unknown as TimelineSources, truncatedTypes };
}

export interface PatientTimelineData {
  timeline?: PatientTimeline;
  loading: boolean;
  error?: string;
  /** Resource types with more records than were loaded. */
  truncatedTypes: ResourceType[];
  reload: () => void;
}

/**
 * Loads and builds the timeline for a patient. Stale responses from a previous patient are ignored.
 * @param patientId - The patient id, or undefined while the patient is loading.
 * @returns The timeline plus loading/error state and a reload callback.
 */
export function usePatientTimelineData(patientId: string | undefined): PatientTimelineData {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<{
    requestKey: string;
    timeline?: PatientTimeline;
    truncatedTypes: ResourceType[];
    error?: string;
  }>({ requestKey: '', truncatedTypes: [] });

  const requestKey = patientId ? `${patientId}:${reloadKey}` : '';

  useEffect(() => {
    if (!patientId) {
      return undefined;
    }
    let active = true;
    const key = `${patientId}:${reloadKey}`;
    fetchTimelineSources(medplum, patientId)
      .then(({ sources, truncatedTypes }) => {
        if (active) {
          setSettled({ requestKey: key, timeline: buildPatientTimeline(sources), truncatedTypes });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setSettled({ requestKey: key, truncatedTypes: [], error: normalizeErrorString(err) });
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, patientId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const current = settled.requestKey === requestKey;

  return {
    timeline: current ? settled.timeline : undefined,
    loading: requestKey !== '' && !current,
    error: current ? settled.error : undefined,
    truncatedTypes: current ? settled.truncatedTypes : [],
    reload,
  };
}
