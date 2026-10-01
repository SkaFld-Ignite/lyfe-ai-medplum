// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Skeleton, Stack, Text, Title } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import classes from './PatientShell.module.css';

export interface PatientTabShellProps {
  /** Rendered in the blue icon tile, e.g. a 20px Tabler icon. */
  icon: ReactNode;
  title: ReactNode;
  /** Shown as a pill beside the title; omitted while undefined so it never flashes "0". */
  count?: number;
  /** Line under the title; defaults to "N record(s)" when a count is given. */
  description?: ReactNode;
  /** Right-aligned header buttons. */
  actions?: ReactNode;
  /** Search, filters and toggles, shown in the tinted bar under the header. */
  toolbar?: ReactNode;
  loading?: boolean;
  /** When set, shown in place of the list card. */
  empty?: { icon: ReactNode; title: string; description?: string };
  /** The list card's contents. Omit `listCard` to render children without the card. */
  children?: ReactNode;
  /** Wrap children in the bordered list card. Default true. */
  listCard?: boolean;
  /** Fill the available height, with the list card taking what is left (for list/detail boards). */
  fill?: boolean;
}

/**
 * The Lyfe patient-section shell: a header card (icon tile, title, count pill, subtitle, actions)
 * with an optional toolbar, then the section's list card or an empty state.
 * @param props - The shell props.
 * @returns The section.
 */
export function PatientTabShell(props: PatientTabShellProps): JSX.Element {
  const { icon, title, count, actions, toolbar, loading, empty, children, listCard = true, fill } = props;
  const description =
    props.description ?? (count !== undefined ? `${count} record${count === 1 ? '' : 's'}` : undefined);

  let body: ReactNode;
  if (loading) {
    body = (
      <Box
        className={classes.card}
        p="md"
        aria-busy="true"
        aria-label={typeof title === 'string' ? `Loading ${title}` : 'Loading'}
      >
        <Stack gap="sm">
          <Skeleton h={24} w="33%" radius="sm" />
          <Skeleton h={40} radius="sm" />
          <Skeleton h={40} radius="sm" />
          <Skeleton h={40} radius="sm" />
        </Stack>
      </Box>
    );
  } else if (empty) {
    body = <EmptyState {...empty} />;
  } else if (listCard) {
    body = <Box className={classes.listCard}>{children}</Box>;
  } else {
    body = children;
  }

  return (
    <Stack gap="md" className={classes.shell} data-fill={fill || undefined}>
      <Box className={classes.card}>
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md" className={classes.header}>
          <Group gap="sm" wrap="nowrap" align="flex-start" miw={0}>
            <Box className={classes.iconTile}>{icon}</Box>
            <Box miw={0}>
              <Group gap={8} wrap="nowrap">
                <Title order={2} className={classes.title}>
                  {title}
                </Title>
                {count !== undefined && <span className={classes.countPill}>{count}</span>}
              </Group>
              {description && (
                <Text size="sm" className={classes.subtitle}>
                  {description}
                </Text>
              )}
            </Box>
          </Group>
          {actions && (
            <Group gap="xs" wrap="wrap">
              {actions}
            </Group>
          )}
        </Group>
        {toolbar && <Box className={classes.toolbar}>{toolbar}</Box>}
      </Box>
      {body}
    </Stack>
  );
}

/**
 * Lyfe empty-state card: a muted icon tile, title and description.
 * @param props - The empty state content.
 * @param props.icon - Icon in the tile.
 * @param props.title - Heading.
 * @param props.description - Supporting text.
 * @returns The empty state.
 */
export function EmptyState(props: { icon: ReactNode; title: string; description?: string }): JSX.Element {
  return (
    <Stack align="center" gap={6} className={`${classes.card} ${classes.empty}`}>
      <Box className={classes.emptyIcon}>{props.icon}</Box>
      <Text fw={600} size="lg" mt="xs">
        {props.title}
      </Text>
      {props.description && (
        <Text size="sm" className={classes.subtitle} maw={384} ta="center">
          {props.description}
        </Text>
      )}
    </Stack>
  );
}
