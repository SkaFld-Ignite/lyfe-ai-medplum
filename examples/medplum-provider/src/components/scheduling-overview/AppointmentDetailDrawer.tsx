// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Anchor,
  Avatar,
  Button,
  Drawer,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { MedplumLink } from '@medplum/react';
import {
  IconArrowLeft,
  IconCalendarEvent,
  IconMail,
  IconMapPin,
  IconPhone,
  IconStethoscope,
  IconUser,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import type { OverviewAppointment } from '../../utils/scheduling-overview';
import { formatLongDate, formatTime, getColorForKey, getInitials } from '../../utils/scheduling-overview';
import { StatusBadge, TypeIcon } from './AppointmentDisplay';

export interface AppointmentDetailDrawerProps {
  opened: boolean;
  /** The clinic's IANA zone, which the date and time are read in. */
  timeZone: string;
  /** The selected appointment, or undefined while it is being resolved. */
  row: OverviewAppointment | undefined;
  /** True while the appointment list is loading, so a missing row is shown as loading, not missing. */
  loading: boolean;
  onClose: () => void;
  onViewPatient: (patientId: string) => void;
}

/**
 * Right-hand drawer with an appointment's details and the patient's contact information.
 * @param props - The drawer props.
 * @returns The drawer.
 */
export function AppointmentDetailDrawer(props: AppointmentDetailDrawerProps): JSX.Element {
  const { opened, timeZone, row, loading, onClose, onViewPatient } = props;

  let content: JSX.Element;
  if (row) {
    content = <AppointmentDetailBody row={row} timeZone={timeZone} onClose={onClose} onViewPatient={onViewPatient} />;
  } else if (loading) {
    content = (
      <Stack gap="md" aria-busy="true" aria-label="Loading appointment">
        <Group>
          <Skeleton circle h={44} />
          <Stack gap={6} flex={1}>
            <Skeleton h={14} w="60%" />
            <Skeleton h={10} w="35%" />
          </Stack>
        </Group>
        <Skeleton h={140} radius="md" />
        <Skeleton h={90} radius="md" />
      </Stack>
    );
  } else {
    content = (
      <Text c="dimmed" size="sm">
        This appointment is not in the current calendar view. It may have been removed, or it is outside the dates
        shown.
      </Text>
    );
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={440}
      title={
        <Group gap="xs">
          <ActionIcon variant="subtle" color="gray" aria-label="Back" onClick={onClose}>
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Text fw={600}>Appointment</Text>
        </Group>
      }
    >
      {content}
    </Drawer>
  );
}

function AppointmentDetailBody({
  row,
  timeZone,
  onClose,
  onViewPatient,
}: {
  row: OverviewAppointment;
  timeZone: string;
  onClose: () => void;
  onViewPatient: (patientId: string) => void;
}): JSX.Element {
  const { appointment, patient } = row;
  const patientName = patient?.name ?? 'No patient';
  const hasContact = Boolean(patient?.email || patient?.phone || patient?.primaryProvider);

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="sm" wrap="nowrap" miw={0}>
          <Avatar size={44} radius="xl" color={getColorForKey(row.providerKey)}>
            {getInitials(patientName)}
          </Avatar>
          <Stack gap={0} miw={0}>
            <Title order={4} lineClamp={1}>
              {patientName}
            </Title>
            {patient?.mrn && (
              <Text size="xs" c="dimmed">
                MRN: {patient.mrn}
              </Text>
            )}
          </Stack>
        </Group>
        <StatusBadge status={appointment.status} />
      </Group>

      <Paper withBorder radius="md" p="md">
        <SectionTitle icon={<IconCalendarEvent size={14} />} title="Appointment Details" />
        <Stack gap={8} mt="sm">
          <DetailRow label="Date" value={formatLongDate(row.start, timeZone)} />
          <DetailRow
            label="Time"
            value={`${formatTime(row.start, timeZone)}${row.durationMinutes > 0 ? ` · ${row.durationMinutes} min` : ''}`}
          />
          <DetailRow
            label="Type"
            value={
              <Group gap={4} wrap="nowrap" justify="flex-end">
                <TypeIcon isVirtual={row.isVirtual} />
                {row.typeLabel}
              </Group>
            }
          />
          <DetailRow
            label="Provider"
            value={
              <Group gap={4} wrap="nowrap" justify="flex-end">
                <IconStethoscope size={14} aria-hidden />
                {row.providerName}
              </Group>
            }
          />
          {row.locationName && (
            <DetailRow
              label="Location"
              value={
                <Group gap={4} wrap="nowrap" justify="flex-end">
                  <IconMapPin size={14} aria-hidden />
                  {row.locationName}
                </Group>
              }
            />
          )}
          {row.reason && <LongField label="Reason" value={row.reason} />}
          {row.notes && <LongField label="Notes" value={row.notes} />}
        </Stack>
      </Paper>

      <Paper withBorder radius="md" p="md">
        <SectionTitle icon={<IconUser size={14} />} title="Patient Contact" />
        <Stack gap="xs" mt="sm">
          {patient?.email && <ContactRow icon={<IconMail size={14} />} text={patient.email} />}
          {patient?.phone && <ContactRow icon={<IconPhone size={14} />} text={patient.phone} />}
          {patient?.primaryProvider && (
            <ContactRow icon={<IconStethoscope size={14} />} text={`Primary: ${patient.primaryProvider}`} />
          )}
          {!hasContact && (
            <Text size="xs" c="dimmed">
              No contact information on file.
            </Text>
          )}
        </Stack>
      </Paper>

      <Anchor component={MedplumLink} to={`/Appointment/${appointment.id}`} size="sm">
        Open full appointment record
      </Anchor>

      <Group grow>
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
        <Button disabled={!patient} onClick={() => patient && onViewPatient(patient.id)}>
          View Patient
        </Button>
      </Group>
    </Stack>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }): JSX.Element {
  return (
    <Group gap={6}>
      <ThemeIcon variant="transparent" size="sm">
        {icon}
      </ThemeIcon>
      <Text size="sm" fw={600}>
        {title}
      </Text>
    </Group>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500} ta="right" component="div" truncate>
        {value}
      </Text>
    </Group>
  );
}

function LongField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Stack gap={2} pt={4}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </Stack>
  );
}

function ContactRow({ icon, text }: { icon: ReactNode; text: string }): JSX.Element {
  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon variant="light" color="gray" radius="xl" size={28}>
        {icon}
      </ThemeIcon>
      <Text size="sm" truncate>
        {text}
      </Text>
    </Group>
  );
}
