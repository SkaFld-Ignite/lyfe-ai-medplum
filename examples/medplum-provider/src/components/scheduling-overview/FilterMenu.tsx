// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColor } from '@mantine/core';
import { Button, Checkbox, ColorSwatch, Divider, Group, Popover, ScrollArea, Stack, Text } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import type { FilterOption } from '../../utils/scheduling-overview';

export interface FilterMenuProps {
  /** Button label when nothing is selected, e.g. "Provider". */
  label: string;
  /** Plural noun for the "N selected" label, e.g. "Providers". */
  pluralLabel: string;
  icon: ReactNode;
  options: FilterOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Optional color swatch shown next to each option. */
  getColor?: (key: string) => MantineColor;
}

/**
 * A multi-select filter rendered as a button that opens a checkbox list.
 * An empty selection means "no filter".
 * @param props - The filter props.
 * @returns The filter button and popover.
 */
export function FilterMenu(props: FilterMenuProps): JSX.Element {
  const { label, pluralLabel, icon, options, selected, onChange, getColor } = props;

  let buttonLabel = label;
  if (selected.length === 1) {
    buttonLabel = options.find((option) => option.key === selected[0])?.label ?? label;
  } else if (selected.length > 1) {
    buttonLabel = `${selected.length} ${pluralLabel}`;
  }

  return (
    <Popover position="bottom-start" shadow="md" width={288} withinPortal>
      <Popover.Target>
        <Button
          variant={selected.length > 0 ? 'light' : 'default'}
          size="xs"
          leftSection={icon}
          rightSection={<IconChevronDown size={14} />}
          aria-label={`Filter by ${label.toLowerCase()}`}
          disabled={options.length === 0}
        >
          {buttonLabel}
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <ScrollArea.Autosize mah={300}>
          <Checkbox.Group value={selected} onChange={onChange}>
            <Stack gap={6} p={4}>
              {options.map((option) => (
                <Checkbox
                  key={option.key}
                  value={option.key}
                  label={
                    <Group gap={8} wrap="nowrap">
                      {getColor && <ColorSwatch size={10} color={`var(--mantine-color-${getColor(option.key)}-6)`} />}
                      <Text size="sm" truncate>
                        {option.label}
                      </Text>
                    </Group>
                  }
                />
              ))}
            </Stack>
          </Checkbox.Group>
        </ScrollArea.Autosize>
        {selected.length > 0 && (
          <>
            <Divider my={6} />
            <Button variant="subtle" color="gray" size="xs" fullWidth onClick={() => onChange([])}>
              Clear filter
            </Button>
          </>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
