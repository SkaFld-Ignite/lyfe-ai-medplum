// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import type { DocumentRow } from '../utils/patient-documents';
import { toDocumentRow } from '../utils/patient-documents';

/** Documents requested at once (the server's maximum page size). */
export const DOCUMENTS_PAGE_SIZE = 1000;

/**
 * Loads a patient's documents. Soft-deleted documents (marked entered-in-error) are excluded.
 * @param medplum - The Medplum client.
 * @param patientId - The patient id.
 * @returns The rows, newest first, and whether the patient has more than one page.
 */
export async function fetchPatientDocuments(
  medplum: MedplumClient,
  patientId: string
): Promise<{ rows: DocumentRow[]; truncated: boolean }> {
  const bundle = await medplum.search(
    'DocumentReference',
    {
      subject: `Patient/${patientId}`,
      'status:not': 'entered-in-error',
      _sort: '-date',
      _count: String(DOCUMENTS_PAGE_SIZE),
    },
    { cache: 'no-cache' }
  );
  const rows = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((r): r is DocumentReference & { id: string } => Boolean(r?.id))
    .map(toDocumentRow);
  return { rows, truncated: Boolean(bundle.link?.some((link) => link.relation === 'next')) };
}

export interface PatientDocumentsData {
  rows: DocumentRow[];
  loading: boolean;
  error?: string;
  /** The patient has more documents than were loaded. */
  truncated: boolean;
  reload: () => void;
}

/**
 * Loads the documents for a patient. The current list stays on screen while a reload runs.
 * @param patientId - The patient id.
 * @param refreshKey - Changing this reloads the list, e.g. after an upload elsewhere on the page.
 * @returns The rows plus loading/error state and a reload callback.
 */
export function usePatientDocuments(patientId: string, refreshKey = 0): PatientDocumentsData {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const [settled, setSettled] = useState<{
    requestKey: string;
    patientId?: string;
    rows: DocumentRow[];
    truncated: boolean;
    error?: string;
  }>({ requestKey: '', rows: [], truncated: false });

  const requestKey = `${patientId}:${reloadKey}:${refreshKey}`;

  useEffect(() => {
    let active = true;
    const key = `${patientId}:${reloadKey}:${refreshKey}`;
    fetchPatientDocuments(medplum, patientId)
      .then(({ rows, truncated }) => {
        if (active) {
          setSettled({ requestKey: key, patientId, rows, truncated });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setSettled((prev) => ({ ...prev, requestKey: key, patientId, error: normalizeErrorString(err) }));
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, patientId, reloadKey, refreshKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const current = settled.requestKey === requestKey;
  // Rows from another patient are never shown, even while the next patient loads.
  const samePatient = settled.patientId === patientId;

  return {
    rows: samePatient ? settled.rows : [],
    loading: !current,
    error: current ? settled.error : undefined,
    truncated: samePatient && settled.truncated,
    reload,
  };
}
