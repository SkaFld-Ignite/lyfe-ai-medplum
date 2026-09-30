// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, userEvent } from '../../test-utils/render';
import type { OverviewAppointment } from '../../utils/scheduling-overview';
import { DayAppointmentsPanel } from './DayAppointmentsPanel';

/**
 * The panel renders in the clinic's zone, so the fixtures are written as
 * explicit UTC instants and the clinic zone is UTC. A local `new Date(y, m, d)`
 * would make these assertions depend on the machine running them.
 */
const DAY = '2026-09-29';
const TZ = 'UTC';

function row(
  id: string,
  hour: number,
  patientName: string,
  providerKey: string,
  providerName: string,
  extra: Partial<OverviewAppointment> = {}
): OverviewAppointment {
  return {
    appointment: { resourceType: 'Appointment', id, status: 'booked', participant: [] },
    start: new Date(Date.UTC(2026, 8, 29, hour, 0)),
    end: new Date(Date.UTC(2026, 8, 29, hour, 30)),
    durationMinutes: 30,
    patient: { reference: `Patient/${id}`, id, name: patientName, mrn: `MRN-${id}` },
    providerKey,
    providerName,
    typeLabel: 'Office visit',
    isVirtual: false,
    ...extra,
  };
}

const rows = [
  row('a1', 11, 'Homer Simpson', 'Practitioner/b', 'Bob Jones', { reason: 'Knee pain', locationName: 'Main Clinic' }),
  row('a2', 9, 'Marge Simpson', 'Practitioner/a', 'Alice Smith'),
  row('a3', 10, 'Lisa Simpson', 'Practitioner/a', 'Alice Smith', {
    appointment: { resourceType: 'Appointment', id: 'a3', status: 'fulfilled', participant: [] },
  }),
  // A different day: must not appear
  row('a4', 9, 'Bart Simpson', 'Practitioner/a', 'Alice Smith', { start: new Date(Date.UTC(2026, 8, 30, 9, 0)) }),
];

describe('DayAppointmentsPanel', () => {
  test('shows the day header, counts and provider groups', () => {
    render(<DayAppointmentsPanel dayKey={DAY} timeZone={TZ} appointments={rows} onSelectAppointment={vi.fn()} />);

    expect(screen.getByText(/September 29, 2026/)).toBeInTheDocument();
    expect(screen.getByText('3 appointments · 2 providers')).toBeInTheDocument();
    expect(screen.queryByText('Bart Simpson')).not.toBeInTheDocument();

    const alice = screen.getByRole('region', { name: 'Alice Smith' });
    expect(within(alice).getByText('2 appts')).toBeInTheDocument();
    expect(within(alice).getByText('Marge Simpson')).toBeInTheDocument();
    expect(within(alice).getByText('Lisa Simpson')).toBeInTheDocument();

    const bob = screen.getByRole('region', { name: 'Bob Jones' });
    expect(within(bob).getByText('1 appt')).toBeInTheDocument();
    expect(within(bob).getByText('Office visit · Main Clinic')).toBeInTheDocument();
    expect(within(bob).getByText('Knee pain')).toBeInTheDocument();
  });

  test('sorts by time when grouping is turned off', async () => {
    const user = userEvent.setup();
    render(<DayAppointmentsPanel dayKey={DAY} timeZone={TZ} appointments={rows} onSelectAppointment={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Sort by time' }));

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    const names = screen
      .getAllByRole('button', { name: / at / })
      .map((button) => button.getAttribute('aria-label')?.split(' at ')[0]);
    expect(names).toEqual(['Marge Simpson', 'Lisa Simpson', 'Homer Simpson']);
  });

  test('searches within the day and can clear the search', async () => {
    const user = userEvent.setup();
    render(<DayAppointmentsPanel dayKey={DAY} timeZone={TZ} appointments={rows} onSelectAppointment={vi.fn()} />);

    await user.type(screen.getByLabelText('Search day appointments'), 'knee');
    expect(screen.getByText('1 of 3 shown · 2 providers')).toBeInTheDocument();
    expect(screen.getByText('Homer Simpson')).toBeInTheDocument();
    expect(screen.queryByText('Marge Simpson')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search day appointments'));
    await user.type(screen.getByLabelText('Search day appointments'), 'nobody');
    expect(screen.getByText('No matches')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Marge Simpson')).toBeInTheDocument();
  });

  test('clears the search when the day changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DayAppointmentsPanel dayKey={DAY} timeZone={TZ} appointments={rows} onSelectAppointment={vi.fn()} />
    );

    await user.type(screen.getByLabelText('Search day appointments'), 'knee');
    rerender(
      <DayAppointmentsPanel dayKey="2026-09-30" timeZone={TZ} appointments={rows} onSelectAppointment={vi.fn()} />
    );

    expect(screen.getByLabelText('Search day appointments')).toHaveValue('');
    expect(screen.getByText('Bart Simpson')).toBeInTheDocument();
  });

  test('calls back with the selected appointment', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<DayAppointmentsPanel dayKey={DAY} timeZone={TZ} appointments={rows} onSelectAppointment={onSelect} />);

    await user.click(screen.getByRole('button', { name: /^Homer Simpson at/ }));

    expect(onSelect).toHaveBeenCalledWith(rows[0]);
  });

  test('shows an empty state for a day with no appointments', () => {
    render(
      <DayAppointmentsPanel dayKey="2026-10-01" timeZone={TZ} appointments={rows} onSelectAppointment={vi.fn()} />
    );

    expect(screen.getByText('No appointments on this day')).toBeInTheDocument();
    expect(screen.getByText('0 appointments')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search day appointments')).not.toBeInTheDocument();
  });

  test('shows a skeleton while loading', () => {
    render(<DayAppointmentsPanel dayKey={DAY} timeZone={TZ} appointments={[]} loading onSelectAppointment={vi.fn()} />);
    expect(screen.getByLabelText('Loading day schedule')).toBeInTheDocument();
  });
});
