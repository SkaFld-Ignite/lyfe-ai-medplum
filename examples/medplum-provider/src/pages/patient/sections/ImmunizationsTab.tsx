// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Stack, Text } from '@mantine/core';
import type { Immunization } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconShield, IconVaccine } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CategorySection } from '../../../components/patient-shell/CategorySection';
import { PatientRecordRow, ToneBadge } from '../../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../../components/patient-shell/PatientTabShell';
import type { ShellView } from '../../../components/patient-shell/ShellToolbar';
import { ShellToolbar } from '../../../components/patient-shell/ShellToolbar';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatientResources } from '../../../hooks/usePatientResources';
import { formatFhirDate } from '../../../utils/clinic-time';
import { clinicalStatusTone, conceptLabel, humanize, matchesQuery } from './section-utils';

function details(i: Immunization): string | undefined {
  const parts = [
    i.lotNumber && `Lot: ${i.lotNumber}`,
    conceptLabel(i.site) && `Site: ${conceptLabel(i.site)}`,
    conceptLabel(i.route) && `Route: ${conceptLabel(i.route)}`,
    i.doseQuantity?.value !== undefined && `Dose: ${i.doseQuantity.value} ${i.doseQuantity.unit ?? ''}`.trim(),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The Lyfe "Immunizations" section: doses grouped by vaccine, or listed.
 * @returns The immunizations tab.
 */
export function ImmunizationsTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const { items, loading, error } = usePatientResources('Immunization', patientId, { _sort: '-date' });
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ShellView>('grouped');

  const immunizations = useMemo(
    () => items.filter((i) => i.status !== 'entered-in-error' && matchesQuery(query, [conceptLabel(i.vaccineCode)])),
    [items, query]
  );
  const groups = useMemo(() => {
    const map = new Map<string, Immunization[]>();
    for (const i of immunizations) {
      const name = conceptLabel(i.vaccineCode) ?? 'Unnamed vaccine';
      map.set(name, [...(map.get(name) ?? []), i]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [immunizations]);

  const open = (i: Immunization) => () => navigate(`/Patient/${patientId}/Immunization/${i.id}`)?.catch(console.error);

  return (
    <PatientTabShell
      icon={<IconShield size={20} />}
      title="Immunizations"
      count={loading ? undefined : immunizations.length}
      loading={loading}
      toolbar={
        <ShellToolbar
          search={{ value: query, onChange: setQuery, placeholder: 'Search vaccines...' }}
          view={{ value: view, onChange: setView }}
        />
      }
      empty={
        immunizations.length === 0
          ? {
              icon: <IconShield size={28} />,
              title: items.length === 0 ? 'No immunizations on record' : 'No immunizations match',
              description:
                items.length === 0 ? 'Vaccines imported from DrChrono will appear here.' : 'Try another search.',
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
        ? groups.map(([name, doses]) => {
            const ordered = [...doses].sort((a, b) =>
              (a.occurrenceDateTime ?? '').localeCompare(b.occurrenceDateTime ?? '')
            );
            const completed = doses.filter((d) => d.status === 'completed').length;
            return (
              <CategorySection
                key={name}
                title={name}
                count={doses.length}
                pills={
                  <ToneBadge label={`${completed} ${completed === 1 ? 'dose' : 'doses'} completed`} tone="emerald" />
                }
              >
                <Stack gap={4} p="md">
                  {ordered.map((dose, index) => (
                    <Text key={dose.id} size="sm">
                      <b>{index === ordered.length - 1 && ordered.length > 1 ? 'Booster' : `Dose ${index + 1}`}:</b>{' '}
                      {formatFhirDate(dose.occurrenceDateTime, timeZone) ?? dose.occurrenceString ?? 'Date unknown'}
                      {details(dose) && <Text span c="dimmed" size="sm">{` · ${details(dose)}`}</Text>}
                    </Text>
                  ))}
                </Stack>
              </CategorySection>
            );
          })
        : immunizations.map((i) => (
            <PatientRecordRow
              key={i.id}
              icon={<IconVaccine size={20} />}
              title={conceptLabel(i.vaccineCode) ?? 'Unnamed vaccine'}
              badges={[
                { label: humanize(i.status) ?? 'Completed', tone: clinicalStatusTone(i.status) },
                { label: 'From DrChrono', tone: 'emerald' },
              ]}
              meta={[
                formatFhirDate(i.occurrenceDateTime, timeZone) &&
                  `Date Given: ${formatFhirDate(i.occurrenceDateTime, timeZone)}`,
              ]}
              description={details(i)}
              actionLabel="Details"
              onAction={open(i)}
            />
          ))}
    </PatientTabShell>
  );
}
