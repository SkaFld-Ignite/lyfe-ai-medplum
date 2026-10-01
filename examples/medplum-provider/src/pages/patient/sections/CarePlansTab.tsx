// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert } from '@mantine/core';
import type { CarePlan } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconClipboardList, IconHeartbeat } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CategorySection } from '../../../components/patient-shell/CategorySection';
import type { RecordBadge } from '../../../components/patient-shell/PatientRecordRow';
import { PatientRecordRow } from '../../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../../components/patient-shell/PatientTabShell';
import type { ShellView } from '../../../components/patient-shell/ShellToolbar';
import { ShellToolbar } from '../../../components/patient-shell/ShellToolbar';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatientResources } from '../../../hooks/usePatientResources';
import { formatFhirDate } from '../../../utils/clinic-time';
import { clinicalStatusTone, conceptLabel, humanize, matchesQuery, sourceBadge } from './section-utils';

const GROUPS: { key: string; title: string; statuses: (string | undefined)[] }[] = [
  { key: 'active', title: 'Active', statuses: ['active', 'on-hold', 'draft'] },
  { key: 'completed', title: 'Completed', statuses: ['completed'] },
  { key: 'other', title: 'Other', statuses: ['revoked', 'unknown', undefined] },
];
const PARAMS = { _sort: '-_lastUpdated' };
const OPTIONS = { allSources: true };

/**
 * The care plan's name: its title, else its first category.
 * @param plan - The care plan.
 * @returns The name.
 */
function planTitle(plan: CarePlan): string {
  return plan.title ?? conceptLabel(plan.category?.[0]) ?? 'Care plan';
}

/**
 * The Lyfe "Care Plans" section: the patient's care plans from every source, grouped by status
 * or listed, each opening its Medplum record.
 * @returns The care plans tab.
 */
export function CarePlansTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const { items, loading, error } = usePatientResources('CarePlan', patientId, PARAMS, OPTIONS);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ShellView>('grouped');

  const plans = useMemo(
    () =>
      items.filter(
        (p) =>
          p.status !== 'entered-in-error' &&
          matchesQuery(query, [planTitle(p), p.description, ...(p.category ?? []).map(conceptLabel)])
      ),
    [items, query]
  );

  const row = (plan: CarePlan): JSX.Element => {
    const badges: RecordBadge[] = [
      { label: humanize(plan.status) ?? 'Unknown', tone: clinicalStatusTone(plan.status) },
    ];
    if (plan.intent && plan.intent !== 'plan') {
      badges.push({ label: humanize(plan.intent) ?? plan.intent, tone: 'indigo' });
    }
    badges.push(sourceBadge(plan));
    const start = formatFhirDate(plan.period?.start, timeZone);
    const end = formatFhirDate(plan.period?.end, timeZone);
    const activities = plan.activity?.length ?? 0;
    return (
      <PatientRecordRow
        key={plan.id}
        icon={<IconHeartbeat size={20} />}
        title={planTitle(plan)}
        badges={badges}
        meta={[
          start && `${start} – ${end ?? 'ongoing'}`,
          activities > 0 && `${activities} ${activities === 1 ? 'activity' : 'activities'}`,
          formatFhirDate(plan.meta?.lastUpdated, timeZone) &&
            `Last Updated: ${formatFhirDate(plan.meta?.lastUpdated, timeZone)}`,
        ]}
        description={plan.description}
        actionLabel="Details"
        onAction={() => navigate(`/Patient/${patientId}/CarePlan/${plan.id}`)?.catch(console.error)}
      />
    );
  };

  return (
    <PatientTabShell
      icon={<IconClipboardList size={20} />}
      title="Care Plans"
      count={loading ? undefined : plans.length}
      description={loading ? 'Loading…' : `Care plans on file (${items.length} total)`}
      loading={loading}
      toolbar={
        <ShellToolbar
          search={{ value: query, onChange: setQuery, placeholder: 'Search care plans...' }}
          view={{ value: view, onChange: setView }}
        />
      }
      empty={
        plans.length === 0
          ? {
              icon: <IconClipboardList size={28} />,
              title: items.length === 0 ? 'No care plans on record' : 'No care plans match',
              description: items.length === 0 ? 'Care plans from the HIE will appear here.' : 'Try another search.',
            }
          : undefined
      }
    >
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} m="md">
          {error}
        </Alert>
      )}
      {view === 'grouped'
        ? GROUPS.map((group) => {
            const inGroup = plans.filter((p) => group.statuses.includes(p.status));
            return inGroup.length === 0 ? null : (
              <CategorySection
                key={group.key}
                title={group.title}
                count={inGroup.length}
                activeCount={group.key === 'active' ? inGroup.filter((p) => p.status === 'active').length : undefined}
              >
                {inGroup.map(row)}
              </CategorySection>
            );
          })
        : plans.map(row)}
    </PatientTabShell>
  );
}
