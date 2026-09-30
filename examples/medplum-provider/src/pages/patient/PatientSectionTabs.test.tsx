// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, test } from 'vitest';
import type { PatientSectionTab } from './PatientSectionTabs';
import { PatientSectionTabs } from './PatientSectionTabs';

const tabs: PatientSectionTab[] = [
  { id: 'timeline', label: 'Timeline', value: 'timeline' },
  { id: 'encounter', label: 'Visits', value: 'Encounter' },
  { id: 'meds', label: 'Meds', value: 'MedicationRequest?_sort=-_lastUpdated&patient=p1' },
  { id: 'custom', label: 'Custom', value: 'custom' },
];

function setup(path: string): ReturnType<typeof createMemoryRouter> {
  const router = createMemoryRouter(
    [{ path: '/Patient/p1/*', element: <PatientSectionTabs baseUrl="/Patient/p1" tabs={tabs} /> }],
    { initialEntries: [path] }
  );
  render(
    <MantineProvider>
      <RouterProvider router={router} />
    </MantineProvider>
  );
  return router;
}

function selectedTab(): string | null {
  return screen.getByRole('tab', { selected: true }).textContent;
}

describe('PatientSectionTabs', () => {
  test('renders every tab with a link to its section', () => {
    setup('/Patient/p1');
    expect(screen.getByRole('tablist', { name: 'Patient details' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Meds' })).toHaveAttribute(
      'href',
      '/Patient/p1/MedicationRequest?_sort=-_lastUpdated&patient=p1'
    );
    // Every tab has an icon, including ones without a dedicated icon.
    expect(document.querySelectorAll('[role="tab"] svg')).toHaveLength(4);
  });

  test('defaults to the first tab', () => {
    setup('/Patient/p1');
    expect(selectedTab()).toBe('Timeline');
  });

  test('keeps the section highlighted on its detail pages', () => {
    setup('/Patient/p1/Encounter/e1');
    expect(selectedTab()).toBe('Visits');
  });

  test('matches tabs whose value carries a query string', () => {
    setup('/Patient/p1/medicationrequest?patient=p1');
    expect(selectedTab()).toBe('Meds');
  });

  test('navigates when a tab is clicked', async () => {
    const user = userEvent.setup();
    const router = setup('/Patient/p1');
    await user.click(screen.getByText('Visits'));
    expect(router.state.location.pathname).toBe('/Patient/p1/Encounter');
    expect(selectedTab()).toBe('Visits');
  });
});
