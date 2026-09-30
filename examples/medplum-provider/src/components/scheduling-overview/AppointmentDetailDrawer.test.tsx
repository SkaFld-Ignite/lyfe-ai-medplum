// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, userEvent } from '../../test-utils/render';
import type { OverviewAppointment } from '../../utils/scheduling-overview';
import { AppointmentDetailDrawer } from './AppointmentDetailDrawer';

const baseRow: OverviewAppointment = {
  appointment: { resourceType: 'Appointment', id: 'appt-1', status: 'booked', participant: [] },
  // An explicit UTC instant, read back in a UTC clinic zone, so the rendered
  // date and time do not depend on the machine running the test.
  start: new Date(Date.UTC(2026, 8, 29, 9, 0)),
  end: new Date(2026, 8, 29, 9, 45),
  durationMinutes: 45,
  patient: {
    reference: 'Patient/p1',
    id: 'p1',
    name: 'Homer Simpson',
    mrn: 'MRN-001',
    email: 'homer@example.com',
    phone: '555-0100',
    primaryProvider: 'Dr. Alice Smith',
  },
  providerKey: 'Practitioner/dr1',
  providerName: 'Alice Smith',
  locationKey: 'Location/loc1',
  locationName: 'Main Clinic',
  typeLabel: 'Follow-up',
  isVirtual: false,
  reason: 'Knee pain',
  notes: 'Bring imaging',
};

function setup(ui: ReactNode): void {
  render(
    <MedplumProvider medplum={new MockClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </MedplumProvider>
  );
}

describe('AppointmentDetailDrawer', () => {
  test('shows appointment details and patient contact', async () => {
    setup(
      <AppointmentDetailDrawer
        timeZone="UTC"
        opened
        row={baseRow}
        loading={false}
        onClose={vi.fn()}
        onViewPatient={vi.fn()}
      />
    );

    expect(await screen.findByText('Homer Simpson')).toBeInTheDocument();
    expect(screen.getByText('MRN: MRN-001')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText(/September 29, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/· 45 min/)).toBeInTheDocument();
    expect(screen.getByText('Follow-up')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Main Clinic')).toBeInTheDocument();
    expect(screen.getByText('Knee pain')).toBeInTheDocument();
    expect(screen.getByText('Bring imaging')).toBeInTheDocument();
    expect(screen.getByText('homer@example.com')).toBeInTheDocument();
    expect(screen.getByText('555-0100')).toBeInTheDocument();
    expect(screen.getByText('Primary: Dr. Alice Smith')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open full appointment record' })).toHaveAttribute(
      'href',
      '/Appointment/appt-1'
    );
  });

  test('navigates to the patient and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onViewPatient = vi.fn();
    setup(
      <AppointmentDetailDrawer
        timeZone="UTC"
        opened
        row={baseRow}
        loading={false}
        onClose={onClose}
        onViewPatient={onViewPatient}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'View Patient' }));
    expect(onViewPatient).toHaveBeenCalledWith('p1');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('handles a patient with no contact information', async () => {
    setup(
      <AppointmentDetailDrawer
        timeZone="UTC"
        opened
        row={{ ...baseRow, patient: { reference: 'Patient/p2', id: 'p2', name: 'Marge Simpson' } }}
        loading={false}
        onClose={vi.fn()}
        onViewPatient={vi.fn()}
      />
    );
    expect(await screen.findByText('No contact information on file.')).toBeInTheDocument();
    expect(screen.queryByText(/MRN:/)).not.toBeInTheDocument();
  });

  test('disables View Patient when the appointment has no patient', async () => {
    setup(
      <AppointmentDetailDrawer
        timeZone="UTC"
        opened
        row={{ ...baseRow, patient: undefined }}
        loading={false}
        onClose={vi.fn()}
        onViewPatient={vi.fn()}
      />
    );
    expect(await screen.findByRole('button', { name: 'View Patient' })).toBeDisabled();
    expect(screen.getByText('No patient')).toBeInTheDocument();
  });

  test('shows a loading state while the appointment resolves', async () => {
    setup(
      <AppointmentDetailDrawer
        timeZone="UTC"
        opened
        row={undefined}
        loading
        onClose={vi.fn()}
        onViewPatient={vi.fn()}
      />
    );
    expect(await screen.findByLabelText('Loading appointment')).toBeInTheDocument();
  });

  test('explains when the appointment is not in view', async () => {
    setup(
      <AppointmentDetailDrawer
        timeZone="UTC"
        opened
        row={undefined}
        loading={false}
        onClose={vi.fn()}
        onViewPatient={vi.fn()}
      />
    );
    expect(await screen.findByText(/not in the current calendar view/)).toBeInTheDocument();
  });
});
