// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Appointment, Bundle } from '@medplum/fhirtypes';
import { DrAliceSmith, HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { addClinicDays, clinicDayStart, clinicToday, DEFAULT_CLINIC_TIME_ZONE } from '../utils/clinic-time';
import { DRCHRONO_SOURCE_TAG, LYFE_SOURCE_TAG_SYSTEM } from '../utils/data-source';
import {
  fetchOverviewBundle,
  OVERVIEW_MAX_PAGES,
  useAppointmentCounts,
  useSchedulingOverview,
} from './useSchedulingOverview';

type SearchBundle = Awaited<ReturnType<MockClient['search']>>;

/**
 * An instant at `hour:minute` on a day relative to **the clinic's** today.
 *
 * The counts are bucketed by the clinic's calendar day, so a fixture built
 * from the runner's local clock lands on the wrong day whenever the two zones
 * disagree — which is the whole point of the change these tests cover.
 * @param dayOffset - Days from the clinic's today; may be negative.
 * @param hour - Hour of the clinic's day.
 * @param minute - Minute of the hour.
 * @returns The instant.
 */
function at(dayOffset: number, hour: number, minute = 0): Date {
  const dayKey = addClinicDays(clinicToday(DEFAULT_CLINIC_TIME_ZONE), dayOffset);
  const midnight = clinicDayStart(dayKey, DEFAULT_CLINIC_TIME_ZONE);
  if (!midnight) {
    throw new Error(`bad fixture day: ${dayKey}`);
  }
  return new Date(midnight.getTime() + (hour * 60 + minute) * 60_000);
}

function makeAppointment(start: Date, minutes: number, status: Appointment['status'] = 'booked'): Appointment {
  return {
    resourceType: 'Appointment',
    meta: { tag: [{ system: LYFE_SOURCE_TAG_SYSTEM, code: 'drchrono' }] },
    status,
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60_000).toISOString(),
    participant: [
      { actor: { reference: `Patient/${HomerSimpson.id}` }, status: 'accepted' },
      { actor: { reference: `Practitioner/${DrAliceSmith.id}` }, status: 'accepted' },
    ],
  };
}

const week = { start: at(-1, 0), end: at(6, 0) };

describe('useSchedulingOverview', () => {
  let medplum: MockClient;

  function wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <MedplumProvider medplum={medplum}>{children}</MedplumProvider>;
  }

  beforeEach(async () => {
    medplum = new MockClient();
    await medplum.createResource(makeAppointment(at(0, 9), 30));
    await medplum.createResource(makeAppointment(at(1, 14), 45));
    await medplum.createResource(makeAppointment(at(0, 11), 15, 'cancelled'));
    await medplum.createResource(makeAppointment(at(0, 12), 15, 'entered-in-error'));
    // Outside the requested range
    await medplum.createResource(makeAppointment(at(20, 9), 30));
    // Not from DrChrono
    await medplum.createResource({
      ...makeAppointment(at(0, 10), 30),
      meta: { tag: [{ system: LYFE_SOURCE_TAG_SYSTEM, code: 'zus' }] },
    });
    await medplum.createResource({ ...makeAppointment(at(0, 13), 30), meta: undefined });
  });

  test('does nothing until the calendar reports a range', () => {
    const search = vi.spyOn(medplum, 'search');
    const { result } = renderHook(() => useSchedulingOverview(undefined), { wrapper });
    expect(result.current.loading).toBe(false);
    expect(result.current.appointments).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  test('loads appointments in range with included patients and practitioners', async () => {
    const { result } = renderHook(() => useSchedulingOverview(week), { wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    const rows = result.current.appointments;
    // Entered-in-error and non-DrChrono appointments are excluded by the query; cancelled is kept
    // so the page can toggle it.
    expect(rows.map((r) => r.appointment.status)).toEqual(['booked', 'cancelled', 'booked']);
    expect(rows[0].patient?.name).toBe('Homer Simpson');
    expect(rows[0].providerName).toBe('Alice Smith');
    expect(rows[0].durationMinutes).toBe(30);
    expect(result.current.error).toBeUndefined();
    expect(result.current.truncated).toBe(false);
  });

  test('reload refetches', async () => {
    const { result } = renderHook(() => useSchedulingOverview(week), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.appointments).toHaveLength(3);

    await medplum.createResource(makeAppointment(at(2, 10), 30));
    result.current.reload();

    await waitFor(() => expect(result.current.appointments).toHaveLength(4));
  });

  test('reports errors', async () => {
    vi.spyOn(medplum, 'search').mockRejectedValue(new Error('Boom'));
    const { result } = renderHook(() => useSchedulingOverview(week), { wrapper });
    await waitFor(() => expect(result.current.error).toBe('Boom'));
    expect(result.current.loading).toBe(false);
  });

  test('ignores a stale response when the range changes', async () => {
    let resolveFirst: (bundle: Bundle) => void = () => undefined;
    const first = new Promise<Bundle>((resolve) => {
      resolveFirst = resolve;
    });
    const realSearch = medplum.search.bind(medplum);
    vi.spyOn(medplum, 'search')
      .mockImplementationOnce(() => first as ReturnType<MockClient['search']>)
      .mockImplementation(realSearch);

    const { result, rerender } = renderHook(({ range }) => useSchedulingOverview(range), {
      wrapper,
      initialProps: { range: week },
    });
    const nextWeek = { start: at(6, 0), end: at(30, 0) };
    rerender({ range: nextWeek });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.appointments).toHaveLength(1);

    // The first (stale) request resolving late must not overwrite the newer result.
    resolveFirst({ resourceType: 'Bundle', type: 'searchset', entry: [] });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(result.current.appointments).toHaveLength(1);
  });
});

describe('fetchOverviewBundle', () => {
  test('follows next links and merges pages', async () => {
    const medplum = new MockClient();
    const page = (id: string, next?: string): Bundle => ({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: { ...makeAppointment(at(0, 9), 30), id } }],
      link: next ? [{ relation: 'next', url: next }] : undefined,
    });
    vi.spyOn(medplum, 'search').mockResolvedValue(page('a1', 'https://example.com/page2') as SearchBundle);
    const get = vi.spyOn(medplum, 'get').mockResolvedValue(page('a2'));

    const { bundle, truncated } = await fetchOverviewBundle(medplum, week);

    expect(get).toHaveBeenCalledWith('https://example.com/page2', { cache: 'no-cache' });
    expect(bundle.entry?.map((e) => e.resource?.id)).toEqual(['a1', 'a2']);
    expect(truncated).toBe(false);
  });

  test('stops at the page cap and reports truncation', async () => {
    const medplum = new MockClient();
    const endless: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [],
      link: [{ relation: 'next', url: 'https://example.com/more' }],
    };
    vi.spyOn(medplum, 'search').mockResolvedValue(endless as SearchBundle);
    const get = vi.spyOn(medplum, 'get').mockResolvedValue(endless);

    const { truncated } = await fetchOverviewBundle(medplum, week);

    expect(get).toHaveBeenCalledTimes(OVERVIEW_MAX_PAGES - 1);
    expect(truncated).toBe(true);
  });

  test('queries the range and DrChrono tag, excludes entered-in-error and includes related resources', async () => {
    const medplum = new MockClient();
    const search = vi
      .spyOn(medplum, 'search')
      .mockResolvedValue({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    await fetchOverviewBundle(medplum, week);

    const params = search.mock.calls[0][1] as URLSearchParams;
    expect(params.getAll('date')).toEqual([`ge${week.start.toISOString()}`, `lt${week.end.toISOString()}`]);
    expect(params.get('status:not')).toBe('entered-in-error');
    expect(params.get('_tag')).toBe(DRCHRONO_SOURCE_TAG);
    expect(params.getAll('_include')).toEqual([
      'Appointment:patient',
      'Appointment:practitioner',
      'Appointment:location',
    ]);
  });
});

describe('useAppointmentCounts', () => {
  test('counts active appointments today and over the next seven days', async () => {
    const medplum = new MockClient();
    await medplum.createResource(makeAppointment(at(0, 9), 30));
    await medplum.createResource(makeAppointment(at(0, 10), 30, 'cancelled'));
    await medplum.createResource(makeAppointment(at(3, 9), 30));
    await medplum.createResource(makeAppointment(at(10, 9), 30));

    const { result } = renderHook(() => useAppointmentCounts(0), {
      wrapper: ({ children }) => <MedplumProvider medplum={medplum}>{children}</MedplumProvider>,
    });

    await waitFor(() => expect(result.current).toEqual({ today: 1, thisWeek: 2 }));
  });

  test('leaves a count undefined when its query fails', async () => {
    const medplum = new MockClient();
    vi.spyOn(medplum, 'search').mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useAppointmentCounts(0), {
      wrapper: ({ children }) => <MedplumProvider medplum={medplum}>{children}</MedplumProvider>,
    });

    await waitFor(() => expect(result.current).toEqual({ today: undefined, thisWeek: undefined }));
  });
});
