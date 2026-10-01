// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, Skeleton, Stack, Text } from '@mantine/core';
import { MedplumLink, ResourceName, useSearchResources } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconUser } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import { pickCriticalResults } from '../../utils/dashboard';
import { DRCHRONO_SOURCE_TAG } from '../../utils/data-source';
import { OverviewSection } from '../patient-overview/OverviewSection';
import { ToneBadge } from '../patient-shell/PatientRecordRow';
import { EmptyState } from '../patient-shell/PatientTabShell';
import classes from './Dashboard.module.css';

const RESULT_LIMIT = 5;
const LAB_QUERY = {
  category: 'laboratory',
  status: 'final',
  _tag: DRCHRONO_SOURCE_TAG,
  _sort: '-date',
  _count: '100',
};
const FLAG_LABEL = { H: 'High', L: 'Low', A: 'Abnormal' } as const;

/**
 * The newest flagged lab results across patients, each opening the patient's Labs section.
 * @returns The critical results card.
 */
export function CriticalResults(): JSX.Element {
  const timeZone = useClinicTimeZone();
  const [observations, loading] = useSearchResources('Observation', LAB_QUERY);
  const results = pickCriticalResults(observations ?? [], RESULT_LIMIT);

  return (
    <OverviewSection
      icon={<IconAlertTriangle size={16} />}
      tone="rose"
      title="Critical Results"
      subtitle="Lab and imaging results requiring immediate review"
      right={
        !loading &&
        (results.length === 0 ? (
          <ToneBadge label="All clear" tone="emerald" />
        ) : (
          <ToneBadge label={`${results.length} flagged`} tone="rose" />
        ))
      }
    >
      <div className={classes.panelBody}>
        {loading && (
          <Stack gap="xs">
            <Skeleton h={52} radius="md" />
            <Skeleton h={52} radius="md" />
          </Stack>
        )}
        {!loading && results.length === 0 && (
          <EmptyState
            compact
            icon={<IconCircleCheck size={24} />}
            title="No critical results"
            description="All patient results are within normal ranges"
          />
        )}
        {!loading && results.length > 0 && (
          <div className={classes.resultGrid}>
            {results.map((result) => {
              const patientId = result.patientReference?.replace('Patient/', '');
              return (
                <MedplumLink
                  key={result.id}
                  to={patientId ? `/Patient/${patientId}/labs` : '/'}
                  className={classes.row}
                  underline="never"
                >
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text className={classes.rowTitle}>{result.label}</Text>
                    {result.flag && <ToneBadge label={FLAG_LABEL[result.flag]} tone="rose" />}
                  </Group>
                  <Group gap={12} className={classes.rowMeta}>
                    <span className={classes.resultValue}>
                      {result.display}
                      {result.unit && ` ${result.unit}`}
                    </span>
                    {result.patientReference && (
                      <span>
                        <IconUser size={12} />
                        <ResourceName value={{ reference: result.patientReference }} />
                      </span>
                    )}
                    {result.date && <span>{formatFhirDate(result.date.toISOString(), timeZone)}</span>}
                  </Group>
                </MedplumLink>
              );
            })}
          </div>
        )}
      </div>
    </OverviewSection>
  );
}
