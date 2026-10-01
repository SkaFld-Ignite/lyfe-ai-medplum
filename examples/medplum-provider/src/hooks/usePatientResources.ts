// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeErrorString } from '@medplum/core';
import type { ExtractResource, ResourceType } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import { DRCHRONO_SOURCE_TAG } from '../utils/data-source';

export interface PatientResources<T> {
  items: T[];
  loading: boolean;
  error?: string;
  reload: () => void;
}

/**
 * Loads one resource type for a patient: their DrChrono records, like the rest of the chart.
 * @param resourceType - The FHIR type, e.g. `Condition`.
 * @param patientId - The patient id.
 * @param params - Extra search parameters, e.g. `{ _sort: '-date' }`.
 * @param options - Search options.
 * @param options.allSources - Load records from every source, for types DrChrono never sends
 *   (care plans and devices come only from Zus).
 * @returns The resources with loading/error state and a reload callback.
 */
export function usePatientResources<K extends ResourceType>(
  resourceType: K,
  patientId: string,
  params: Record<string, string> = {},
  options: { allSources?: boolean } = {}
): PatientResources<ExtractResource<K>> {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const paramsKey = JSON.stringify(options.allSources ? params : { _tag: DRCHRONO_SOURCE_TAG, ...params });
  const requestKey = `${resourceType}:${patientId}:${paramsKey}:${reloadKey}`;
  const [settled, setSettled] = useState<{ key: string; items: ExtractResource<K>[]; error?: string }>({
    key: '',
    items: [],
  });

  useEffect(() => {
    let active = true;
    const key = `${resourceType}:${patientId}:${paramsKey}:${reloadKey}`;
    medplum
      .searchResources(
        resourceType,
        { patient: `Patient/${patientId}`, _count: '500', ...JSON.parse(paramsKey) },
        { cache: 'no-cache' }
      )
      .then((items) => {
        if (active) {
          setSettled({ key, items: items });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setSettled({ key, items: [], error: normalizeErrorString(err) });
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, resourceType, patientId, paramsKey, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const current = settled.key === requestKey;
  return { items: current ? settled.items : [], loading: !current, error: current ? settled.error : undefined, reload };
}
