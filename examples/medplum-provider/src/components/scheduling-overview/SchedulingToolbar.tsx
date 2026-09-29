// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Box, Button, Group, Loader, Paper, SegmentedControl, Title } from '@mantine/core';
import type { CalendarController } from '@medplum/react-scheduling';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import classes from './SchedulingOverview.module.css';

const VIEWS = [
  { label: 'Day', value: 'timeGridDay' },
  { label: 'Week', value: 'timeGridWeek' },
  { label: 'Month', value: 'dayGridMonth' },
];

export interface SchedulingToolbarProps {
  controller: CalendarController;
  loading?: boolean;
  /** Buttons rendered on the right side of the toolbar. */
  actions?: ReactNode;
}

/**
 * Calendar navigation bar: prev / Today / next and the period title on the left, the view
 * switcher in the middle, and page actions on the right. Drives a `MultiCalendar` rendered with
 * the same controller and `hideToolbar`.
 * @param props - The toolbar props.
 * @returns The toolbar.
 */
export function SchedulingToolbar(props: SchedulingToolbarProps): JSX.Element {
  const { controller, loading, actions } = props;

  return (
    <Paper withBorder radius="md" px="sm" py={10} className={classes.toolbar}>
      <Group gap="md" wrap="nowrap" className={classes.toolbarStart}>
        <Box className={classes.navPill}>
          <ActionIcon variant="subtle" color="gray" aria-label="Previous period" onClick={() => controller.prev()}>
            <IconChevronLeft size={16} />
          </ActionIcon>
          <Button variant="subtle" color="gray" size="compact-sm" fz="xs" onClick={() => controller.today()}>
            Today
          </Button>
          <ActionIcon variant="subtle" color="gray" aria-label="Next period" onClick={() => controller.next()}>
            <IconChevronRight size={16} />
          </ActionIcon>
        </Box>
        <Title order={4} className={classes.toolbarTitle}>
          {controller.view?.title}
        </Title>
        {loading && <Loader size="xs" aria-label="Loading appointments" />}
      </Group>

      <SegmentedControl
        size="xs"
        radius="md"
        aria-label="Calendar view"
        value={controller.view?.type ?? 'dayGridMonth'}
        onChange={(view) => controller.changeView(view)}
        data={VIEWS}
        classNames={{ root: classes.viewTabs, indicator: classes.viewTabIndicator, label: classes.viewTabLabel }}
      />

      <Group gap="xs" justify="flex-end" className={classes.toolbarEnd}>
        {actions}
      </Group>
    </Paper>
  );
}
