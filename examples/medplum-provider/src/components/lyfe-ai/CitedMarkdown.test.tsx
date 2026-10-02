// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import type { RenderResult } from '@testing-library/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { citationElementId, TAB_NAV_EVENT } from './citations';
import { CitedAssistantMessage } from './CitedMarkdown';

function setup(props: {
  content: string;
  resources?: string[];
  onSelectResource?: (reference: string) => void;
  collapsibleSources?: boolean;
}): RenderResult {
  return render(
    <MedplumProvider medplum={new MockClient()}>
      <MantineProvider>
        <CitedAssistantMessage bubbleClassName="bubble" {...props} />
      </MantineProvider>
    </MedplumProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('markdown with inline citations', () => {
  test('renders prose with no citations untouched, and no sources strip', () => {
    setup({ content: 'AST is within range.', resources: ['Observation/obs-1'] });

    expect(screen.getByText('AST is within range.')).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('turns a document token into a pill and keeps the surrounding text', () => {
    setup({ content: 'AST **78 U/L** [doc:S1] on admission.', resources: ['Observation/obs-1'] });

    expect(screen.getByRole('button', { name: 'S1' })).toBeInTheDocument();
    // The token itself is consumed — only the label is left on the page.
    expect(screen.queryByText(/\[doc:S1\]/)).not.toBeInTheDocument();
    expect(screen.getByText(/on admission\./)).toBeInTheDocument();
    expect(screen.getByText('78 U/L')).toBeInTheDocument();
  });

  test('rewrites citations inside list items, bold runs and table cells', () => {
    setup({
      content: [
        '- metformin 500mg BID [meds]',
        '',
        '**Hypertension [conditions]**',
        '',
        '| Test | Value |',
        '| --- | --- |',
        '| AST | 78 [doc:S1] |',
      ].join('\n'),
      resources: ['Observation/obs-1'],
    });

    expect(screen.getByRole('button', { name: 'Meds' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conditions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'S1' })).toBeInTheDocument();
  });

  test('renders every citation in a run of them, in order', () => {
    setup({ content: 'metformin 500mg BID [meds][doc:S2][vitals]', resources: ['a/1', 'Condition/c-2'] });

    const labels = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t && ['Meds', 'S2', 'Vitals'].includes(t));
    expect(labels).toEqual(['Meds', 'S2', 'Vitals']);
  });
});

describe('sources strip', () => {
  test('lists one card per cited source, labelled and addressable by id', async () => {
    const { container } = setup({
      content: 'First [doc:S1], second [doc:S2].',
      resources: ['Patient/123', 'Patient/123'],
    });

    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(container.querySelector(`#${citationElementId('S1')}`)).toBeInTheDocument();
    expect(container.querySelector(`#${citationElementId('S2')}`)).toBeInTheDocument();
    // Each card wraps the shared ResourceBox, so the resource itself is resolved the usual way.
    await waitFor(() => expect(screen.getAllByTestId('resource-box')).toHaveLength(2));
  });

  test('omits an uncited resource, so the strip only shows what the prose stands on', () => {
    const { container } = setup({ content: 'Only the second [doc:S2].', resources: ['Patient/123', 'Patient/123'] });

    expect(container.querySelector(`#${citationElementId('S1')}`)).not.toBeInTheDocument();
    expect(container.querySelector(`#${citationElementId('S2')}`)).toBeInTheDocument();
  });

  test('renders no strip when a citation has no resource behind it', () => {
    setup({ content: 'Cites a source that never came back [doc:S4].', resources: ['Patient/123'] });

    expect(screen.getByRole('button', { name: 'S4' })).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });
});

describe('sources strip, collapsed (panel variant)', () => {
  /**
   * Prose that cites a lot of sources, the way a week of appointments does.
   * @param count - How many `[doc:Sn]` citations, each with a resource behind it.
   * @returns The content and resources to render.
   */
  function manySources(count: number): { content: string; resources: string[] } {
    return {
      content: Array.from({ length: count }, (_, i) => `Row ${i} [doc:S${i + 1}]`).join('\n\n'),
      resources: Array.from({ length: count }, (_, i) => `Appointment/appt-${i}`),
    };
  }

  test('shows one summary line with the count, and no cards at all', () => {
    const { container } = setup({ ...manySources(40), collapsibleSources: true });

    expect(screen.getByRole('button', { name: /Sources \(40\)/ })).toHaveAttribute('aria-expanded', 'false');
    // Not in the DOM, not merely hidden with CSS.
    expect(container.querySelector(`#${citationElementId('S1')}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('resource-box')).not.toBeInTheDocument();
  });

  test('expands to the full strip and collapses again', async () => {
    const { container } = setup({ ...manySources(6), collapsibleSources: true });
    const toggle = screen.getByRole('button', { name: /Sources \(6\)/ });

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector(`#${citationElementId('S1')}`)).toBeInTheDocument();
    expect(container.querySelector(`#${citationElementId('S6')}`)).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(container.querySelector(`#${citationElementId('S1')}`)).not.toBeInTheDocument();
  });

  test('an inline pill opens the strip and scrolls to its card', async () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const onSelectResource = vi.fn();
      const { container } = setup({ ...manySources(8), collapsibleSources: true, onSelectResource });

      await userEvent.click(screen.getByRole('button', { name: 'S5' }));

      const card = container.querySelector(`#${citationElementId('S5')}`) as HTMLElement;
      expect(card).toBeInTheDocument();
      expect(card).toHaveAttribute('data-flashed', 'true');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' }));
      expect(onSelectResource).toHaveBeenCalledWith('Appointment/appt-4');
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test('a second pill click leaves the strip open rather than toggling it shut', async () => {
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();

    try {
      const { container } = setup({ ...manySources(4), collapsibleSources: true });

      await userEvent.click(screen.getByRole('button', { name: 'S2' }));
      await userEvent.click(screen.getByRole('button', { name: 'S3' }));

      expect(container.querySelector(`#${citationElementId('S3')}`)).toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test('the full-page variant is untouched — cards listed, no toggle', () => {
    const { container } = setup(manySources(6));

    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sources \(/ })).not.toBeInTheDocument();
    expect(container.querySelector(`#${citationElementId('S1')}`)).toBeInTheDocument();
  });
});

describe('clicking a citation', () => {
  test('a document pill scrolls its card into view, flashes it, and opens the resource', async () => {
    const onSelectResource = vi.fn();
    const scrollIntoView = vi.fn();
    const { container } = setup({
      content: 'AST 78 [doc:S2]',
      resources: ['Observation/obs-1', 'Observation/obs-2'],
      onSelectResource,
    });

    const card = container.querySelector(`#${citationElementId('S2')}`) as HTMLElement;
    card.scrollIntoView = scrollIntoView;
    expect(card).not.toHaveAttribute('data-flashed');

    await userEvent.click(screen.getByRole('button', { name: 'S2' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
    expect(onSelectResource).toHaveBeenCalledWith('Observation/obs-2');
    expect(card).toHaveAttribute('data-flashed', 'true');
  });

  test('the flash clears itself', async () => {
    const { container } = setup({ content: '[doc:S1]', resources: ['Observation/obs-1'] });
    const card = container.querySelector(`#${citationElementId('S1')}`) as HTMLElement;

    await userEvent.click(screen.getByRole('button', { name: 'S1' }));
    expect(card).toHaveAttribute('data-flashed', 'true');

    await waitFor(() => expect(card).not.toHaveAttribute('data-flashed'), { timeout: 4000 });
  });

  test('a chart section pill asks the host to switch the chart, and opens no resource', async () => {
    const onSelectResource = vi.fn();
    const received: string[] = [];
    const listener = (e: Event): void => {
      received.push((e as CustomEvent<{ tab: string }>).detail.tab);
    };
    window.addEventListener(TAB_NAV_EVENT, listener);

    try {
      setup({ content: 'Trending down [vitals]', resources: ['Observation/obs-1'], onSelectResource });
      await userEvent.click(screen.getByRole('button', { name: 'Vitals' }));

      expect(received).toEqual(['vitals']);
      expect(onSelectResource).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TAB_NAV_EVENT, listener);
    }
  });

  test('a document pill with no handler still flashes rather than throwing', async () => {
    const { container } = setup({ content: '[doc:S1]', resources: ['Observation/obs-1'] });

    await userEvent.click(screen.getByRole('button', { name: 'S1' }));

    expect(container.querySelector(`#${citationElementId('S1')}`)).toHaveAttribute('data-flashed', 'true');
  });
});
