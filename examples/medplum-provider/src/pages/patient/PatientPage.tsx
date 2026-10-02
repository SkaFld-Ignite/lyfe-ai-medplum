// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ScrollArea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { isOk } from '@medplum/core';
import type { OperationOutcome } from '@medplum/fhirtypes';
import { Document, OperationOutcomeAlert, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import { PatientIdentityCard } from '../../components/patient-detail/PatientIdentityCard';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { useDoseSpotAccess } from '../../hooks/useDoseSpotAccess';
import { usePatient } from '../../hooks/usePatient';
import classes from './PatientPage.module.css';
import { getPatientPageTabs, patientPathPrefix } from './PatientPage.utils';
import { PatientIdentitySkeleton, PatientTabContentSkeleton } from './PatientPageSkeleton';
import { PatientSectionTabs } from './PatientSectionTabs';
import { SidebarSyncButton } from './SidebarSyncButton';

/** Below this width the sidebar collapses and the sections become a horizontal bar. */
const SIDEBAR_BREAKPOINT = '(max-width: 62em)';

/**
 * The patient chart, laid out like the Lyfe patient details page: a sidebar with the patient's
 * identity and a vertical menu of sections, and the selected section beside it. Every section is
 * the same Medplum route as before; the clinical summary lives in the Overview section.
 * @returns The patient page.
 */
export function PatientPage(): JSX.Element {
  const medplum = useMedplum();
  // The route id is known before the patient loads, so the layout and menu can render straight away.
  const { patientId = '' } = useParams();
  const membership = medplum.getProjectMembership();
  const [outcome, setOutcome] = useState<OperationOutcome>();
  const patient = usePatient({ setOutcome });
  const timeZone = useClinicTimeZone();
  const narrow = useMediaQuery(SIDEBAR_BREAKPOINT);
  const { hasAccess: hasDoseSpotAccess } = useDoseSpotAccess();
  const tabs = getPatientPageTabs(membership, { hasDoseSpotAccess });
  const resolvedTabs = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        label: t.label,
        aliases: t.aliases,
        value: (t.url ? t.url.replace('%patient.id', patientId) : t.id) || t.id,
      })),
    [patientId, tabs]
  );

  if (outcome && !isOk(outcome)) {
    return (
      <Document>
        <OperationOutcomeAlert outcome={outcome} />
      </Document>
    );
  }

  const loaded = patient?.id ? patient : undefined;
  const baseUrl = patientPathPrefix(patientId);

  return (
    <div key={patientId} className={classes.container} aria-busy={!loaded} data-narrow={narrow || undefined}>
      {!narrow && (
        <aside className={classes.sidebar}>
          <ScrollArea className={classes.scrollArea} scrollbarSize={6}>
            {loaded ? <PatientIdentityCard patient={loaded} timeZone={timeZone} /> : <PatientIdentitySkeleton />}
            {/* Between the identity block and the section menu — where the
                previous platform put it, and where people look for it. Only
                once the patient has loaded, since it is keyed on their id. */}
            {loaded && <SidebarSyncButton patientId={patientId} />}
            <PatientSectionTabs baseUrl={baseUrl} tabs={resolvedTabs} orientation="vertical" />
          </ScrollArea>
        </aside>
      )}

      <div className={classes.content}>
        {narrow && (
          <>
            {loaded && <PatientIdentityCard patient={loaded} timeZone={timeZone} />}
            <PatientSectionTabs baseUrl={baseUrl} tabs={resolvedTabs} />
          </>
        )}
        <div className={classes.contentBody}>{loaded ? <Outlet /> : <PatientTabContentSkeleton />}</div>
      </div>
    </div>
  );
}
