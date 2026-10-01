// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { CloseButton, Group, SegmentedControl, TextInput } from '@mantine/core';
import { IconLayoutList, IconList, IconSearch } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import classes from './PatientShell.module.css';

export type ShellView = 'grouped' | 'all';

export interface ShellToolbarProps {
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  view?: { value: ShellView; onChange: (value: ShellView) => void; labels?: { grouped: string; all: string } };
  /** Extra controls between the search and the view toggle. */
  children?: ReactNode;
}

/**
 * The Lyfe section toolbar: a search box, extra controls, and a right-aligned Grouped / All toggle.
 * @param props - The toolbar props.
 * @returns The toolbar.
 */
export function ShellToolbar(props: ShellToolbarProps): JSX.Element {
  const { search, view, children } = props;
  return (
    <Group gap={10} wrap="wrap">
      {search && (
        <TextInput
          className={classes.search}
          value={search.value}
          onChange={(e) => search.onChange(e.currentTarget.value)}
          placeholder={search.placeholder}
          aria-label={search.placeholder}
          leftSection={<IconSearch size={16} />}
          rightSection={
            search.value ? (
              <CloseButton size="sm" aria-label="Clear search text" onClick={() => search.onChange('')} />
            ) : null
          }
        />
      )}
      {children}
      {view && (
        <SegmentedControl
          ml="auto"
          size="xs"
          classNames={{ root: classes.segment, indicator: classes.segmentIndicator, label: classes.segmentLabel }}
          value={view.value}
          onChange={(value) => view.onChange(value as ShellView)}
          aria-label="View"
          data={[
            {
              value: 'grouped',
              label: (
                <Group gap={4} wrap="nowrap">
                  <IconLayoutList size={14} />
                  {view.labels?.grouped ?? 'Grouped'}
                </Group>
              ),
            },
            {
              value: 'all',
              label: (
                <Group gap={4} wrap="nowrap">
                  <IconList size={14} />
                  {view.labels?.all ?? 'All'}
                </Group>
              ),
            },
          ]}
        />
      )}
    </Group>
  );
}
