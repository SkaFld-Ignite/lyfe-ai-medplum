// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, Text } from '@mantine/core';
import { formatHumanName, isOk } from '@medplum/core';
import { useMedplumProfile, useSearch } from '@medplum/react';
import { IconActivityHeartbeat, IconCalendar } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { CLINIC_LOCALE } from '../../utils/clinic-time';
import { clinicHour, greetingFor, PATIENT_COUNT_QUERY } from '../../utils/dashboard';
import classes from './Dashboard.module.css';

type ServerStatus = 'checking' | 'ok' | 'down';

/**
 * Whether the Medplum FHIR server is answering, from the patient count search the stat cards also
 * run (Medplum's cache serves both). `/healthcheck` cannot be read from a browser (no CORS), and
 * `/metadata` cannot go through the client's auto-batched GETs.
 * @returns The server status.
 */
function useServerStatus(): ServerStatus {
  const [bundle, loading, outcome] = useSearch('Patient', PATIENT_COUNT_QUERY);
  if (loading) {
    return 'checking';
  }
  // Medplum reports success as an "all OK" outcome, so only a non-OK outcome means trouble.
  return bundle && (!outcome || isOk(outcome)) ? 'ok' : 'down';
}

const STATUS_TEXT: Record<ServerStatus, string> = {
  checking: 'Checking services…',
  ok: 'All services nominal',
  down: 'Server not responding',
};

/**
 * The dashboard greeting: today's date at the clinic, a time-of-day greeting with the signed-in
 * user's name, and the Medplum server's health.
 * @returns The header card.
 */
export function DashboardHeader(): JSX.Element {
  const profile = useMedplumProfile();
  const timeZone = useClinicTimeZone();
  const status = useServerStatus();
  const now = new Date();
  const name = profile && 'name' in profile ? formatHumanName(profile.name?.[0]) : undefined;
  const today = now.toLocaleDateString(CLINIC_LOCALE, { timeZone, weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <header className={classes.header}>
      <div>
        <Group gap={8} mb={10}>
          <span className={classes.pill}>
            <IconCalendar size={12} />
            {today}
          </span>
          <span className={classes.pill} data-tone="live">
            <span className={classes.liveDot} />
            Live
          </span>
        </Group>
        <h1 className={classes.greeting}>
          {greetingFor(clinicHour(now, timeZone))}
          {name ? `, ${name}` : ''}
        </h1>
        <Text className={classes.muted}>Here&apos;s your clinical overview for today</Text>
      </div>

      <div className={classes.status} data-status={status} role="status">
        <span className={classes.statusIcon}>
          <IconActivityHeartbeat size={16} />
        </span>
        <div>
          <Text className={classes.statusTitle}>System status</Text>
          <Text className={classes.muted} fz={12}>
            {STATUS_TEXT[status]}
          </Text>
        </div>
      </div>
    </header>
  );
}
