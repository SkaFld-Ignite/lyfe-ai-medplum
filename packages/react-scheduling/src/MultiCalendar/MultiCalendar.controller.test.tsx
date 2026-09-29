// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { JSX } from 'react';
import { describe, expect, test } from 'vitest';
import { useCalendarController } from '../calendarController';
import { render, screen, userEvent } from '../test-utils/render';
import { MultiCalendar } from './MultiCalendar';

// A host that renders its own navigation and drives the calendar through an external controller.
function HostWithOwnToolbar(): JSX.Element {
  const controller = useCalendarController();
  return (
    <>
      <div data-testid="host-title">{controller.view?.title}</div>
      <div data-testid="host-view">{controller.view?.type}</div>
      <button type="button" onClick={() => controller.next()}>
        Host next
      </button>
      <button type="button" onClick={() => controller.changeView('timeGridDay')}>
        Host day view
      </button>
      <MultiCalendar sources={[]} controller={controller} hideToolbar initialView="dayGridMonth" />
    </>
  );
}

describe('MultiCalendar external controller', () => {
  test('shows the built-in toolbar by default', () => {
    render(<MultiCalendar sources={[]} />);
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeInTheDocument();
  });

  test('hides the built-in toolbar and is driven by the host controller', async () => {
    const user = userEvent.setup();
    render(<HostWithOwnToolbar />);

    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
    expect(screen.getByTestId('host-view')).toHaveTextContent('dayGridMonth');

    const firstTitle = screen.getByTestId('host-title').textContent;
    expect(firstTitle).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Host next' }));
    expect(screen.getByTestId('host-title').textContent).not.toBe(firstTitle);

    await user.click(screen.getByRole('button', { name: 'Host day view' }));
    expect(screen.getByTestId('host-view')).toHaveTextContent('timeGridDay');
  });
});
