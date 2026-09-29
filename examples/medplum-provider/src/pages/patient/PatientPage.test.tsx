// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { calculateAgeString } from '@medplum/core';
import { HomerSimpson, MockClient } from '@medplum/mock';
import * as medplumReact from '@medplum/react';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { EditTab } from './EditTab';
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
                <Route path="" element={<TimelineTab />} />
                <Route path="*" element={<TimelineTab />} />
              </Route>
            </Routes>
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  };

  test('shows the page layout with placeholders while the patient is loading', async () => {
    // A patient read that never resolves keeps the page in its loading state.
    vi.spyOn(medplum, 'readReference').mockReturnValue(new Promise(() => {}) as never);
    setup(`/Patient/${HomerSimpson.id}`);

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(document.querySelectorAll('.mantine-Skeleton-root').length).toBeGreaterThan(0);
  });

  test('renders patient page when patient is loaded', async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    await waitFor(() => {
      expect(screen.getByText('Timeline')).toBeInTheDocument();
    });
  });

  test('renders all tabs in navigation', async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    await waitFor(() => {
      expect(screen.getByText('Timeline')).toBeInTheDocument();
    });

    // Check for some key tabs
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Visits')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Meds')).toBeInTheDocument();
  });

  test('sets initial tab from URL path', async () => {
    setup(`/Patient/${HomerSimpson.id}/edit`);

    await waitFor(() => {
      const editTab = screen.getByText('Edit');
      expect(editTab).toBeInTheDocument();
      expect(editTab.closest('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
    });
  });

  test('handles tab change when clicking on tab', async () => {
    const user = userEvent.setup();
    setup(`/Patient/${HomerSimpson.id}`);

    await waitFor(() => {
      expect(screen.getByText('Timeline')).toBeInTheDocument();
    });

    const editTab = screen.getByText('Edit');
    await user.click(editTab);

    await waitFor(() => {
      const editTab = screen.getByText('Edit');
      expect(editTab).toBeInTheDocument();
      expect(editTab.closest('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
    });
  });

  test('shows the tabs but not the tab content while the patient is loading', async () => {
    // A patient read that never resolves keeps the page in its loading state.
    vi.spyOn(medplum, 'readReference').mockReturnValue(new Promise(() => {}) as never);
    setup(`/Patient/${HomerSimpson.id}`);

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('patient-timeline')).not.toBeInTheDocument();
  });

  test('clears the placeholders once the patient has loaded', async () => {
    setup(`/Patient/${HomerSimpson.id}`);

    await waitFor(() => {
      expect(document.querySelector('[aria-busy="false"]')).toBeInTheDocument();
    });
  });

  test('defaults to timeline tab when URL does not match any tab', async () => {
    setup(`/Patient/${HomerSimpson.id}/unknown-path`);

    await waitFor(() => {
      const timelineTab = screen.getByText('Timeline');
      expect(timelineTab).toBeInTheDocument();
      expect(timelineTab.closest('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
    });
  });

  test('renders homer summary information in sidebar', async () => {
    const patientSummarySpy = vi.spyOn(medplumReact, 'PatientSummary');
    setup(`/Patient/${HomerSimpson.id}`);

    if (!HomerSimpson.birthDate) {
      throw new Error('Test data in unexpected state - homer has no birthdate');
    }

    const age = calculateAgeString(HomerSimpson.birthDate);

    await waitFor(() => {
      expect(patientSummarySpy).toHaveBeenCalled();
    });
    expect(await screen.findByText('Male')).toBeInTheDocument();
    expect(await screen.findByText(`1956-05-12 (${age})`)).toBeInTheDocument();
  });

  test('handles empty pathname correctly', async () => {
    setup(`/Patient/${HomerSimpson.id}/`);

    await waitFor(() => {
      const timelineTab = screen.getByText('Timeline');
      expect(timelineTab).toBeInTheDocument();
      expect(timelineTab.closest('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
    });
  });

  test('highlights the Edit tab in a case-insensitive way even when /EDIT is used', async () => {
    setup(`/Patient/${HomerSimpson.id}/EDIT`);

    await waitFor(() => {
      const editTab = screen.getByText('Edit');
      expect(editTab).toBeInTheDocument();
      expect(editTab.closest('[role="tab"]')).toHaveAttribute('aria-selected', 'true');
    });
  });
});
