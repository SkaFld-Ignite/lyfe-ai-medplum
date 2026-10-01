// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Badge, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { formatAddress } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import { ResourceAvatar, ResourceName } from '@medplum/react';
import {
  IconBuildingHospital,
  IconCake,
  IconCalendar,
  IconMapPin,
  IconPhone,
  IconStethoscope,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { formatDob, getAge, getContact, getDisplayName, getMrn } from '../patients/patient-roster-utils';
import classes from './PatientIdentityCard.module.css';

export interface PatientIdentityCardProps {
  patient: Patient;
  /** The clinic's IANA zone, which decides the patient's age today. */
  timeZone: string;
}

function genderLabel(gender: Patient['gender']): string | undefined {
  switch (gender) {
    case 'female':
      return 'Female';
    case 'male':
      return 'Male';
    case 'other':
      return 'Other';
    case 'unknown':
      return 'Unknown';
    default:
      return undefined;
  }
}

function InfoRow(props: { icon: ReactNode; label: string; children: ReactNode; tone: string }): JSX.Element {
  return (
    <Group gap="xs" wrap="nowrap" className={classes.infoRow}>
      <Box className={classes.infoIcon} data-tone={props.tone}>
        {props.icon}
      </Box>
      <Box miw={0} flex={1}>
        <Text className={classes.infoLabel}>{props.label}</Text>
        <Text size="xs" fw={500} truncate="end">
          {props.children}
        </Text>
      </Box>
    </Group>
  );
}

/**
 * The Lyfe patient identity card at the top of the patient sidebar: avatar with status, name and
 * MRN, gender, age and date of birth, a call link, and the patient's provider, clinic and address.
 * @param props - The patient and clinic time zone.
 * @returns The identity card.
 */
export function PatientIdentityCard(props: PatientIdentityCardProps): JSX.Element {
  const { patient, timeZone } = props;
  const name = getDisplayName(patient);
  const mrn = getMrn(patient);
  const gender = genderLabel(patient.gender);
  const age = getAge(patient.birthDate, timeZone);
  const { phone } = getContact(patient);
  const active = patient.active !== false;
  const deceased = Boolean(patient.deceasedBoolean || patient.deceasedDateTime);
  const provider = patient.generalPractitioner?.[0];
  const clinic = patient.managingOrganization;
  const address = patient.address?.[0] ? formatAddress(patient.address[0]) : undefined;

  let status = { label: 'Active', color: 'green' };
  if (deceased) {
    status = { label: 'Deceased', color: 'gray' };
  } else if (!active) {
    status = { label: 'Inactive', color: 'gray' };
  }

  return (
    <Stack gap="sm" className={classes.card} data-testid="patient-identity">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box className={classes.avatarWrap} data-gender={patient.gender}>
          <ResourceAvatar value={patient} size={52} radius="xl" className={classes.avatar} />
          <span className={classes.statusDot} data-status={status.label.toLowerCase()} aria-hidden />
        </Box>
        <Stack gap={4} miw={0} pt={2}>
          <Tooltip label={name} openDelay={400}>
            <Text component="h1" className={classes.name} truncate="end">
              {name}
            </Text>
          </Tooltip>
          {mrn && (
            <Text span className={classes.mrn} aria-label={`MRN ${mrn}`}>
              {mrn}
            </Text>
          )}
        </Stack>
      </Group>

      <Group gap={10} className={classes.metaRow}>
        {gender && (
          <Text span className={classes.genderChip} data-gender={patient.gender}>
            {gender}
          </Text>
        )}
        {age !== '—' && (
          <Group gap={4} component="span" c="dimmed">
            <IconCake size={12} />
            {age}y
          </Group>
        )}
        {patient.birthDate && (
          <Group gap={4} component="span" c="dimmed">
            <IconCalendar size={12} />
            {formatDob(patient.birthDate)}
          </Group>
        )}
      </Group>

      {phone && (
        <Anchor href={`tel:${phone}`} underline="never" className={classes.phone}>
          <Group gap={8} wrap="nowrap">
            <Box className={classes.infoIcon} data-tone="blue">
              <IconPhone size={12} />
            </Box>
            <Text size="xs" ff="monospace">
              {phone}
            </Text>
          </Group>
          <Text span className={classes.callHint}>
            Call
          </Text>
        </Anchor>
      )}

      <Group gap={6}>
        <Badge size="sm" variant="light" color={status.color} leftSection={<span className={classes.badgeDot} />}>
          {status.label}
        </Badge>
      </Group>

      {(provider || clinic || address) && (
        <Stack gap={0} className={classes.infoStack}>
          {provider && (
            <InfoRow icon={<IconStethoscope size={14} />} label="Provider" tone="violet">
              <ResourceName value={provider} />
            </InfoRow>
          )}
          {clinic && (
            <InfoRow icon={<IconBuildingHospital size={14} />} label="Clinic" tone="teal">
              <ResourceName value={clinic} />
            </InfoRow>
          )}
          {address && (
            <InfoRow icon={<IconMapPin size={14} />} label="Address" tone="blue">
              {address}
            </InfoRow>
          )}
        </Stack>
      )}
    </Stack>
  );
}
