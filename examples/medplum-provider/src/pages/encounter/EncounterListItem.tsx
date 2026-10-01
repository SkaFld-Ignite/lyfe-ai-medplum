// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Group, Stack, Text } from '@mantine/core';
import { getDisplayString, isReference } from '@medplum/core';
import type { Encounter, Practitioner } from '@medplum/fhirtypes';
import { MedplumLink, useResource } from '@medplum/react';
import { IconChevronRight, IconStethoscope, IconVideo } from '@tabler/icons-react';
import cx from 'clsx';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import { getDataSource } from '../../utils/patient-timeline';
import classes from './EncounterListItem.module.css';

interface EncounterListItemProps {
  encounter: Encounter;
  selectedEncounterId: string | undefined;
  getItemUri: (encounter: Encounter) => string;
}

export function EncounterListItem({ encounter, selectedEncounterId, getItemUri }: EncounterListItemProps): JSX.Element {
  const isSelected = selectedEncounterId === encounter.id;
  const timeZone = useClinicTimeZone();

  const practitionerRef = encounter.participant
    ?.map((p) => p.individual)
    .find((ref) => isReference<Practitioner>(ref, 'Practitioner'));
  const practitioner = useResource(practitionerRef);

  const title = encounter.type?.[0]?.text ?? encounter.type?.[0]?.coding?.[0]?.display ?? 'Visit';
  const start = formatFhirDate(encounter.period?.start, timeZone);
  const end = formatFhirDate(encounter.period?.end, timeZone);
  const periodLine = start && end && end !== start ? `${start} – ${end}` : start;
  const practitionerLine = practitioner ? getDisplayString(practitioner) : practitionerRef?.display;
  const virtual = encounter.class?.code === 'VR';
  const fromDrChrono = getDataSource(encounter) === 'drchrono';

  return (
    <div className={classes.itemWrapper}>
      <MedplumLink to={getItemUri(encounter)} underline="never">
        <Group
          align="flex-start"
          wrap="nowrap"
          gap={12}
          className={cx(classes.contentContainer, {
            [classes.selected]: isSelected,
          })}
        >
          <span className={classes.icon}>{virtual ? <IconVideo size={18} /> : <IconStethoscope size={18} />}</span>
          <Stack gap={5} flex={1} miw={0}>
            <Text fw={600} size="sm" className={classes.title}>
              {title}
            </Text>
            <Group gap={6}>
              <Badge variant="light" color={getStatusColor(encounter.status)} size="sm" radius="sm">
                {getStatusDisplay(encounter.status)}
              </Badge>
              {fromDrChrono && (
                <Badge variant="light" color="teal" size="sm" radius="sm" tt="none">
                  From DrChrono
                </Badge>
              )}
            </Group>
            {(periodLine || practitionerLine) && (
              <Text className={classes.meta}>{[periodLine, practitionerLine].filter(Boolean).join(' · ')}</Text>
            )}
          </Stack>
          <IconChevronRight size={16} className={classes.chevron} />
        </Group>
      </MedplumLink>
    </div>
  );
}

function getStatusDisplay(status: Encounter['status'] | undefined): string {
  if (!status) {
    return 'Unknown';
  }
  return status
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getStatusColor(status: Encounter['status'] | undefined): string {
  if (status === 'finished') {
    return 'green';
  }
  if (status === 'cancelled' || status === 'entered-in-error') {
    return 'red';
  }
  if (status === 'planned' || status === 'arrived' || status === 'triaged' || status === 'in-progress') {
    return 'blue';
  }
  return 'gray';
}
