// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Text, UnstyledButton } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import type { ProfileItem, Severity } from '../../utils/patient-overview';
import classes from './PatientOverview.module.css';

/** Items listed on a profile card before "+N more". */
const VISIBLE_ITEMS = 3;

export interface ProfileCardProps {
  label: string;
  icon: ReactNode;
  /** Card accent: purple (conditions), blue (medications), rose or emerald (allergies). */
  tone: 'purple' | 'blue' | 'rose' | 'emerald';
  items: ProfileItem[];
  suffix: string;
  /** Pill shown top-right, e.g. "2 chronic"; an "OK" pill is shown otherwise when there are items. */
  pill?: { label: string; severity: Severity };
  emptyText: string;
  onOpen?: () => void;
}

/**
 * A Lyfe "Active Clinical Profile" card: count, a severity pill, the first items and a link to the
 * full list.
 * @param props - The card props.
 * @returns The card.
 */
export function ProfileCard(props: ProfileCardProps): JSX.Element {
  const { label, icon, tone, items, suffix, pill, emptyText, onOpen } = props;
  const shown = items.slice(0, VISIBLE_ITEMS);
  const more = items.length - shown.length;
  return (
    <UnstyledButton
      className={classes.profile}
      data-tone={tone}
      onClick={onOpen}
      aria-label={`${label}: ${items.length} ${suffix}`}
    >
      <span className={classes.profileAccent} />
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <span className={classes.profileTile}>{icon}</span>
          <Box>
            <Text className={classes.profileLabel}>{label}</Text>
            <Group gap={6} align="baseline" wrap="nowrap">
              <Text className={classes.profileCount}>{items.length}</Text>
              <Text className={classes.profileSuffix}>{suffix}</Text>
            </Group>
          </Box>
        </Group>
        {pill ? (
          <span className={classes.profilePill} data-severity={pill.severity}>
            {pill.label}
          </span>
        ) : (
          items.length > 0 && (
            <span className={classes.profilePill} data-severity="normal">
              OK
            </span>
          )
        )}
      </Group>
      <Box className={classes.profileItems}>
        {shown.length === 0 ? (
          <Text className={classes.profileEmpty}>{emptyText}</Text>
        ) : (
          shown.map((item) => (
            <Group key={item.label} gap={8} wrap="nowrap" className={classes.profileItem}>
              <span className={classes.profileDot} data-severity={item.severity} />
              <Text truncate="end" className={classes.profileItemText}>
                {item.label}
              </Text>
            </Group>
          ))
        )}
        {more > 0 && <Text className={classes.profileMore}>+{more} more</Text>}
      </Box>
      <Group justify="space-between" className={classes.profileFooter}>
        <span>View details</span>
        <span className={classes.profileArrow}>
          <IconArrowRight size={12} />
        </span>
      </Group>
    </UnstyledButton>
  );
}
