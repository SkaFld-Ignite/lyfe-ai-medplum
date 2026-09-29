// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { createReference } from '@medplum/core';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PatientTimelineView } from './PatientTimelineView';
import { DAYS_PER_PAGE } from './timeline-config';

const patient = createReference(HomerSimpson);
const tag = (code: string): { tag: { system: string; code: string }[] } => ({
  tag: [{ system: 'https://lyfe.com/source', code }],
});

function isoDaysFromNow(days: number, hour = 9): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

describe('PatientTimelineView', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    medplum = new MockClient();
    // MockClient seeds Homer with an Encounter and Observations; start from a clean slate for him.
    for (const type of ['Encounter', 'Observation', 'Condition', 'Appointment', 'DocumentReference'] as const) {
      const existing = await medplum.searchResources(type, { patient: `Patient/${HomerSimpson.id}` });
      for (const r of existing) {
        await medplum.deleteResource(type, r.id);
      }
    }
    const visit = await medplum.createResource({
      resourceType: 'Encounter',
      meta: tag('drchrono'),
      status: 'finished',
      class: { code: 'AMB' },
      type: [{ text: 'Office Visit, Est Pt.' }],
      subject: patient,
      participant: [{ individual: { display: 'Dr. Chen' } }],
      period: { start: isoDaysFromNow(-3) },
      reasonCode: [{ text: 'Abdominal pain follow-up' }],
      diagnosis: [{ condition: { display: 'GERD' } }],
    });
    await medplum.createResource({
      resourceType: 'Encounter',
      meta: tag('drchrono'),
      status: 'finished',
      class: { code: 'EMER' },
      subject: patient,
      period: { start: isoDaysFromNow(-40, 22) },
    });
    await medplum.createResource({
      resourceType: 'Observation',
      meta: tag('drchrono'),
      status: 'final',
      category: [{ coding: [{ code: 'vital-signs' }] }],
      code: { text: 'Heart rate' },
      subject: patient,
      encounter: createReference(visit),
      effectiveDateTime: isoDaysFromNow(-3),
      valueQuantity: { value: 74, unit: '/min' },
    });
    await medplum.createResource({
      resourceType: 'Observation',
      meta: tag('drchrono'),
      status: 'final',
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { text: 'ALT' },
      subject: patient,
      effectiveDateTime: isoDaysFromNow(-12),
      valueQuantity: { value: 48, unit: 'U/L' },
    });
    await medplum.createResource({
      resourceType: 'Condition',
      meta: tag('drchrono'),
      subject: patient,
      code: { text: 'GERD', coding: [{ code: 'K21.9' }] },
      clinicalStatus: { coding: [{ code: 'active' }] },
      onsetDateTime: isoDaysFromNow(-40, 23),
    });
    await medplum.createResource({
      resourceType: 'Condition',
      meta: tag('drchrono'),
      subject: patient,
      code: { text: 'Fatty liver disease' },
    });
    // Data from other sources is never shown.
    await medplum.createResource({
      resourceType: 'Encounter',
      meta: tag('zus'),
      status: 'finished',
      class: { code: 'AMB' },
      type: [{ text: 'Zus-only visit' }],
      subject: patient,
      period: { start: isoDaysFromNow(-5) },
    });
    await medplum.createResource({
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Untagged lab' },
      subject: patient,
      effectiveDateTime: isoDaysFromNow(-6),
    });
  });

  function setup(): ReturnType<typeof createMemoryRouter> {
    const router = createMemoryRouter(
      [
        { path: '/Patient/:id/timeline', element: <PatientTimelineView patientId={HomerSimpson.id as string} /> },
        { path: '/Patient/:id/*', element: <div>Chart page</div> },
      ],
      { initialEntries: [`/Patient/${HomerSimpson.id}/timeline`] }
    );
    render(
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <RouterProvider router={router} />
        </MantineProvider>
      </MedplumProvider>
    );
    return router;
  }

  async function waitForTimeline(): Promise<void> {
    await screen.findByText('Office Visit, Est Pt.', undefined, { timeout: 5000 });
  }

  test('renders the header, stats and day sections', async () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Patient Timeline' })).toBeInTheDocument();
    await waitForTimeline();

    // Office visit, emergency visit, GERD condition, and one day of unlinked labs.
    expect(screen.getByLabelText('Total events: 4')).toBeInTheDocument();
    expect(screen.getAllByTestId('timeline-event')).toHaveLength(4);
    // Emergency visits get an eyebrow and fall back to the class-based title.
    expect(screen.getAllByText('Emergency visit').length).toBeGreaterThan(1);
    expect(screen.getByText('1 lab result')).toBeInTheDocument();
    expect(screen.getByText('Showing', { exact: false })).toHaveTextContent('Showing 4 of 4 · 100%');
  });

  test('expands a visit to show its linked records and opens a record', async () => {
    const user = userEvent.setup();
    const router = setup();
    await waitForTimeline();

    await user.click(screen.getByRole('button', { name: /Office Visit, Est Pt\./ }));
    expect(screen.getByText('Abdominal pain follow-up')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open full encounter/ })).toHaveAttribute(
      'href',
      expect.stringMatching(new RegExp(`^/Patient/${HomerSimpson.id}/Encounter/`))
    );

    await user.click(screen.getByRole('button', { name: 'Vitals (1)' }));
    await user.click(await screen.findByRole('button', { name: 'View Heart rate' }));

    const drawer = await screen.findByRole('dialog');
    // The title, and the record's own Code field once its schema has loaded.
    expect(within(drawer).getAllByText('Heart rate').length).toBeGreaterThan(0);
    await user.click(within(drawer).getByRole('button', { name: /Open in chart/ }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/Patient\/.+\/Observation\//));
  });

  test('searches and filters', async () => {
    const user = userEvent.setup();
    setup();
    await waitForTimeline();

    await user.type(screen.getByLabelText('Search timeline'), 'heart');
    await waitFor(() => expect(screen.getAllByTestId('timeline-event')).toHaveLength(1));
    expect(screen.getByText('Active filters:')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(screen.getAllByTestId('timeline-event')).toHaveLength(4));

    await user.click(screen.getByRole('button', { name: 'Filter by all types' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Conditions (1)' }));
    await waitFor(() => expect(screen.getAllByTestId('timeline-event')).toHaveLength(1));
    expect(screen.getByText('Onset', { exact: false })).toBeInTheDocument();
  });

  test('shows only DrChrono data', async () => {
    setup();
    await waitForTimeline();

    expect(screen.queryByText('Zus-only visit')).not.toBeInTheDocument();
    expect(screen.queryByText('Untagged lab')).not.toBeInTheDocument();
    // With a single source there is nothing to filter by.
    expect(screen.queryByRole('button', { name: 'Filter by source' })).not.toBeInTheDocument();
  });

  test('groups by condition', async () => {
    const user = userEvent.setup();
    setup();
    await waitForTimeline();

    await user.click(within(screen.getByLabelText('Group timeline by')).getByText('Condition'));

    const gerd = await screen.findByRole('region', { name: 'GERD' });
    expect(within(gerd).getByText('2 events')).toBeInTheDocument();
    expect(within(gerd).getByText('Office Visit, Est Pt.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Other / Uncategorized' })).toBeInTheDocument();
  });

  test('shows undated items under Ongoing Care', async () => {
    const user = userEvent.setup();
    setup();
    await waitForTimeline();

    await user.click(screen.getByRole('button', { name: /Ongoing Care/ }));
    expect(await screen.findByText('Fatty liver disease')).toBeInTheDocument();
  });

  test('pages older days', async () => {
    const user = userEvent.setup();
    for (let i = 0; i < DAYS_PER_PAGE + 5; i++) {
      await medplum.createResource({
        resourceType: 'Observation',
        meta: tag('drchrono'),
        status: 'final',
        category: [{ coding: [{ code: 'vital-signs' }] }],
        code: { text: `Weight ${i}` },
        subject: patient,
        effectiveDateTime: isoDaysFromNow(-100 - i),
      });
    }
    setup();
    await waitForTimeline();

    // 3 seeded days (the ER visit and GERD onset share one) + 25 older days = 28; the first 20 show.
    const button = await screen.findByRole('button', { name: /Show older/ });
    expect(button).toHaveTextContent('Show older (8 more days)');
    await user.click(button);
    expect(screen.queryByRole('button', { name: /Show older/ })).not.toBeInTheDocument();
  });

  test('shows an error when loading fails', async () => {
    vi.spyOn(medplum, 'search').mockRejectedValue(new Error('Server unavailable'));
    setup();
    expect(await screen.findByText('Could not load the timeline')).toBeInTheDocument();
    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
  });

  test('shows an empty state for a patient with no history', async () => {
    vi.spyOn(medplum, 'search').mockResolvedValue({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [],
    } as unknown as Awaited<ReturnType<MockClient['search']>>);
    setup();
    expect(await screen.findByText('No history yet')).toBeInTheDocument();
  });
});
