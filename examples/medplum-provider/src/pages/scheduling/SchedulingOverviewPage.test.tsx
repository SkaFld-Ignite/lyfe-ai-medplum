// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import type { Appointment, Location, Practitioner } from '@medplum/fhirtypes';
import { BartSimpson, DrAliceSmith, HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, test } from 'vitest';
import { toLocalIsoDate } from '../../utils/scheduling-overview';
import { SchedulingOverviewPage } from './SchedulingOverviewPage';

const AUTO_APPLIED_KEY = 'medplum-provider:scheduling-overview:provider-auto-applied';

function todayAt(hour: number): Date {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date;
}

function makeAppointment(
  id: string,
  start: Date,
  patientRef: string,
  practitionerRef: string,
  status: Appointment['status'] = 'booked',
  extra: Partial<Appointment> = {}
): Appointment {
  return {
    resourceType: 'Appointment',
    id,
    status,
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    participant: [
      { actor: { reference: patientRef }, status: 'accepted' },
      { actor: { reference: practitionerRef }, status: 'accepted' },
      { actor: { reference: 'Location/clinic-1' }, status: 'accepted' },
    ],
    ...extra,
  };
}

describe('SchedulingOverviewPage', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    // Most tests are about the clinic-wide view, so skip the "default to my schedule" behavior.
    sessionStorage.setItem(AUTO_APPLIED_KEY, '1');

    medplum = new MockClient();
    await medplum.createResource<Practitioner>({
      resourceType: 'Practitioner',
      id: 'dr-bob',
      name: [{ given: ['Bob'], family: 'Jones' }],
    });
    await medplum.createResource<Location>({ resourceType: 'Location', id: 'clinic-1', name: 'Main Clinic' });
    await medplum.createResource(
      makeAppointment(
        'appt-homer',
        todayAt(9),
        `Patient/${HomerSimpson.id}`,
        `Practitioner/${DrAliceSmith.id}`,
        'booked',
        {
          appointmentType: { text: 'Follow-up' },
          reasonCode: [{ text: 'Knee pain' }],
        }
      )
    );
    await medplum.createResource(
      makeAppointment('appt-bart', todayAt(10), `Patient/${BartSimpson.id}`, 'Practitioner/dr-bob')
    );
    await medplum.createResource(
      makeAppointment('appt-cancelled', todayAt(11), `Patient/${HomerSimpson.id}`, 'Practitioner/dr-bob', 'cancelled')
    );
  });

  function setup(initialPath = '/scheduling'): ReturnType<typeof createMemoryRouter> {
    const router = createMemoryRouter(
      [
        { path: '/scheduling', element: <SchedulingOverviewPage /> },
        { path: '/Patient/:id', element: <div>Patient page</div> },
        { path: '/Calendar/Schedule', element: <div>Booking calendar</div> },
      ],
      { initialEntries: [initialPath] }
    );
    render(
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <Notifications />
          <RouterProvider router={router} />
        </MantineProvider>
      </MedplumProvider>
    );
    return router;
  }

  async function waitForDayPanel(): Promise<HTMLElement> {
    return screen.findByRole('region', { name: 'Alice Smith' }, { timeout: 5000 });
  }

  test('renders the header, stats and today in the day panel', async () => {
    const router = setup();

    expect(screen.getByRole('heading', { name: 'Scheduling Overview' })).toBeInTheDocument();
    expect(screen.getByText('View all providers, patients, and their appointments in one place')).toBeInTheDocument();

    await waitForDayPanel();
    expect(await screen.findByLabelText('Today: 2')).toBeInTheDocument();
    expect(screen.getByLabelText('In View: 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Patients: 2')).toBeInTheDocument();

    expect(screen.getByText('3 appointments · 2 providers')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bob Jones' })).toBeInTheDocument();
    expect(screen.getByText('Follow-up · Main Clinic')).toBeInTheDocument();
    // Cancelled appointments are shown by default (like the Lyfe view) but not counted in stats.
    expect(screen.getAllByRole('button', { name: / at / })).toHaveLength(3);

    // The selected day is written to the URL so the view is shareable.
    expect(router.state.location.search).toBe(`?day=${toLocalIsoDate(new Date())}`);
  });

  test('shows patient names on the calendar', async () => {
    setup();
    await waitForDayPanel();
    const calendar = screen.getByTestId('calendar');
    expect(within(calendar).getAllByText('Homer Simpson').length).toBeGreaterThan(0);
    expect(within(calendar).getAllByText('Bart Simpson').length).toBeGreaterThan(0);
  });

  test('opens the appointment drawer from the day panel and navigates to the patient', async () => {
    const user = userEvent.setup();
    const router = setup();
    await waitForDayPanel();

    // Homer has a booked 9am visit and a cancelled 11am one; open the first.
    await user.click(screen.getAllByRole('button', { name: /^Homer Simpson at/ })[0]);

    expect(await screen.findByText('Appointment Details')).toBeInTheDocument();
    expect(router.state.location.search).toContain('appointment=appt-homer');
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('Knee pain')).toBeInTheDocument();
    expect(within(drawer).getByText('Follow-up')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'View Patient' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/Patient/${HomerSimpson.id}`));
  });

  test('closing the drawer removes the appointment from the URL', async () => {
    const user = userEvent.setup();
    const router = setup();
    await waitForDayPanel();

    await user.click(screen.getByRole('button', { name: /^Bart Simpson at/ }));
    await screen.findByText('Appointment Details');
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(router.state.location.search).not.toContain('appointment='));
  });

  test('deep links straight to an appointment', async () => {
    setup(`/scheduling?day=${toLocalIsoDate(new Date())}&appointment=appt-bart`);
    expect(await screen.findByText('Appointment Details', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText('Bob Jones', { selector: 'div' })).toBeInTheDocument();
  });

  test('filters by provider', async () => {
    const user = userEvent.setup();
    setup();
    await waitForDayPanel();

    await user.click(screen.getByRole('button', { name: 'Filter by provider' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Bob Jones' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Alice Smith' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent('Bob Jones');
    expect(screen.getByText('2 appointments · 1 provider')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(await waitForDayPanel()).toBeInTheDocument();
  });

  test('shows cancelled appointments by default and can hide them', async () => {
    const user = userEvent.setup();
    setup();
    await waitForDayPanel();

    expect(screen.getAllByLabelText('Cancelled').length).toBeGreaterThan(0);
    // Stats count active appointments only.
    expect(screen.getByLabelText('In View: 2')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show cancelled' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: / at / })).toHaveLength(2));
    expect(screen.queryByLabelText('Cancelled')).not.toBeInTheDocument();
  });

  test('links to the booking calendar', async () => {
    const user = userEvent.setup();
    const router = setup();
    await waitForDayPanel();

    await user.click(screen.getByRole('button', { name: 'Book appointments' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/Calendar/Schedule'));
  });

  test('hides and restores the day panel, remembering the choice', async () => {
    const user = userEvent.setup();
    setup();
    await waitForDayPanel();

    await user.click(screen.getByRole('button', { name: 'Hide schedule' }));
    expect(screen.queryByText('Day schedule')).not.toBeInTheDocument();
    expect(localStorage.getItem('medplum-provider:scheduling-overview:panel-open')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Show schedule' }));
    expect(await waitForDayPanel()).toBeInTheDocument();
  });

  test('defaults a practitioner to their own schedule once per session', async () => {
    sessionStorage.clear();
    setup();

    // The mock user is Dr. Alice Smith, who has an appointment today.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent('Alice Smith')
    );
    expect(screen.queryByRole('region', { name: 'Bob Jones' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(AUTO_APPLIED_KEY)).toBe('1');
  });

  test('shows an error when appointments cannot be loaded', async () => {
    const realSearch = medplum.search.bind(medplum);
    medplum.search = ((resourceType: string, query: unknown, options: unknown) => {
      const params = query instanceof URLSearchParams ? query : undefined;
      if (resourceType === 'Appointment' && params?.has('_include')) {
        return Promise.reject(new Error('Server unavailable')) as ReturnType<MockClient['search']>;
      }
      return realSearch(resourceType as 'Appointment', query as URLSearchParams, options as undefined);
    }) as MockClient['search'];

    setup();

    expect(await screen.findByText('Could not load appointments', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
  });
});
