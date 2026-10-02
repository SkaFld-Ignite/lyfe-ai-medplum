// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The re-sync control, as a provider sees it.
 *
 * Three things are worth pinning down, and none of them is layout:
 *
 *  - **It does not appear when it cannot work.** A clinic with no network
 *    integration connected, or a deployment with no import worker, gets no
 *    card. A disabled button explaining a feature the deployment does not have
 *    is noise on a clinical page.
 *  - **It says when the record was last pulled.** That is the question someone
 *    opening a chart actually has, and answering it is most of the value of
 *    the control.
 *  - **It cannot be pressed while a pull is open.** Not because pressing twice
 *    corrupts anything — the worker serialises per patient — but because a
 *    button that does nothing visible is how people end up pressing it six
 *    times.
 */
import { MantineProvider } from '@mantine/core';
import type { Task } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const listResyncSources = vi.fn();
const queuePatientResync = vi.fn();
vi.mock('../../services/resync', () => ({
  listResyncSources: (...args: unknown[]) => listResyncSources(...args),
  queuePatientResync: (...args: unknown[]) => queuePatientResync(...args),
}));

const { RecordSyncCard } = await import('./RecordSyncCard');

const PATIENT_ID = 'pat-1';
let medplum: MockClient;

/**
 * Put a `zus-import` Task on the server for the patient.
 * @param props - The run to record.
 * @param props.status - FHIR Task status.
 * @param props.end - When it finished, when it did.
 * @param props.total - Resources written.
 */
async function recordRun(props: { status: string; end?: string; total?: number }): Promise<void> {
  await medplum.createResource<Task>({
    resourceType: 'Task',
    status: props.status as Task['status'],
    intent: 'order',
    code: { text: 'zus-import' },
    for: { reference: `Patient/${PATIENT_ID}` },
    authoredOn: '2026-09-01T10:00:00.000Z',
    executionPeriod: { start: '2026-09-01T10:00:00.000Z', end: props.end },
    output: props.total ? [{ type: { text: 'Condition' }, valueInteger: props.total }] : undefined,
  });
}

/** Render the card. */
function setup(): void {
  render(
    <MedplumProvider medplum={medplum}>
      <MantineProvider>
        <RecordSyncCard patientId={PATIENT_ID} />
      </MantineProvider>
    </MedplumProvider>
  );
}

describe('RecordSyncCard', () => {
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
    expect(screen.queryByText('Record sync')).not.toBeInTheDocument();
  });

  test('says the record has never been pulled when there is no run', async () => {
    setup();
    expect(await screen.findByText('Never synced')).toBeInTheDocument();
    // The vendor name is never shown; the product calls this source Lyfe.
    expect(screen.getByText('Lyfe')).toBeInTheDocument();
    expect(screen.queryByText(/zus/i)).not.toBeInTheDocument();
  });

  test('shows when the last pull finished and what it brought back', async () => {
    await recordRun({ status: 'completed', end: '2026-09-01T10:04:00.000Z', total: 12 });
    setup();
    expect(await screen.findByText(/Last synced .*12 records/)).toBeInTheDocument();
  });

  test('cannot be pressed while a pull is still open', async () => {
    await recordRun({ status: 'in-progress' });
    setup();
    const button = await screen.findByRole('button', { name: /syncing/i });
    expect(button).toBeDisabled();
  });

  test('says so when the last attempt failed', async () => {
    await recordRun({ status: 'failed', end: '2026-09-01T10:04:00.000Z' });
    setup();
    expect(await screen.findByText(/failed/)).toBeInTheDocument();
    // And it can be tried again, which is the point of saying it failed.
    expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
  });
});
