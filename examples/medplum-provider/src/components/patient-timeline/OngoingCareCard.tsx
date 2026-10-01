// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Box, Button, Collapse, Group, Paper, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { IconActivity, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import type { OngoingItem } from '../../utils/patient-timeline';
import classes from './PatientTimeline.module.css';
import { KIND_CONFIG, ONGOING_PREVIEW_COUNT } from './timeline-config';

export interface OngoingCareCardProps {
  items: OngoingItem[];
  onOpen: (item: OngoingItem) => void;
}

/**
 * Collapsible list of care items with no date to place them on the timeline (active problems,
 * medications and allergies without an onset or start date). Collapsed by default.
 * @param props - The card props.
 * @returns The ongoing-care card.
 */
export function OngoingCareCard(props: OngoingCareCardProps): JSX.Element {
  const { items, onOpen } = props;
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, ONGOING_PREVIEW_COUNT);

  return (
    <Paper withBorder radius="md" className={classes.ongoing}>
      <UnstyledButton className={classes.ongoingHeader} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" color="yellow" size={36} radius="md" c="#d97706">
            <IconActivity size={18} />
          </ThemeIcon>
          <Box>
            <Text fw={700} fz={15}>
              Ongoing Care
            </Text>
            <Text size="xs" c="dimmed">
              {items.length} active {items.length === 1 ? 'item' : 'items'} not tied to a specific encounter
            </Text>
          </Box>
        </Group>
        {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap={0} className={classes.ongoingList}>
          {visible.map((item) => {
            const config = KIND_CONFIG[item.kind];
            const Icon = config.icon;
            return (
              <UnstyledButton key={item.id} className={classes.ongoingRow} onClick={() => onOpen(item)}>
                <ThemeIcon variant="light" color={config.color} size={30} radius="md">
                  <Icon size={15} />
                </ThemeIcon>
                <Box miw={0} flex={1}>
                  <Text size="sm" fw={500} truncate>
                    {item.title}
                  </Text>
                  {item.detail && (
                    <Text size="xs" c="dimmed" truncate>
                      {item.detail}
                    </Text>
                  )}
                </Box>
                <Badge variant="light" color={config.color} size="xs">
                  {config.label}
                </Badge>
                <IconChevronRight size={14} className={classes.muted} />
              </UnstyledButton>
            );
          })}
          {items.length > ONGOING_PREVIEW_COUNT && (
            <Button variant="subtle" size="xs" m="xs" onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show fewer' : `Show all ${items.length}`}
            </Button>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}
