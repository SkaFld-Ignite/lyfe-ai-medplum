// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, test, vi } from 'vitest';
import { dispatchSwitchTab } from './citations';
import { LyfeAiLauncher } from './LyfeAiLauncher';
import { patientIdFromPathname } from './patient-route';

/** `SpacesInbox` pulls in the whole chat; the launcher's job is the chrome around it. */
vi.mock('../spaces/SpacesInbox', () => ({
  SpacesInbox: ({
    renderHeader,
    renderEmptyState,
    preselectedPatients,
  }: {
    renderHeader?: (c: { sidebarOpen: boolean; toggleSidebar: () => void }) => ReactNode;
    renderEmptyState?: (send: (q: string) => void) => ReactNode;
    preselectedPatients?: { reference?: string }[];
  }) => (
    <div>
      <div data-testid="preselected">{(preselectedPatients ?? []).map((p) => p.reference).join(',')}</div>
      {renderHeader?.({ sidebarOpen: false, toggleSidebar: () => {} })}
      {renderEmptyState?.(() => {})}
    </div>
  ),
}));

function LocationProbe(): JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function setup(initialPath: string): void {
  render(
    <MedplumProvider medplum={new MockClient()}>
      <MantineProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <LyfeAiLauncher />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>
    </MedplumProvider>
  );
}

/**
 * Clicks the pill and waits for the panel, whose entry transition settles outside the click.
 * @returns The panel element.
 */
async function openPanel(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Open Lyfe AI' }));
  return screen.findByRole('dialog', { name: 'Lyfe AI' });
}

describe('patientIdFromPathname', () => {
  test.each([
    ['/Patient/123', '123'],
    ['/Patient/123/vitals', '123'],
    ['/Patient/123/MedicationRequest?patient=123', '123'],
    ['/Patient/new', undefined],
    ['/Patient', undefined],
    ['/Spaces/Communication', undefined],
    ['/scheduling', undefined],
  ])('%s -> %s', (pathname, expected) => {
    expect(patientIdFromPathname(pathname)).toBe(expected);
  });
});

describe('launcher', () => {
  test('starts closed, showing only the pill', () => {
    setup('/scheduling');

    expect(screen.getByRole('button', { name: 'Open Lyfe AI' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Lyfe AI' })).not.toBeInTheDocument();
  });

  test('opens the panel and hides the pill, then closes again', async () => {
    setup('/scheduling');

    await openPanel();

    expect(screen.queryByRole('button', { name: 'Open Lyfe AI' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close Lyfe AI' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Lyfe AI' })).toBeInTheDocument());
  });

  test('Escape closes the panel', async () => {
    setup('/scheduling');
    await openPanel();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Lyfe AI' })).toBeInTheDocument());
  });

  test('expands and collapses', async () => {
    setup('/scheduling');
    const panel = await openPanel();

    expect(panel).not.toHaveAttribute('data-expanded');

    await userEvent.click(screen.getByRole('button', { name: 'Expand Lyfe AI' }));
    expect(panel).toHaveAttribute('data-expanded', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Collapse Lyfe AI' }));
    expect(panel).not.toHaveAttribute('data-expanded');
  });

  /*
   * Production's panel header has two controls: the expand/collapse toggle and close. Ours
   * also shipped a conversations button and a new-conversation button, which production has
   * nowhere. They are not rendered any more rather than hidden — a styled-away header button
   * is still tabbable and still announced.
   */
  test('the header has exactly the two controls production has', async () => {
    setup('/scheduling');
    await openPanel();

    expect(screen.getByRole('button', { name: 'Expand Lyfe AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Lyfe AI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conversations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
  });

  test('stays out of the way on the Spaces page, which is the same chat at full size', () => {
    setup('/Spaces/Communication');

    expect(screen.queryByRole('button', { name: 'Open Lyfe AI' })).not.toBeInTheDocument();
  });

  test('stays out of the way on sign-in', () => {
    setup('/signin');

    expect(screen.queryByRole('button', { name: 'Open Lyfe AI' })).not.toBeInTheDocument();
  });
});

describe('modes', () => {
  test('off a chart it asks about the panel', async () => {
    setup('/scheduling');
    await openPanel();

    expect(screen.getByText('Clinical data at your fingertips')).toBeInTheDocument();
    expect(screen.getByText('Ask anything about your patients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prep me for my next patient' })).toBeInTheDocument();
    expect(screen.getByTestId('preselected')).toHaveTextContent('');
  });

  test('on a chart it pre-selects the patient and asks about them', async () => {
    setup('/Patient/123/vitals');
    await openPanel();

    expect(screen.getByTestId('preselected')).toHaveTextContent('Patient/123');
    expect(screen.getByText('Ask anything about this patient')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Summarize this patient in 3 sentences' })).toBeInTheDocument();
    // The subtitle names the patient once the resource resolves.
    await waitFor(() => expect(screen.getByText("Reads Homer Simpson's chart, meds, labs, docs")).toBeInTheDocument());
  });

  test('the footer disclaimer follows the mode', async () => {
    setup('/Patient/123');
    await openPanel();

    expect(screen.getByText('AI reads chart, meds, labs, vitals, docs · always verify')).toBeInTheDocument();
  });
});

describe('chart section citations', () => {
  test('a switch-tab request navigates the chart to that section', async () => {
    setup('/Patient/123/vitals');

    dispatchSwitchTab('meds');

    // `meds` is a search URL with the patient id substituted in, not a bare segment.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/Patient/123/MedicationRequest'));
  });

  test('a plain section becomes a plain sub-route', async () => {
    setup('/Patient/123');

    dispatchSwitchTab('allergies');

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/Patient/123/allergies'));
  });

  test('an unknown section is ignored rather than throwing', async () => {
    setup('/Patient/123/vitals');

    dispatchSwitchTab('not-a-tab');

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/Patient/123/vitals'));
  });

  test('a request with no chart open goes nowhere', async () => {
    setup('/scheduling');

    dispatchSwitchTab('vitals');

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/scheduling'));
  });
});
