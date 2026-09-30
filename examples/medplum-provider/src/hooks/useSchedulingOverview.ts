// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { Bundle, BundleEntry } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import type { DateTimeRange } from '@medplum/react-scheduling';
import { useCallback, useEffect, useState } from 'react';
import { addClinicDays, clinicDayStart, clinicToday } from '../utils/clinic-time';
import { DRCHRONO_SOURCE_TAG } from '../utils/data-source';
import type { OverviewAppointment } from '../utils/scheduling-overview';
import { buildOverviewAppointments } from '../utils/scheduling-overview';
import { useClinicTimeZone } from './useClinicTimeZone';

/** Appointments requested per page. */
export const OVERVIEW_PAGE_SIZE = 500;
/** Hard cap on pages followed for one calendar range, to bound work on very busy clinics. */
export const OVERVIEW_MAX_PAGES = 10;

export interface SchedulingOverviewResult {
  appointments: OverviewAppointment[];
  loading: boolean;
  error?: string;
  /** True when the range held more appointments than the page cap allowed us to load. */
  truncated: boolean;
  reload: () => void;
}

// Only DrChrono appointments are shown; other sources (e.g. Zus) are excluded by the server.
function rangeParams(start: Date, end: Date): string[][] {
  return [
    ['date', `ge${start.toISOString()}`],
    ['date', `lt${end.toISOString()}`],
    ['_tag', DRCHRONO_SOURCE_TAG],
  ];
}

/**
 * Loads every appointment in a calendar range, following `next` links, and returns a single
 * searchset bundle containing the appointments and their included Patient, Practitioner and
 * Location resources.
 * @param medplum - The Medplum client.
 * @param range - The calendar range to load.
 * @returns The merged bundle and whether the page cap was hit.
 */
export async function fetchOverviewBundle(
  medplum: MedplumClient,
  range: DateTimeRange
): Promise<{ bundle: Bundle; truncated: boolean }> {
  const params = new URLSearchParams([
    ...rangeParams(range.start, range.end),
    ['status:not', 'entered-in-error'],
    ['_include', 'Appointment:patient'],
    ['_include', 'Appointment:practitioner'],
    ['_include', 'Appointment:location'],
    ['_sort', 'date'],
    ['_count', String(OVERVIEW_PAGE_SIZE)],
  ]);

  const entries: BundleEntry[] = [];
  let page: Bundle = await medplum.search('Appointment', params, { cache: 'no-cache' });
  let pages = 1;
  entries.push(...(page.entry ?? []));

  let next = page.link?.find((link) => link.relation === 'next')?.url;
  while (next && pages < OVERVIEW_MAX_PAGES) {
    page = await medplum.get<Bundle>(next, { cache: 'no-cache' });
    entries.push(...(page.entry ?? []));
    pages++;
    next = page.link?.find((link) => link.relation === 'next')?.url;
  }

  return { bundle: { resourceType: 'Bundle', type: 'searchset', entry: entries }, truncated: Boolean(next) };
}

/**
 * Loads the appointments shown on the scheduling overview for the visible calendar range.
 * Stale responses from a previous range are discarded.
 * @param range - The visible calendar range, or undefined before the calendar has rendered.
 * @returns The appointments plus loading/error state and a reload callback.
 */
export function useSchedulingOverview(range: DateTimeRange | undefined): SchedulingOverviewResult {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  // The last settled request. Loading is derived by comparing it with the current request key,
  // so previous results stay on screen while the next range loads.
  const [settled, setSettled] = useState<{
    requestKey: string;
    appointments: OverviewAppointment[];
    truncated: boolean;
    error?: string;
  }>({ requestKey: '', appointments: [], truncated: false });

  const startMs = range?.start.getTime();
  const endMs = range?.end.getTime();
  const requestKey = startMs === undefined || endMs === undefined ? '' : `${startMs}:${endMs}:${reloadKey}`;

  useEffect(() => {
    if (startMs === undefined || endMs === undefined) {
      return undefined;
    }
    let active = true;
    const key = `${startMs}:${endMs}:${reloadKey}`;
    fetchOverviewBundle(medplum, { start: new Date(startMs), end: new Date(endMs) })
      .then(({ bundle, truncated }) => {
        if (active) {
          setSettled({ requestKey: key, appointments: buildOverviewAppointments(bundle), truncated });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setSettled((prev) => ({ ...prev, requestKey: key, error: normalizeErrorString(err) }));
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, startMs, endMs, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    appointments: settled.appointments,
    loading: requestKey !== '' && settled.requestKey !== requestKey,
    error: settled.requestKey === requestKey ? settled.error : undefined,
    truncated: settled.truncated,
    reload,
  };
}

export interface AppointmentCounts {
  today?: number;
  thisWeek?: number;
}

async function countActiveAppointments(medplum: MedplumClient, start: Date, end: Date): Promise<number> {
  const bundle = await medplum.search(
    'Appointment',
    new URLSearchParams([
      ...rangeParams(start, end),
      ['status:not', 'cancelled'],
      ['status:not', 'entered-in-error'],
      ['_summary', 'count'],
    ]),
    { cache: 'no-cache' }
  );
  return bundle.total ?? 0;
}

/**
 * Counts active (not cancelled) appointments for today and for the next seven days, independent
 * of whichever calendar range is on screen.
 * @param refreshKey - Changing this value re-runs the counts, e.g. after a manual refresh.
 * @returns The counts; a value is undefined until loaded or if its query failed.
 */
export function useAppointmentCounts(refreshKey: number): AppointmentCounts {
  const medplum = useMedplum();
  const timeZone = useClinicTimeZone();
  const [counts, setCounts] = useState<AppointmentCounts>({});

  useEffect(() => {
    let active = true;
    // "Today" is the clinic's today. For a viewer twelve hours ahead of the
    // clinic, the browser's today is the clinic's tomorrow for half the day,
    // and the count on the header would disagree with the calendar under it.
    const todayKey = clinicToday(timeZone);
    const dayStart = clinicDayStart(todayKey, timeZone);
    const boundary = (days: number): Date | undefined => clinicDayStart(addClinicDays(todayKey, days), timeZone);
    const tomorrow = boundary(1);
    const nextWeek = boundary(7);
    if (!dayStart || !tomorrow || !nextWeek) {
      return undefined;
    }
    Promise.allSettled([
      countActiveAppointments(medplum, dayStart, tomorrow),
      countActiveAppointments(medplum, dayStart, nextWeek),
    ])
      .then(([todayResult, weekResult]) => {
        if (active) {
          setCounts({
            today: todayResult.status === 'fulfilled' ? todayResult.value : undefined,
            thisWeek: weekResult.status === 'fulfilled' ? weekResult.value : undefined,
          });
        }
      })
      .catch(console.error);
    return () => {
      active = false;
    };
  }, [medplum, refreshKey, timeZone]);

  return counts;
}
