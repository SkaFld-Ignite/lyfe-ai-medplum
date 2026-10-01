// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, test } from 'vitest';
import { DashboardPage } from './DashboardPage';

function setup(medplum = new MockClient()): void {
  render(
    <MemoryRouter>
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <DashboardPage />
        </MantineProvider>
      </MedplumProvider>
    </MemoryRouter>
  );
}

describe('DashboardPage', () => {
  test('greets the signed-in user', async () => {
    setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Alice Smith$/ })
    ).toBeInTheDocument();
  });

  test('shows the patient counts, schedule, task inbox and critical results', async () => {
    setup();
    expect(screen.getByText('Total patients')).toBeInTheDocument();
    for (const label of ['Gastroenterology', 'Oncology', 'Psychiatry']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('region', { name: "Today's Schedule" })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Critical Results' })).toBeInTheDocument();
  });

  test('reports the server as up once its search answers', async () => {
    setup();
    expect(await screen.findByText('All services nominal')).toBeInTheDocument();
  });

  test('says when there is nothing to review', async () => {
    setup();
    expect(await screen.findByText('No pending tasks')).toBeInTheDocument();
  });
});
