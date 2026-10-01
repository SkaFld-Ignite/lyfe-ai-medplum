// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert } from '@mantine/core';
import type { AllergyIntolerance } from '@medplum/fhirtypes';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { JSX } from 'react';
import { Fragment, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { RecordBadge } from '../../../components/patient-shell/PatientRecordRow';
import { PatientRecordRow, ToneBadge } from '../../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../../components/patient-shell/PatientTabShell';
import { ShellToolbar } from '../../../components/patient-shell/ShellToolbar';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatientResources } from '../../../hooks/usePatientResources';
import { formatFhirDate } from '../../../utils/clinic-time';
import { clinicalStatusTone, conceptLabel, humanize, matchesQuery, severityTone } from './section-utils';

/**
 * The Lyfe "Allergies" section: each allergy with its reaction, severity and criticality.
 * @returns The allergies tab.
 */
export function AllergiesTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const { items, loading, error } = usePatientResources('AllergyIntolerance', patientId);
  const [query, setQuery] = useState('');

  const allergies = useMemo(
    () =>
      items.filter(
        (a) =>
          a.verificationStatus?.coding?.[0]?.code !== 'entered-in-error' &&
          matchesQuery(query, [
            conceptLabel(a.code),
            ...(a.reaction ?? []).flatMap((r) => r.manifestation?.map(conceptLabel) ?? []),
          ])
      ),
    [items, query]
  );

  const row = (a: AllergyIntolerance): JSX.Element => {
    const status = a.clinicalStatus?.coding?.[0]?.code;
    const verification = a.verificationStatus?.coding?.[0]?.code;
    const reactions = (a.reaction ?? []).flatMap((r) => r.manifestation?.map(conceptLabel) ?? []).filter(Boolean);
    const severity = a.reaction?.find((r) => r.severity)?.severity;
    const badges: RecordBadge[] = [];
    if (verification === 'unconfirmed' || verification === 'presumed') {
      badges.push({ label: 'Unverified', tone: 'amber' });
    }
    badges.push({ label: humanize(status) ?? 'Active', tone: clinicalStatusTone(status) });
    badges.push({ label: 'From DrChrono', tone: 'emerald' });
    const details: { key: string; node: JSX.Element }[] = [];
    if (reactions.length > 0) {
      details.push({
        key: 'reaction',
        node: (
          <>
            <b>Reaction:</b> {reactions.join(', ')}
          </>
        ),
      });
    }
    if (severity) {
      details.push({
        key: 'severity',
        node: (
          <>
            <b>Severity:</b> <ToneBadge label={humanize(severity)} tone={severityTone(severity)} />
          </>
        ),
      });
    }
    if (a.criticality) {
      details.push({
        key: 'criticality',
        node: (
          <>
            <b>Criticality:</b> {humanize(a.criticality)}
          </>
        ),
      });
    }
    return (
      <PatientRecordRow
        key={a.id}
        icon={<IconAlertTriangle size={20} />}
        title={conceptLabel(a.code) ?? 'Unnamed allergy'}
        badges={badges}
        meta={[
          formatFhirDate(a.meta?.lastUpdated, timeZone) &&
            `Last Updated: ${formatFhirDate(a.meta?.lastUpdated, timeZone)}`,
        ]}
        description={
          details.length > 0 ? (
            <>
              {details.map((detail, i) => (
                <Fragment key={detail.key}>
                  {i > 0 && ' · '}
                  {detail.node}
                </Fragment>
              ))}
            </>
          ) : undefined
        }
        actionLabel="Details"
        onAction={() => navigate(`/Patient/${patientId}/AllergyIntolerance/${a.id}`)?.catch(console.error)}
      />
    );
  };

  return (
    <PatientTabShell
      icon={<IconAlertTriangle size={20} />}
      title="Allergies"
      count={loading ? undefined : allergies.length}
      loading={loading}
      toolbar={
        <ShellToolbar search={{ value: query, onChange: setQuery, placeholder: 'Search allergies or reactions...' }} />
      }
      empty={
        allergies.length === 0
          ? {
              icon: <IconAlertTriangle size={28} />,
              title: items.length === 0 ? 'No allergies on record' : 'No allergies match',
              description: items.length === 0 ? 'Verify allergies with the patient.' : 'Try another search.',
            }
          : undefined
      }
    >
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} m="md">
          {error}
        </Alert>
      )}
      {allergies.map(row)}
    </PatientTabShell>
  );
}
