// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Avatar,
  Box,
  Button,
  CloseButton,
  Divider,
  Group,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconCalendarOff, IconClock, IconSearch, IconUsers } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type { OverviewAppointment } from '../../utils/scheduling-overview';
import {
  formatLongDate,
  formatTime,
  getAppointmentsForDay,
  getColorForKey,
  getInitials,
  groupByProvider,
  searchAppointments,
  toLocalIsoDate,
} from '../../utils/scheduling-overview';
import { StatusIcon, TypeIcon } from './AppointmentDisplay';
import classes from './SchedulingOverview.module.css';

export type DayGrouping = 'provider' | 'time';

export interface DayAppointmentsPanelProps {
  date: Date;
  /** Appointments already narrowed by the page filters; the panel picks out `date`. */
  appointments: OverviewAppointment[];
  loading?: boolean;
  onSelectAppointment: (row: OverviewAppointment) => void;
}

/**
 * Side panel listing one day's appointments, grouped by provider or sorted by time, with a
 * search box scoped to that day.
 * @param props - The panel props.
 * @returns The day schedule panel.
 */
export function DayAppointmentsPanel(props: DayAppointmentsPanelProps): JSX.Element {
  const { date, appointments, loading, onSelectAppointment } = props;
  const [grouping, setGrouping] = useState<DayGrouping>('provider');

  // The search belongs to the day it was typed on: switching days starts with a clean search,
  // while the grouping choice is kept.
  const dayKey = toLocalIsoDate(date);
  const [search, setSearch] = useState({ dayKey, query: '' });
  const query = search.dayKey === dayKey ? search.query : '';
  const setQuery = (value: string): void => setSearch({ dayKey, query: value });

  const dayAppointments = useMemo(() => getAppointmentsForDay(appointments, date), [appointments, date]);
  const visible = useMemo(() => searchAppointments(dayAppointments, query), [dayAppointments, query]);
  const groups = useMemo(() => groupByProvider(visible), [visible]);
  const providerCount = useMemo(() => new Set(dayAppointments.map((a) => a.providerKey)).size, [dayAppointments]);

  const countLabel =
    visible.length === dayAppointments.length
      ? `${dayAppointments.length} ${dayAppointments.length === 1 ? 'appointment' : 'appointments'}`
      : `${visible.length} of ${dayAppointments.length} shown`;

  let body: JSX.Element;
  if (loading) {
    body = <DaySkeleton />;
  } else if (dayAppointments.length === 0) {
    body = (
      <EmptyState
        title="No appointments on this day"
        description="Either nothing is scheduled or your filters are hiding every appointment."
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        title="No matches"
        description="Try a different search term."
        action={
          <Button size="xs" variant="default" onClick={() => setQuery('')}>
            Clear search
          </Button>
        }
      />
    );
  } else if (grouping === 'provider') {
    body = (
      <Stack gap="lg">
        {groups.map((group) => (
          <Stack key={group.providerKey} gap={6} component="section" aria-label={group.providerName}>
            <Group gap={8} wrap="nowrap">
              <Box className={classes.dot} bg={`${group.color}.6`} aria-hidden />
              <Text size="xs" fw={600} truncate>
                {group.providerName}
              </Text>
              <Text size="xs" c="dimmed">
                {group.appointments.length} {group.appointments.length === 1 ? 'appt' : 'appts'}
              </Text>
            </Group>
            <Divider />
            {group.appointments.map((row) => (
              <AppointmentRow key={row.appointment.id} row={row} onClick={() => onSelectAppointment(row)} />
            ))}
          </Stack>
        ))}
      </Stack>
    );
  } else {
    body = (
      <Stack gap={6}>
        {visible.map((row) => (
          <AppointmentRow key={row.appointment.id} row={row} onClick={() => onSelectAppointment(row)} />
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap={0} h="100%" className={classes.dayPanel}>
      <Stack gap={2} px="md" pt="md" pb="sm">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" className={classes.statLabel}>
          Day schedule
        </Text>
        <Title order={4}>{formatLongDate(date)}</Title>
        <Text size="xs" c="dimmed">
          {countLabel}
          {providerCount > 0 && ` · ${providerCount} ${providerCount === 1 ? 'provider' : 'providers'}`}
        </Text>
      </Stack>
      <Divider />

      {dayAppointments.length > 0 && (
        <>
          <Group gap="xs" px="md" py="sm" wrap="nowrap">
            <TextInput
              flex={1}
              size="xs"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search patient, MRN, or reason"
              aria-label="Search day appointments"
              leftSection={<IconSearch size={14} />}
              rightSection={
                query ? <CloseButton size="sm" aria-label="Clear search text" onClick={() => setQuery('')} /> : null
              }
            />
            <ActionIcon.Group>
              <Tooltip label="Group by provider" withArrow>
                <ActionIcon
                  variant={grouping === 'provider' ? 'light' : 'default'}
                  aria-label="Group by provider"
                  aria-pressed={grouping === 'provider'}
                  onClick={() => setGrouping('provider')}
                >
                  <IconUsers size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Sort by time" withArrow>
                <ActionIcon
                  variant={grouping === 'time' ? 'light' : 'default'}
                  aria-label="Sort by time"
                  aria-pressed={grouping === 'time'}
                  onClick={() => setGrouping('time')}
                >
                  <IconClock size={16} />
                </ActionIcon>
              </Tooltip>
            </ActionIcon.Group>
          </Group>
          <Divider />
        </>
      )}

      <ScrollArea flex={1} type="auto">
        <Box px="md" py="md">
          {body}
        </Box>
      </ScrollArea>
    </Stack>
  );
}

function AppointmentRow({ row, onClick }: { row: OverviewAppointment; onClick: () => void }): JSX.Element {
  const color = getColorForKey(row.providerKey);
  const patientName = row.patient?.name ?? 'No patient';
  return (
    <UnstyledButton onClick={onClick} className={classes.row} aria-label={`${patientName} at ${formatTime(row.start)}`}>
      <Box className={classes.rowStripe} bg={`${color}.6`} aria-hidden />
      <Stack gap={0} w={64} py={8} pl={6} className={classes.rowTime}>
        <Text size="xs" fw={600} className={classes.tabular}>
          {formatTime(row.start)}
        </Text>
        {row.durationMinutes > 0 && (
          <Text size="xs" c="dimmed">
            {row.durationMinutes} min
          </Text>
        )}
      </Stack>
      <Group gap="sm" py={8} pr={8} flex={1} wrap="nowrap" miw={0}>
        <Avatar size={32} radius="xl" color={color}>
          {getInitials(patientName)}
        </Avatar>
        <Stack gap={2} flex={1} miw={0}>
          <Text size="sm" fw={600} truncate>
            {patientName}
          </Text>
          <Group gap={4} wrap="nowrap" c="dimmed">
            <TypeIcon isVirtual={row.isVirtual} size={12} />
            <Text size="xs" truncate>
              {row.typeLabel}
              {row.locationName ? ` · ${row.locationName}` : ''}
            </Text>
          </Group>
          {row.reason && (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {row.reason}
            </Text>
          )}
        </Stack>
        <StatusIcon status={row.appointment.status} size="sm" />
      </Group>
    </UnstyledButton>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <Stack align="center" gap={6} py="xl" ta="center">
      <ThemeIcon variant="light" color="gray" size={40} radius="xl">
        <IconCalendarOff size={20} />
      </ThemeIcon>
      <Text size="sm" fw={500}>
        {title}
      </Text>
      <Text size="xs" c="dimmed" px="md">
        {description}
      </Text>
      {action}
    </Stack>
  );
}

function DaySkeleton(): JSX.Element {
  return (
    <Stack gap={6} aria-busy="true" aria-label="Loading day schedule">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} h={56} radius="sm" />
      ))}
    </Stack>
  );
}
