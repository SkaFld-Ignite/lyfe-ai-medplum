// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { HomerSimpson, MockClient } from '@medplum/mock';
import * as medplumReact from '@medplum/react';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { EditTab } from './EditTab';
import { PatientOverviewTab } from './PatientOverviewTab';
import { PatientPage } from './PatientPage';
import { TimelineTab } from './TimelineTab';

describe('PatientPage', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    medplum = new MockClient();
    vi.clearAllMocks();
  });

  const setup = (initialPath = '/Patient/patient-123'): ReturnType<typeof render> => {
    window.history.pushState({}, '', initialPath);
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Notifications />
            <Routes>
              <Route path="/Patient/:patientId/*" element={<PatientPage />}>
                <Route path="edit" element={<EditTab />} />
                <Route path="overview" element={<PatientOverviewTab />} />
                <Route path="timeline" element={<TimelineTab />} />
                <Route path="" element={<PatientOverviewTab />} />
                <Route path="*" element={<PatientOverviewTab />} />
              </Route>
            </Routes>
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  };

  const selectedTab = (): string | null => screen.getByRole('tab', { selected: true }).textContent;

  test('shows the page layout with placeholders while the patient is loading', async () => {
    // A patient read that never resolves keeps the page in its loading state.
    vi.spyOn(medplum, 'readReference').mockReturnValue(new Promise(() => {}) as never);
    setup(`/Patient/${HomerSimpson.id}`);

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(document.querySelectorAll('.mantine-Skeleton-root').length).toBeGreaterThan(0);
  });

  test('shows the menu but not the section content while the patient is loading', async () => {
    vi.spyOn(medplum, 'readReference').mockReturnValue(new Promise(() => {}) as never);
    setup(`/Patient/${HomerSimpson.id}`);

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Chart summary' })).not.toBeInTheDocument();
  });

  test('clears the placeholders once the patient has loaded', async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    await waitFor(() => {
      expect(document.querySelector('[aria-busy="false"]')).toBeInTheDocument();
    });
  });

  test("lists the Lyfe sections in order, then Medplum's", async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    const menu = await screen.findByRole('tablist', { name: 'Patient details' });
    expect(menu).toHaveAttribute('aria-orientation', 'vertical');
    const names = within(menu)
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(names.slice(0, 13)).toEqual([
      'Overview',
      'Demographics',
      'Timeline',
      // Natural-language search over this chart, next to Timeline because it is
      // the other way of asking what is in the chart rather than a clinical section.
      'Chart Search',
      'Labs',
      'Orders',
      'Conditions',
      'Medications',
      'Vitals',
      'Allergies',
      'Immunizations',
      'Documents',
      'Encounters/Notes',
    ]);
    expect(names).toContain('Tasks');
    expect(names).toContain('Export');
    // Medplum's edit form stays reachable from Demographics, not as its own menu item.
    expect(names).not.toContain('Edit');
  });

  test('opens on Overview, like the Lyfe chart', async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    await waitFor(() => expect(selectedTab()).toBe('Overview'));
    expect(await screen.findByRole('region', { name: 'Chart summary' })).toBeInTheDocument();
  });

  test('handles an empty trailing path and unknown paths', async () => {
    setup(`/Patient/${HomerSimpson.id}/`);
    await waitFor(() => expect(selectedTab()).toBe('Overview'));
  });

  test('selects the section matching the URL, case-insensitively', async () => {
    setup(`/Patient/${HomerSimpson.id}/TIMELINE`);
    await waitFor(() => expect(selectedTab()).toBe('Timeline'));
  });

  test("highlights Demographics on Medplum's edit form, in any case", async () => {
    setup(`/Patient/${HomerSimpson.id}/EDIT`);
    await waitFor(() => expect(selectedTab()).toBe('Demographics'));
  });

  test('handles tab change when clicking on a section', async () => {
    const user = userEvent.setup();
    setup(`/Patient/${HomerSimpson.id}`);

    await user.click(await screen.findByRole('tab', { name: 'Timeline' }));
    await waitFor(() => expect(selectedTab()).toBe('Timeline'));
  });

  test('shows the patient identity in the sidebar', async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    const identity = await screen.findByTestId('patient-identity');
    expect(within(identity).getByRole('heading', { name: 'Homer Simpson' })).toBeInTheDocument();
    expect(within(identity).getByText('Male')).toBeInTheDocument();
    expect(within(identity).getByText('05/12/1956')).toBeInTheDocument();
    expect(within(identity).getByText('Active')).toBeInTheDocument();
  });

  test('keeps the Medplum clinical summary in the Overview section', async () => {
    const patientSummarySpy = vi.spyOn(medplumReact, 'PatientSummary');
    setup(`/Patient/${HomerSimpson.id}/overview`);

    expect(await screen.findByRole('region', { name: 'Chart summary' })).toBeInTheDocument();
    await waitFor(() => expect(patientSummarySpy).toHaveBeenCalled());
  });
});
