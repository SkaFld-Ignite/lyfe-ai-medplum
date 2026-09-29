// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { IconStethoscope } from '@tabler/icons-react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, userEvent } from '../../test-utils/render';
import { FilterMenu } from './FilterMenu';

const options = [
  { key: 'Practitioner/a', label: 'Alice Smith' },
  { key: 'Practitioner/b', label: 'Bob Jones' },
];

function setup(selected: string[], onChange = vi.fn()): void {
  render(
    <FilterMenu
      label="Provider"
      pluralLabel="Providers"
      icon={<IconStethoscope />}
      options={options}
      selected={selected}
      onChange={onChange}
      getColor={() => 'blue'}
    />
  );
}

describe('FilterMenu', () => {
  test('labels the button by selection', () => {
    setup([]);
    expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent('Provider');
  });

  test('shows the single selected option name', () => {
    setup(['Practitioner/b']);
    expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent('Bob Jones');
  });

  test('shows a count for multiple selections', () => {
    setup(['Practitioner/a', 'Practitioner/b']);
    expect(screen.getByRole('button', { name: 'Filter by provider' })).toHaveTextContent('2 Providers');
  });

  test('toggles options', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    setup(['Practitioner/a'], onChange);

    await user.click(screen.getByRole('button', { name: 'Filter by provider' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Bob Jones' }));

    expect(onChange).toHaveBeenLastCalledWith(['Practitioner/a', 'Practitioner/b']);
  });

  test('clears the filter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    setup(['Practitioner/a'], onChange);

    await user.click(screen.getByRole('button', { name: 'Filter by provider' }));
    await user.click(await screen.findByRole('button', { name: 'Clear filter' }));

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  test('explains when there is nothing to filter', async () => {
    const user = userEvent.setup();
    render(
      <FilterMenu
        label="Location"
        pluralLabel="Locations"
        icon={<IconStethoscope />}
        options={[]}
        selected={[]}
        onChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Filter by location' }));
    expect(await screen.findByText('No locations in this view.')).toBeInTheDocument();
  });
});
