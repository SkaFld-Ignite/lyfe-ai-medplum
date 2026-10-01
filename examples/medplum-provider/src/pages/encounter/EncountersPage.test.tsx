// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { Encounter, Patient, Practitioner, Task } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LYFE_SOURCE_TAG_SYSTEM } from '../../utils/data-source';
import { EncountersPage } from './EncountersPage';

const QUERY = '?_count=20&_fields=_lastUpdated,period,status,serviceType&_sort=-_lastUpdated';

describe('EncountersPage', () => {
  let medplum: MockClient;
  let patient: WithId<Patient>;
  let practitioner: WithId<Practitioner>;

  beforeEach(async () => {
    medplum = new MockClient();
    patient = await medplum.createResource({
      resourceType: 'Patient',
      name: [{ given: ['Jane'], family: 'Doe' }],
    });
    practitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      name: [{ given: ['Gregory'], family: 'House' }],
    });
    vi.clearAllMocks();
    notifications.clean();
    notifications.cleanQueue();
  });

  async function createVisit(subject: WithId<Patient>, props?: Partial<Encounter>): Promise<WithId<Encounter>> {
    return medplum.createResource<Encounter>({
      resourceType: 'Encounter',
      meta: { tag: [{ system: LYFE_SOURCE_TAG_SYSTEM, code: 'drchrono' }] },
      status: 'in-progress',
      class: { code: 'AMB', display: 'Ambulatory' },
      type: [{ text: 'Office Visit' }],
      period: { start: '2026-08-10T09:00:00Z' },
      subject: createReference(subject),
      participant: [{ individual: createReference(practitioner) }],
      ...props,
    });
  }

  function renderAt(path: string): ReturnType<typeof render> {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Notifications />
            <Routes>
              <Route path="/Patient/:patientId/Encounter" element={<EncountersPage />} />
              <Route path="/Patient/:patientId/Encounter/:encounterId/Task?/:taskId?" element={<EncountersPage />} />
            </Routes>
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  }

  function setup(encounterId?: string): ReturnType<typeof render> {
    const path = encounterId
      ? `/Patient/${patient.id}/Encounter/${encounterId}${QUERY}`
      : `/Patient/${patient.id}/Encounter${QUERY}`;
    return renderAt(path);
  }

  test('Lists the patient encounters with type, status, and practitioner', async () => {
    await createVisit(patient);
    setup();

    expect(await screen.findByText('Office Visit')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(await screen.findByText(/Gregory House/)).toBeInTheDocument();
  });

  test('Excludes encounters of other patients', async () => {
    const other: WithId<Patient> = await medplum.createResource({
      resourceType: 'Patient',
      name: [{ given: ['John'], family: 'Smith' }],
    });
    await createVisit(patient, { type: [{ text: 'Office Visit' }] });
    await createVisit(other, { type: [{ text: 'Telehealth Visit' }] });
    setup();

    expect(await screen.findByText('Office Visit')).toBeInTheDocument();
    expect(screen.queryByText('Telehealth Visit')).not.toBeInTheDocument();
  });

  test('Lists only DrChrono visits', async () => {
    await createVisit(patient, { type: [{ text: 'Office Visit' }] });
    // An old Lyfe booking synced through Zus, and a visit with no source tag.
    await createVisit(patient, {
      type: [{ text: 'Lyfe booking' }],
      meta: { tag: [{ system: LYFE_SOURCE_TAG_SYSTEM, code: 'zus' }] },
      identifier: [{ system: 'https://lyfeco.ai/appointments', value: 'a1' }],
    });
    await createVisit(patient, { type: [{ text: 'Untagged visit' }], meta: undefined });
    // A _tag in the URL cannot widen the list.
    renderAt(`/Patient/${patient.id}/Encounter${QUERY}&_tag=${encodeURIComponent(`${LYFE_SOURCE_TAG_SYSTEM}|zus`)}`);

    expect(await screen.findByText('Office Visit')).toBeInTheDocument();
    expect(screen.queryByText('Lyfe booking')).not.toBeInTheDocument();
    expect(screen.queryByText('Untagged visit')).not.toBeInTheDocument();
  });

  test('Shows the encounter chart as the detail pane for the selected encounter', async () => {
    const encounter = await createVisit(patient);
    setup(encounter.id);

    expect(await screen.findByText('Note & Tasks')).toBeInTheDocument();
    expect(screen.getByText('Details & Billing')).toBeInTheDocument();
  });

  test('Shows the visits as one full-width list without opening one', async () => {
    await createVisit(patient);
    setup();

    expect(await screen.findByText('Office Visit')).toBeInTheDocument();
    expect(screen.queryByText('Note & Tasks')).not.toBeInTheDocument();
  });

  test('Opens a visit in place of the list, with a link back to all visits', async () => {
    const encounter = await createVisit(patient);
    setup(encounter.id);

    expect(await screen.findByText('Note & Tasks')).toBeInTheDocument();
    // The list is not shown beside the open visit.
    expect(screen.queryByText('Visits')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All visits' })).toHaveAttribute(
      'href',
      expect.stringMatching(new RegExp(`^/Patient/${patient.id}/Encounter\\?`))
    );
  });

  test('Shows the empty state when the patient has no encounters', async () => {
    setup();

    expect(await screen.findByText('No visits.')).toBeInTheDocument();
  });

  test('Keeps the task modal open through the search-normalization redirect', async () => {
    const encounter = await createVisit(patient);
    const task = await medplum.createResource<Task>({
      resourceType: 'Task',
      status: 'in-progress',
      intent: 'order',
      code: { text: 'Review Labs' },
      for: createReference(patient),
      encounter: createReference(encounter),
    });
    // No query string, mimicking a relative navigation from the task panel.
    renderAt(`/Patient/${patient.id}/Encounter/${encounter.id}/Task/${task.id}`);

    // The modal title renders the task code as a heading.
    expect(await screen.findByRole('heading', { name: 'Review Labs' })).toBeInTheDocument();
    // Wait for the list to load after the redirect pins the normalized query.
    // 'Office Visit' appears in both the list row and the chart header.
    expect((await screen.findAllByText('Office Visit')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Review Labs' })).toBeInTheDocument();
  });

  test('Reflects a task saved in the modal on the chart task list', async () => {
    const user = userEvent.setup();
    const encounter = await createVisit(patient);
    const task = await medplum.createResource<Task>({
      resourceType: 'Task',
      status: 'in-progress',
      intent: 'order',
      code: { text: 'Review Labs' },
      for: createReference(patient),
      encounter: createReference(encounter),
    });
    vi.spyOn(medplum, 'updateResource').mockResolvedValue({ ...task, status: 'completed' });
    renderAt(`/Patient/${patient.id}/Encounter/${encounter.id}/Task/${task.id}`);

    expect(await screen.findByRole('heading', { name: 'Review Labs' })).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();

    await user.click(await screen.findByText('Save Changes'));

    // The modal closes and the chart's task badge shows the saved status.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Review Labs' })).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Completed')).toBeInTheDocument();
  });

  test('Reflects a status change from the chart on the list row', async () => {
    const user = userEvent.setup();
    const encounter = await createVisit(patient);
    setup(encounter.id);

    // The open visit fills the page, so its status shows once, on the chart header button.
    expect(await screen.findByRole('button', { name: 'In Progress' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'In Progress' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Finished' }));
    expect(await screen.findByRole('button', { name: 'Finished' })).toBeInTheDocument();

    // The change is saved, so the list shows it when the user goes back.
    await waitFor(async () => expect((await medplum.readResource('Encounter', encounter.id)).status).toBe('finished'));
  });
});
