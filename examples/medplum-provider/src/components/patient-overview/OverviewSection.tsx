// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Text } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import classes from './PatientOverview.module.css';

export interface OverviewSectionProps {
  icon: ReactNode;
  /** Tile tone: rose, slate, indigo or blue. */
  tone: 'rose' | 'slate' | 'indigo' | 'blue';
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}

/**
 * A titled Overview card: small tinted icon tile, title and subtitle, and a right-side slot.
 * @param props - The section props.
 * @returns The section card.
 */
export function OverviewSection(props: OverviewSectionProps): JSX.Element {
  return (
    <Box component="section" aria-label={props.title} className={classes.section}>
      <Group justify="space-between" wrap="nowrap" className={classes.sectionHeader}>
        <Group gap="sm" wrap="nowrap" miw={0}>
          <span className={classes.sectionTile} data-tone={props.tone}>
            {props.icon}
          </span>
          <Box miw={0}>
            <Text className={classes.sectionTitle}>{props.title}</Text>
            {props.subtitle && <Text className={classes.sectionSubtitle}>{props.subtitle}</Text>}
          </Box>
        </Group>
        {props.right}
      </Group>
      {props.children}
    </Box>
  );
}
