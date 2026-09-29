// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TimelineTab } from './TimelineTab';

const viewSpy = vi.hoisted(() => vi.fn());

vi.mock('../../components/patient-timeline/PatientTimelineView', () => ({
  PatientTimelineView: (props: { patientId: string }) => {
    viewSpy(props);
    return <div data-testid="patient-timeline" />;
  },
}));

describe('TimelineTab', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    viewSpy.mockClear();
  });

  const setup = (url: string): ReturnType<typeof render> => {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Routes>
              <Route path="/Patient/:patientId/timeline" element={<TimelineTab />} />
            </Routes>
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  };

  test('Renders the timeline for the patient in the route', async () => {
    setup(`/Patient/${HomerSimpson.id}/timeline`);

    expect(await screen.findByTestId('patient-timeline')).toBeInTheDocument();
    expect(viewSpy).toHaveBeenCalledWith({ patientId: HomerSimpson.id });
  });

  test('Renders a loader while the patient is unresolved', async () => {
    const { container } = setup('/Patient/does-not-exist/timeline');

    await waitFor(() => expect(container.querySelector('.mantine-Loader-root')).toBeInTheDocument());
    expect(viewSpy).not.toHaveBeenCalled();
  });
});
