// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColor } from '@mantine/core';
import { Box, Group, Paper, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import classes from './SchedulingOverview.module.css';

export interface StatCardProps {
  icon: ReactNode;
  label: string;
  /** Undefined renders a loading placeholder. */
  value: number | undefined;
  color: MantineColor;
  /** Shows a pulsing "live" dot next to the value. */
  live?: boolean;
}

export function StatCard({ icon, label, value, color, live }: StatCardProps): JSX.Element {
  return (
    <Paper withBorder radius="md" p="md" className={classes.statCard}>
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon variant="light" color={color} size={40} radius="md">
          {icon}
        </ThemeIcon>
        <Stack gap={0} miw={0}>
          <Group gap={6} wrap="nowrap">
            {value === undefined ? (
              <Skeleton h={28} w={40} aria-label={`${label} loading`} />
            ) : (
              <Text fz={24} fw={600} lh={1.2} className={classes.tabular} aria-label={`${label}: ${value}`}>
                {value}
              </Text>
            )}
            {live && <Box className={classes.liveDot} aria-hidden />}
          </Group>
          <Text size="xs" fw={500} c="dimmed" tt="uppercase" className={classes.statLabel}>
            {label}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}
