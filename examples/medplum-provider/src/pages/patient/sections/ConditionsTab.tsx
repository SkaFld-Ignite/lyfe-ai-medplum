// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert } from '@mantine/core';
import type { Condition } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconHeart, IconHeartbeat } from '@tabler/icons-react';
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
import { clinicalStatusTone, conceptCode, conceptLabel, humanize, matchesQuery, severityTone } from './section-utils';

const GROUPS: { key: string; title: string; codes: (string | undefined)[] }[] = [
  { key: 'active', title: 'Active', codes: ['active', 'recurrence', 'relapse', undefined] },
  { key: 'resolved', title: 'Resolved', codes: ['resolved', 'remission'] },
  { key: 'inactive', title: 'Inactive', codes: ['inactive'] },
];

/**
 * The Lyfe "Patient Conditions" section: the patient's DrChrono conditions, grouped by status or
 * listed, with each one opening its Medplum record.
 * @returns The conditions tab.
 */
export function ConditionsTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const { items, loading, error } = usePatientResources('Condition', patientId, { _sort: '-onset-date' });
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ShellView>('grouped');

  const conditions = useMemo(
    () =>
      items.filter(
        (c) =>
          c.verificationStatus?.coding?.[0]?.code !== 'entered-in-error' &&
          matchesQuery(query, [conceptLabel(c.code), conceptCode(c.code)])
      ),
    [items, query]
  );

  const row = (c: Condition): JSX.Element => {
    const status = c.clinicalStatus?.coding?.[0]?.code;
    const severity = conceptLabel(c.severity);
    const badges: RecordBadge[] = [{ label: humanize(status) ?? 'Active', tone: clinicalStatusTone(status) }];
    if (severity) {
      badges.push({ label: severity, tone: severityTone(severity) });
    }
    badges.push({ label: 'From DrChrono', tone: 'emerald' });
    const code = conceptCode(c.code);
    return (
      <PatientRecordRow
        key={c.id}
        icon={<IconHeartbeat size={20} />}
        title={conceptLabel(c.code) ?? 'Unnamed condition'}
        badges={badges}
        meta={[
          formatFhirDate(c.onsetDateTime ?? c.onsetPeriod?.start ?? c.recordedDate, timeZone) &&
            `Onset: ${formatFhirDate(c.onsetDateTime ?? c.onsetPeriod?.start ?? c.recordedDate, timeZone)}`,
          formatFhirDate(c.meta?.lastUpdated, timeZone) &&
            `Last Updated: ${formatFhirDate(c.meta?.lastUpdated, timeZone)}`,
        ]}
        description={code && code !== conceptLabel(c.code) ? `ICD-10: ${code}` : undefined}
        actionLabel="Details"
        onAction={() => navigate(`/Patient/${patientId}/Condition/${c.id}`)?.catch(console.error)}
      />
    );
  };

  return (
    <PatientTabShell
      icon={<IconHeart size={20} />}
      title="Patient Conditions"
      count={loading ? undefined : conditions.length}
      description={loading ? 'Loading…' : `Medical conditions from DrChrono (${items.length} total)`}
      loading={loading}
      toolbar={
        <ShellToolbar
          search={{ value: query, onChange: setQuery, placeholder: 'Search conditions or ICD-10 codes...' }}
          view={{ value: view, onChange: setView }}
        />
      }
      empty={
        conditions.length === 0
          ? {
              icon: <IconHeart size={28} />,
              title: items.length === 0 ? 'No conditions on record' : 'No conditions match',
              description:
                items.length === 0 ? 'Conditions imported from DrChrono will appear here.' : 'Try another search.',
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
            const inGroup = conditions.filter((c) => group.codes.includes(c.clinicalStatus?.coding?.[0]?.code));
            return inGroup.length === 0 ? null : (
              <CategorySection
                key={group.key}
                title={group.title}
                count={inGroup.length}
                activeCount={group.key === 'active' ? inGroup.length : undefined}
              >
                {inGroup.map(row)}
              </CategorySection>
            );
          })
        : conditions.map(row)}
    </PatientTabShell>
  );
}
