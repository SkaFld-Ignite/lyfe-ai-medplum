// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Group } from '@mantine/core';
import { getReferenceString } from '@medplum/core';
import type { Resource, ResourceType } from '@medplum/fhirtypes';
import { LinkTabs, MedplumLink, useMedplum } from '@medplum/react';
import { IconArrowLeft, IconFileDescription } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import formClasses from '../../components/patient-shell/LyfeForm.module.css';
import { ToneBadge } from '../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../components/patient-shell/PatientTabShell';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import { clinicalStatusTone, humanize, sourceBadge } from '../patient/sections/section-utils';
import { PATIENT_SECTIONS, resourceStatus, resourceTitle, resourceTypeLabel } from './resource-header';
import classes from './ResourcePage.module.css';
import { useResourceType } from './useResourceType';

const baseTabs = ['Details', 'Edit', 'History'];

export function ResourcePage(): JSX.Element | null {
  const navigate = useNavigate();
  const medplum = useMedplum();
  const timeZone = useClinicTimeZone();

  const project = medplum.getProject();
  const schedulingEnabled = project?.features?.includes('scheduling');

  const { patientId, resourceType, id } = useParams();
  const [resource, setResource] = useState<Resource | undefined>(undefined);

  useResourceType(resourceType, { onInvalidResourceType: () => navigate('..')?.catch(console.error) });

  useEffect(() => {
    if (resourceType && id) {
      medplum
        .readResource(resourceType as ResourceType, id)
        .then(setResource)
        .catch(console.error);
    }
  }, [medplum, resourceType, id, navigate]);

  const tabs = [...baseTabs];
  if (resourceType === 'HealthcareService' && schedulingEnabled) {
    tabs.push('Scheduling');
  }

  if (!resource) {
    return null;
  }

  // Inside a patient chart the tabs stay in the chart instead of jumping to the global record page.
  const baseUrl = patientId ? `/Patient/${patientId}/${resourceType}/${id}` : `/${resourceType}/${id}`;
  const section = patientId && resourceType ? PATIENT_SECTIONS[resourceType] : undefined;
  const status = resourceStatus(resource);
  const updated = formatFhirDate(resource.meta?.lastUpdated, timeZone);
  const source = sourceBadge(resource);

  return (
    <div className={classes.page} key={getReferenceString(resource)}>
      <PatientTabShell
        icon={<IconFileDescription size={20} />}
        title={resourceTitle(resource)}
        description={[resourceTypeLabel(resource.resourceType), updated && `Last updated ${updated}`]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <Group gap={6}>
            {status && <ToneBadge label={humanize(status) ?? status} tone={clinicalStatusTone(status)} />}
            {source.label !== 'Added in Lyfe' && <ToneBadge {...source} />}
          </Group>
        }
        toolbar={
          <Group justify="space-between" wrap="nowrap">
            <LinkTabs variant="pills" baseUrl={baseUrl} tabs={tabs} classNames={classes} />
            {section && (
              <Anchor component={MedplumLink} to={`/Patient/${patientId}/${section.url}`} className={classes.back}>
                <IconArrowLeft size={14} />
                All {section.label.toLowerCase()}
              </Anchor>
            )}
          </Group>
        }
      >
        <div className={`${classes.body} ${formClasses.form}`}>
          <Outlet />
        </div>
      </PatientTabShell>
    </div>
  );
}
