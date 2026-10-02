// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The sidebar's re-sync control.
 *
 * The same three questions the Overview card answers, asked of the compact
 * version — because a duplicated action is exactly where behaviour drifts:
 *
 *  - **It does not appear when it cannot work**, matching the card. A clinic
 *    with nothing connected should see no control, not a disabled one.
 *  - **It cannot be pressed while a pull is open.** The worker serialises per
 *    patient so a second press is harmless, but a button that does nothing
 *    visible is how someone ends up pressing it six times.
 *  - **It triggers the same path as the card**, so the two cannot start
 *    different work.
 */
import { MantineProvider } from '@mantine/core';
import type { Task } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const listResyncSources = vi.fn();
const queuePatientResync = vi.fn();
vi.mock('../../services/resync', () => ({
  listResyncSources: (...args: unknown[]) => listResyncSources(...args),
  queuePatientResync: (...args: unknown[]) => queuePatientResync(...args),
}));

const { SidebarSyncButton } = await import('./SidebarSyncButton');

const PATIENT_ID = 'pat-1';
let medplum: MockClient;

/**
 * Put a `zus-import` Task on the server for the patient.
 * @param props - The run to record.
 * @param props.status - FHIR Task status.
 * @param props.end - When it finished, when it did.
 */
async function recordRun(props: { status: string; end?: string }): Promise<void> {
  await medplum.createResource<Task>({
    resourceType: 'Task',
    status: props.status as Task['status'],
    intent: 'order',
    code: { text: 'zus-import' },
    for: { reference: `Patient/${PATIENT_ID}` },
    authoredOn: '2026-09-01T10:00:00.000Z',
    executionPeriod: { start: '2026-09-01T10:00:00.000Z', end: props.end },
  });
}

/** Render the button. */
function setup(): void {
  render(
    <MedplumProvider medplum={medplum}>
      <MantineProvider>
        <SidebarSyncButton patientId={PATIENT_ID} />
      </MantineProvider>
    </MedplumProvider>
  );
}

describe('SidebarSyncButton', () => {
  beforeEach(() => {
    medplum = new MockClient();
    listResyncSources.mockReset().mockResolvedValue([{ id: 'zus', label: 'Lyfe' }]);
    queuePatientResync.mockReset().mockResolvedValue({ queued: true, source: 'zus', patientId: PATIENT_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders nothing when the clinic has no source to pull from', async () => {
    listResyncSources.mockResolvedValue([]);
    setup();
    await waitFor(() => expect(listResyncSources).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /sync/i })).not.toBeInTheDocument();
  });

  test('offers a sync once a source is available', async () => {
    setup();
    expect(await screen.findByRole('button', { name: /^sync$/i })).toBeInTheDocument();
    // The vendor name never reaches the sidebar either.
    expect(screen.queryByText(/zus/i)).not.toBeInTheDocument();
  });

  test('pressing it queues the pull through the same path the card uses', async () => {
    setup();
    const button = await screen.findByRole('button', { name: /^sync$/i });
    await userEvent.click(button);
    await waitFor(() => expect(queuePatientResync).toHaveBeenCalledTimes(1));
    expect(queuePatientResync.mock.calls[0][1]).toEqual({ patientId: PATIENT_ID, source: 'zus' });
  });

  test('does not offer a second run while one is open', async () => {
    await recordRun({ status: 'in-progress' });
    setup();
    const button = await screen.findByRole('button', { name: /syncing/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(queuePatientResync).not.toHaveBeenCalled();
  });

  test('a finished run leaves the control usable again', async () => {
    await recordRun({ status: 'completed', end: '2026-09-01T10:04:00.000Z' });
    setup();
    const button = await screen.findByRole('button', { name: /^sync$/i });
    expect(button).toBeEnabled();
  });
});
