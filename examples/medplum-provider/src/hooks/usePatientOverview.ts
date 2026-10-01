// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { DRCHRONO_SOURCE_TAG } from '../utils/data-source';
import type { OverviewSources, PatientOverview } from '../utils/patient-overview';
import { buildPatientOverview } from '../utils/patient-overview';

/**
 * Loads what the overview summarises, in parallel. Like the timeline, only DrChrono data is shown.
 * @param medplum - The Medplum client.
 * @param patientId - The patient id.
 * @returns The resources by kind.
 */
export async function fetchOverviewSources(medplum: MedplumClient, patientId: string): Promise<OverviewSources> {
  const patient = `Patient/${patientId}`;
  const base = { patient, _tag: DRCHRONO_SOURCE_TAG };
  const options = { cache: 'no-cache' as const };
  const [conditions, medicationRequests, medicationStatements, allergies, vitals, encounters, appointments] =
    await Promise.all([
      medplum.searchResources('Condition', { ...base, _count: '500' }, options),
      medplum.searchResources('MedicationRequest', { ...base, _count: '500' }, options),
      medplum.searchResources('MedicationStatement', { ...base, _count: '500' }, options),
      medplum.searchResources('AllergyIntolerance', { ...base, _count: '200' }, options),
      medplum.searchResources(
        'Observation',
        { ...base, category: 'vital-signs', _sort: '-date', _count: '500' },
        options
      ),
      medplum.searchResources('Encounter', { ...base, _sort: '-date', _count: '50' }, options),
      medplum.searchResources(
        'Appointment',
        { ...base, date: `ge${new Date().toISOString()}`, _sort: 'date', _count: '20' },
        options
      ),
    ]);
  return { conditions, medicationRequests, medicationStatements, allergies, vitals, encounters, appointments };
}

export interface PatientOverviewData {
  overview?: PatientOverview;
  loading: boolean;
  error?: string;
  reload: () => void;
}

/**
 * Loads and builds the patient overview. Stale responses for a previous patient are ignored.
 * @param patientId - The patient id.
 * @returns The overview with loading/error state and a reload callback.
 */
export function usePatientOverview(patientId: string): PatientOverviewData {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<{ key: string; overview?: PatientOverview; error?: string }>({ key: '' });
  const requestKey = `${patientId}:${reloadKey}`;

  useEffect(() => {
    let active = true;
    const key = `${patientId}:${reloadKey}`;
    fetchOverviewSources(medplum, patientId)
      .then((sources) => active && setSettled({ key, overview: buildPatientOverview(sources) }))
      .catch((err: unknown) => active && setSettled({ key, error: normalizeErrorString(err) }));
    return () => {
      active = false;
    };
  }, [medplum, patientId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const current = settled.key === requestKey;
  return {
    overview: current ? settled.overview : undefined,
    loading: !current,
    error: current ? settled.error : undefined,
    reload,
  };
}
