// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert } from '@mantine/core';
import type { Device } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconDeviceWatch } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { RecordBadge } from '../../../components/patient-shell/PatientRecordRow';
import { PatientRecordRow } from '../../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../../components/patient-shell/PatientTabShell';
import { ShellToolbar } from '../../../components/patient-shell/ShellToolbar';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatientResources } from '../../../hooks/usePatientResources';
import { formatFhirDate } from '../../../utils/clinic-time';
import { conceptLabel, humanize, matchesQuery, sourceBadge } from './section-utils';

const PARAMS = { _sort: '-_lastUpdated' };
const OPTIONS = { allSources: true };

/**
 * The device's name: its first device name, else its type.
 * @param device - The device.
 * @returns The name.
 */
function deviceTitle(device: Device): string {
  return device.deviceName?.[0]?.name ?? conceptLabel(device.type) ?? device.modelNumber ?? 'Device';
}

/**
 * The Lyfe "Devices" section: implants and equipment on file for the patient, from every source,
 * each opening its Medplum record.
 * @returns The devices tab.
 */
export function DevicesTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const { items, loading, error } = usePatientResources('Device', patientId, PARAMS, OPTIONS);
  const [query, setQuery] = useState('');

  const devices = useMemo(
    () =>
      items.filter(
        (d) =>
          d.status !== 'entered-in-error' &&
          matchesQuery(query, [deviceTitle(d), d.manufacturer, d.modelNumber, d.distinctIdentifier])
      ),
    [items, query]
  );

  return (
    <PatientTabShell
      icon={<IconDeviceWatch size={20} />}
      title="Devices"
      count={loading ? undefined : devices.length}
      description={loading ? 'Loading…' : `Implants and equipment on file (${items.length} total)`}
      loading={loading}
      toolbar={<ShellToolbar search={{ value: query, onChange: setQuery, placeholder: 'Search devices...' }} />}
      empty={
        devices.length === 0
          ? {
              icon: <IconDeviceWatch size={28} />,
              title: items.length === 0 ? 'No devices on record' : 'No devices match',
              description: items.length === 0 ? 'Devices from the HIE will appear here.' : 'Try another search.',
            }
          : undefined
      }
    >
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} m="md">
          {error}
        </Alert>
      )}
      {devices.map((device) => {
        const badges: RecordBadge[] = [];
        if (device.status) {
          badges.push({
            label: humanize(device.status) ?? device.status,
            tone: device.status === 'active' ? 'amber' : 'slate',
          });
        }
        badges.push(sourceBadge(device));
        return (
          <PatientRecordRow
            key={device.id}
            icon={<IconDeviceWatch size={20} />}
            title={deviceTitle(device)}
            badges={badges}
            meta={[
              device.manufacturer,
              device.modelNumber && `Model ${device.modelNumber}`,
              (device.serialNumber ?? device.distinctIdentifier) &&
                `Serial ${device.serialNumber ?? device.distinctIdentifier}`,
              formatFhirDate(device.meta?.lastUpdated, timeZone) &&
                `Last Updated: ${formatFhirDate(device.meta?.lastUpdated, timeZone)}`,
            ]}
            description={device.udiCarrier?.[0]?.deviceIdentifier && `UDI: ${device.udiCarrier[0].deviceIdentifier}`}
            actionLabel="Details"
            onAction={() => navigate(`/Patient/${patientId}/Device/${device.id}`)?.catch(console.error)}
          />
        );
      })}
    </PatientTabShell>
  );
}
