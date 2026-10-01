// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Group, Skeleton, Stack, Text } from '@mantine/core';
import { MedplumLink } from '@medplum/react';
import { IconCalendarEvent, IconClock, IconMapPin, IconStethoscope, IconVideo } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { useSchedulingOverview } from '../../hooks/useSchedulingOverview';
import { addClinicDays, clinicDayStart, clinicToday, formatClinicTime } from '../../utils/clinic-time';
import { isInactiveStatus } from '../../utils/scheduling-overview';
import { OverviewSection } from '../patient-overview/OverviewSection';
import { EmptyState } from '../patient-shell/PatientTabShell';
import classes from './Dashboard.module.css';

/**
 * Today's DrChrono appointments at the clinic, earliest first, each opening the patient's chart.
 * Uses the scheduling overview's search, so it shows exactly what the Scheduling page shows.
 * @returns The schedule card.
 */
export function TodaySchedule(): JSX.Element {
  const timeZone = useClinicTimeZone();
  const range = useMemo(() => {
    const today = clinicToday(timeZone);
    const start = clinicDayStart(today, timeZone);
    const end = clinicDayStart(addClinicDays(today, 1), timeZone);
    return start && end ? { start, end } : undefined;
  }, [timeZone]);
  const { appointments, loading, error } = useSchedulingOverview(range);
  const rows = appointments.filter((row) => !isInactiveStatus(row.appointment.status));

  return (
    <OverviewSection
      icon={<IconCalendarEvent size={16} />}
      tone="blue"
      title="Today's Schedule"
      subtitle="Your appointments for today"
      right={!loading && <span className={classes.countPill}>{rows.length}</span>}
    >
      <div className={classes.panelBody}>
        {loading && (
          <Stack gap="xs">
            <Skeleton h={58} radius="md" />
            <Skeleton h={58} radius="md" />
          </Stack>
        )}
        {!loading && error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        {!loading && !error && rows.length === 0 && (
          <EmptyState
            compact
            icon={<IconCalendarEvent size={24} />}
            title="No appointments today"
            description="Enjoy the open schedule."
          />
        )}
        {!loading &&
          rows.map((row) => {
            const content = (
              <>
                <Text className={classes.rowTitle}>{row.patient?.name ?? 'Unknown patient'}</Text>
                <Group gap={12} className={classes.rowMeta}>
                  <span>
                    <IconClock size={12} />
                    {formatClinicTime(row.start, timeZone)}
                  </span>
                  <span>
                    {row.isVirtual ? <IconVideo size={12} /> : <IconStethoscope size={12} />}
                    {row.providerName}
                  </span>
                  {row.locationName && (
                    <span>
                      <IconMapPin size={12} />
                      {row.locationName}
                    </span>
                  )}
                </Group>
              </>
            );
            return row.patient ? (
              <MedplumLink
                key={row.appointment.id}
                to={`/Patient/${row.patient.id}`}
                className={classes.row}
                underline="never"
              >
                {content}
              </MedplumLink>
            ) : (
              <div key={row.appointment.id} className={classes.row}>
                {content}
              </div>
            );
          })}
      </div>
      <Anchor component={MedplumLink} to="/scheduling" className={classes.panelLink}>
        Open schedule
      </Anchor>
    </OverviewSection>
  );
}
