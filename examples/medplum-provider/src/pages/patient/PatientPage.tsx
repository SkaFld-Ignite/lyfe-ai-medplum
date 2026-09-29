// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Modal, ScrollArea } from '@mantine/core';
import { isOk } from '@medplum/core';
import type { OperationOutcome } from '@medplum/fhirtypes';
import {
  createPharmaciesSection,
  Document,
  getDefaultSections,
  OperationOutcomeAlert,
  PatientSummary,
  useMedplum,
} from '@medplum/react';
import type { JSX } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import { usePharmacyDialog } from '../../components/pharmacy/usePharmacyDialog';
import { useDoseSpotAccess } from '../../hooks/useDoseSpotAccess';
import { usePatient } from '../../hooks/usePatient';
import { OrderLabsPage } from '../labs/OrderLabsPage';
import classes from './PatientPage.module.css';
import { getPatientPageTabs, patientPathPrefix } from './PatientPage.utils';
import { PatientSummarySkeleton, PatientTabContentSkeleton } from './PatientPageSkeleton';
import { PatientSectionTabs } from './PatientSectionTabs';

export function PatientPage(): JSX.Element {
  const navigate = useNavigate();
  const medplum = useMedplum();
  // The route id is known before the patient loads, so the layout and tabs can render straight away.
  const { patientId = '' } = useParams();
  const membership = medplum.getProjectMembership();
  const [outcome, setOutcome] = useState<OperationOutcome>();
  const patient = usePatient({ setOutcome });
  const [isLabsModalOpen, setIsLabsModalOpen] = useState(false);
  const PharmacyDialogComponent = usePharmacyDialog();
  const { hasAccess: hasDoseSpotAccess } = useDoseSpotAccess();
  const tabs = getPatientPageTabs(membership, { hasDoseSpotAccess });
  const resolvedTabs = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        label: t.label,
        value: (t.url ? t.url.replace('%patient.id', patientId) : t.id) || t.id,
      })),
    [patientId, tabs]
  );

  const handleCloseLabsModal = useCallback(() => {
    setIsLabsModalOpen(false);
  }, []);

  const sections = useMemo(
    () =>
      getDefaultSections(() => setIsLabsModalOpen(true)).map((s) =>
        s.key === 'pharmacies' ? createPharmaciesSection(PharmacyDialogComponent) : s
      ),
    [setIsLabsModalOpen, PharmacyDialogComponent]
  );

  if (outcome && !isOk(outcome)) {
    return (
      <Document>
        <OperationOutcomeAlert outcome={outcome} />
      </Document>
    );
  }

  const loaded = patient?.id ? patient : undefined;

  return (
    <>
      <div key={patientId} className={classes.container} aria-busy={!loaded}>
        <div className={classes.sidebar}>
          <ScrollArea className={classes.scrollArea}>
            {loaded ? (
              <PatientSummary
                patient={loaded}
                onClickResource={(resource) =>
                  navigate(`/Patient/${patientId}/${resource.resourceType}/${resource.id}`)?.catch(console.error)
                }
                sections={sections}
              />
            ) : (
              <PatientSummarySkeleton />
            )}
          </ScrollArea>
        </div>

        <div className={classes.content}>
          <PatientSectionTabs baseUrl={patientPathPrefix(patientId)} tabs={resolvedTabs} />
          <div className={classes.contentBody}>{loaded ? <Outlet /> : <PatientTabContentSkeleton />}</div>
        </div>
      </div>
      <Modal opened={isLabsModalOpen} onClose={handleCloseLabsModal} size="xl" centered title="Order Labs">
        <OrderLabsPage onSubmitLabOrder={handleCloseLabsModal} />
      </Modal>
    </>
  );
}
