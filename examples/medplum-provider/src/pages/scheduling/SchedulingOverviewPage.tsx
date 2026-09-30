// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Drawer,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { getReferenceString } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { useMedplumProfile } from '@medplum/react';
import type { DateTimeRange, MultiCalendarSource } from '@medplum/react-scheduling';
import { MultiCalendar, useCalendarController } from '@medplum/react-scheduling';
import {
  IconAlertTriangle,
  IconBuildingHospital,
  IconCalendarEvent,
  IconCalendarPlus,
  IconCalendarStats,
  IconCalendarX,
  IconClock,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconRefresh,
  IconStethoscope,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LyfePageHeader } from '../../components/brand/LyfePageHeader';
import { AppointmentDetailDrawer } from '../../components/scheduling-overview/AppointmentDetailDrawer';
import { DayAppointmentsPanel } from '../../components/scheduling-overview/DayAppointmentsPanel';
import { FilterMenu } from '../../components/scheduling-overview/FilterMenu';
import overviewClasses from '../../components/scheduling-overview/SchedulingOverview.module.css';
import { SchedulingToolbar } from '../../components/scheduling-overview/SchedulingToolbar';
import { StatCard } from '../../components/scheduling-overview/StatCard';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useAppointmentCounts, useSchedulingOverview } from '../../hooks/useSchedulingOverview';
import type { OverviewAppointment } from '../../utils/scheduling-overview';
import {
  countPatients,
  filterOverviewAppointments,
  fromLocalIsoDate,
  getColorForKey,
  getLocationOptions,
  getProviderOptions,
  isInactiveStatus,
  toLocalIsoDate,
} from '../../utils/scheduling-overview';
import classes from './SchedulingOverviewPage.module.css';

const STORAGE_PREFIX = 'medplum-provider:scheduling-overview';
const PROVIDER_AUTO_APPLIED_KEY = `${STORAGE_PREFIX}:provider-auto-applied`;

/**
 * Clinic-wide scheduling overview: every provider's appointments on one color-coded calendar,
 * with a day schedule side panel and an appointment detail drawer.
 *
 * The selected day (`?day=YYYY-MM-DD`) and appointment (`?appointment=<id>`) live in the URL, so
 * the view can be linked to and the browser back button closes the drawer.
 * @returns The scheduling overview page.
 */
export function SchedulingOverviewPage(): JSX.Element {
  const navigate = useNavigate();
  const profile = useMedplumProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  // Mantine's `lg` breakpoint: below it the day panel becomes a drawer instead of a rail.
  const isCompact = useMediaQuery('(max-width: 74.99em)') ?? false;

  const calendarController = useCalendarController();
  const [range, setRange] = useState<DateTimeRange>();
  const { appointments, loading, error, truncated, reload } = useSchedulingOverview(range);
  const [countsKey, setCountsKey] = useState(0);
  const counts = useAppointmentCounts(countsKey);

  const [providerFilter, setProviderFilter] = usePersistentState<string[]>(
    `${STORAGE_PREFIX}:providers`,
    [],
    'session'
  );
  const [locationFilter, setLocationFilter] = usePersistentState<string[]>(
    `${STORAGE_PREFIX}:locations`,
    [],
    'session'
  );
  // Cancelled visits are shown (struck through) by default, as in the Lyfe scheduling view.
  const [showCancelled, setShowCancelled] = usePersistentState(`${STORAGE_PREFIX}:show-cancelled`, true, 'session');
  const [panelOpen, setPanelOpen] = usePersistentState(`${STORAGE_PREFIX}:panel-open`, true, 'local');

  // ---- URL state -----------------------------------------------------------------------------

  const selectedDay = fromLocalIsoDate(searchParams.get('day')) ?? new Date();
  const selectedAppointmentId = searchParams.get('appointment') ?? undefined;

  const updateParams = useCallback(
    (changes: Record<string, string | undefined>, replace = false) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) {
              next.delete(key);
            } else {
              next.set(key, value);
            }
          }
          return next;
        },
        { replace }
      );
    },
    [setSearchParams]
  );

  // Make the selected day explicit in the URL on first load so the view is always shareable.
  useEffect(() => {
    if (!fromLocalIsoDate(searchParams.get('day'))) {
      updateParams({ day: toLocalIsoDate(new Date()) }, true);
    }
  }, [searchParams, updateParams]);

  const openDay = useCallback(
    (date: Date) => {
      setPanelOpen(true);
      updateParams({ day: toLocalIsoDate(date), appointment: undefined });
    },
    [setPanelOpen, updateParams]
  );

  const openAppointment = useCallback(
    (row: OverviewAppointment) => updateParams({ appointment: row.appointment.id, day: toLocalIsoDate(row.start) }),
    [updateParams]
  );

  const closeAppointment = useCallback(() => updateParams({ appointment: undefined }), [updateParams]);

  // ---- Derived data --------------------------------------------------------------------------

  const providerOptions = useMemo(() => getProviderOptions(appointments), [appointments]);
  const locationOptions = useMemo(() => getLocationOptions(appointments), [appointments]);

  // Default a signed-in provider to their own schedule, once per browser session. A cleared
  // filter stays cleared, and an existing selection is never overridden.
  useEffect(() => {
    if (profile?.resourceType !== 'Practitioner' || providerFilter.length > 0) {
      return;
    }
    const ownKey = getReferenceString(profile);
    if (!ownKey || !providerOptions.some((option) => option.key === ownKey)) {
      return;
    }
    try {
      if (sessionStorage.getItem(PROVIDER_AUTO_APPLIED_KEY)) {
        return;
      }
      sessionStorage.setItem(PROVIDER_AUTO_APPLIED_KEY, '1');
    } catch {
      return;
    }
    setProviderFilter([ownKey]);
  }, [profile, providerOptions, providerFilter.length, setProviderFilter]);

  const filtered = useMemo(
    () =>
      filterOverviewAppointments(appointments, {
        providers: providerFilter,
        locations: locationFilter,
        showCancelled,
      }),
    [appointments, providerFilter, locationFilter, showCancelled]
  );

  const activeInView = useMemo(
    () => appointments.filter((row) => !isInactiveStatus(row.appointment.status)),
    [appointments]
  );

  // One calendar source per provider so every provider gets a stable color.
  const calendarSources = useMemo((): MultiCalendarSource[] => {
    const byProvider = new Map<string, Appointment[]>();
    for (const row of filtered) {
      const list = byProvider.get(row.providerKey) ?? [];
      list.push(withPatientDisplay(row));
      byProvider.set(row.providerKey, list);
    }
    return [...byProvider.entries()].map(([key, list]) => ({
      appointments: list,
      slots: [],
      color: getColorForKey(key),
    }));
  }, [filtered]);

  const rowsById = useMemo(() => new Map(appointments.map((row) => [row.appointment.id, row])), [appointments]);
  const selectedRow = selectedAppointmentId ? rowsById.get(selectedAppointmentId) : undefined;

  const handleSelectAppointment = useCallback(
    (appointment: Appointment) => {
      const row = appointment.id ? rowsById.get(appointment.id) : undefined;
      if (row) {
        openAppointment(row);
      }
    },
    [rowsById, openAppointment]
  );

  const handleRefresh = useCallback(() => {
    reload();
    setCountsKey((key) => key + 1);
  }, [reload]);

  const hasFilters = providerFilter.length > 0 || locationFilter.length > 0;

  const dayPanel = (
    <DayAppointmentsPanel
      date={selectedDay}
      appointments={filtered}
      loading={loading && appointments.length === 0}
      onSelectAppointment={openAppointment}
    />
  );

  return (
    <Stack gap="md" p="md" className={classes.page}>
      <LyfePageHeader
        icon={<IconCalendarStats size={20} />}
        eyebrow="Calendar"
        title="Scheduling Overview"
        description="View all providers, patients, and their appointments in one place"
      />

      <div className={classes.layout}>
        <Stack gap="md" className={classes.main}>
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
            <StatCard
              icon={<IconCalendarEvent size={20} />}
              label="In View"
              value={range && !loading ? activeInView.length : undefined}
              color="blue"
            />
            <StatCard icon={<IconClock size={20} />} label="Today" value={counts.today} color="red" live />
            <StatCard icon={<IconCalendarStats size={20} />} label="Next 7 Days" value={counts.thisWeek} color="teal" />
            <StatCard
              icon={<IconUsers size={20} />}
              label="Patients"
              value={range && !loading ? countPatients(activeInView) : undefined}
              color="indigo"
            />
          </SimpleGrid>

          <Group gap="sm">
            <FilterMenu
              label="Location"
              pluralLabel="Locations"
              icon={<IconBuildingHospital size={14} />}
              options={locationOptions}
              selected={locationFilter}
              onChange={setLocationFilter}
            />
            <FilterMenu
              label="Provider"
              pluralLabel="Providers"
              icon={<IconStethoscope size={14} />}
              options={providerOptions}
              selected={providerFilter}
              onChange={setProviderFilter}
              getColor={getColorForKey}
            />
            {hasFilters && (
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconX size={12} />}
                onClick={() => {
                  setProviderFilter([]);
                  setLocationFilter([]);
                }}
              >
                Clear all
              </Button>
            )}
            <Button
              variant={showCancelled ? 'light' : 'default'}
              color="red"
              className={overviewClasses.filterButton}
              data-active={showCancelled || undefined}
              aria-pressed={showCancelled}
              leftSection={<IconCalendarX size={14} />}
              onClick={() => setShowCancelled((show) => !show)}
            >
              {showCancelled ? 'Hide cancelled' : 'Show cancelled'}
            </Button>
          </Group>

          {error && (
            <Alert color="red" icon={<IconAlertTriangle />} title="Could not load appointments">
              {error}
            </Alert>
          )}
          {truncated && (
            <Alert color="yellow" icon={<IconAlertTriangle />}>
              This view has more appointments than can be shown at once. Switch to the week or day view to see them all.
            </Alert>
          )}

          <SchedulingToolbar
            controller={calendarController}
            loading={loading}
            actions={
              <>
                <Button
                  variant="default"
                  size="xs"
                  h={32}
                  leftSection={<IconCalendarPlus size={14} />}
                  onClick={() => navigate('/Calendar/Schedule')?.catch(console.error)}
                >
                  Book appointments
                </Button>
                <Tooltip label="Refresh" withArrow>
                  <ActionIcon variant="default" size={32} aria-label="Refresh appointments" onClick={handleRefresh}>
                    <IconRefresh size={16} />
                  </ActionIcon>
                </Tooltip>
                <Button
                  variant={panelOpen ? 'light' : 'default'}
                  size="xs"
                  h={32}
                  aria-pressed={panelOpen}
                  leftSection={
                    panelOpen ? (
                      <IconLayoutSidebarRightCollapse size={14} />
                    ) : (
                      <IconLayoutSidebarRightExpand size={14} />
                    )
                  }
                  onClick={() => setPanelOpen((open) => !open)}
                >
                  {panelOpen ? 'Hide schedule' : 'Show schedule'}
                </Button>
              </>
            }
          />

          <Paper withBorder radius="md" p="sm" className={classes.calendarCard}>
            <MultiCalendar
              sources={calendarSources}
              controller={calendarController}
              hideToolbar
              initialView="dayGridMonth"
              onRangeChange={setRange}
              onSelectAppointment={handleSelectAppointment}
              onSelectInterval={(interval) => openDay(interval.start)}
              className={classes.calendar}
            />
          </Paper>
        </Stack>

        {panelOpen && !isCompact && (
          <Paper withBorder radius="md" className={classes.rail}>
            <Box className={classes.railInner}>{dayPanel}</Box>
          </Paper>
        )}
      </div>

      <Drawer
        opened={isCompact && panelOpen && !selectedAppointmentId}
        onClose={() => setPanelOpen(false)}
        position="right"
        size="md"
        padding={0}
        title={<VisuallyHidden>Day schedule</VisuallyHidden>}
        closeButtonProps={{ 'aria-label': 'Close day schedule' }}
        classNames={{ header: classes.drawerHeader }}
      >
        {dayPanel}
      </Drawer>

      <AppointmentDetailDrawer
        opened={Boolean(selectedAppointmentId)}
        row={selectedRow}
        loading={loading || !range}
        onClose={closeAppointment}
        onViewPatient={(patientId) => navigate(`/Patient/${patientId}`)?.catch(console.error)}
      />
    </Stack>
  );
}

/**
 * The calendar titles events with the patient participant's `display`. Fill it in from the
 * included Patient resource so events never fall back to "No Patient" when `display` is unset.
 * @param row - The overview row.
 * @returns The appointment with a patient display name.
 */
function withPatientDisplay(row: OverviewAppointment): Appointment {
  const patient = row.patient;
  if (!patient) {
    return row.appointment;
  }
  return {
    ...row.appointment,
    participant: row.appointment.participant.map((participant) =>
      participant.actor?.reference === patient.reference && !participant.actor.display
        ? { ...participant, actor: { ...participant.actor, display: patient.name } }
        : participant
    ),
  };
}
