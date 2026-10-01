// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconAlertTriangle,
  IconBolt,
  IconCalendarCheck,
  IconCircleCheck,
  IconHeart,
  IconPill,
  IconShield,
  IconStethoscope,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import type { ClinicalFlag } from '../../utils/patient-overview';
import classes from './PatientOverview.module.css';

const FLAG_ICONS: Record<ClinicalFlag['icon'], Icon> = {
  allergy: IconShield,
  bp: IconHeart,
  spo2: IconBolt,
  meds: IconPill,
  conditions: IconStethoscope,
  visit: IconCalendarCheck,
};

/**
 * The Lyfe risk banner: "All clear", or the count of critical flags / items to watch, with a chip
 * per flag.
 * @param props - The flags.
 * @param props.flags - Clinical flags, most severe first.
 * @returns The banner.
 */
export function RiskBanner({ flags }: { flags: ClinicalFlag[] }): JSX.Element {
  const critical = flags.filter((f) => f.severity === 'critical').length;
  let tone: 'clear' | 'critical' | 'watch' = 'watch';
  let title = `${flags.length} ${flags.length === 1 ? 'item' : 'items'} to watch`;
  if (flags.length === 0) {
    tone = 'clear';
    title = 'All clear';
  } else if (critical > 0) {
    tone = 'critical';
    title = `${critical} critical ${critical === 1 ? 'flag' : 'flags'}`;
  }

  return (
    <Group className={classes.banner} data-tone={tone} gap="sm" wrap="wrap" role="status">
      <Group gap="sm" wrap="nowrap">
        <span className={classes.bannerTile}>
          {tone === 'clear' ? <IconCircleCheck size={18} /> : <IconAlertTriangle size={18} />}
        </span>
        <Box>
          <Text className={classes.bannerTitle}>{title}</Text>
          <Text className={classes.bannerSubtitle}>
            {tone === 'clear' ? 'No active clinical flags' : 'Review before next encounter'}
          </Text>
        </Box>
      </Group>
      {flags.length > 0 && (
        <Group gap={6} ml="auto" wrap="wrap">
          {flags.map((flag) => {
            const FlagIcon = FLAG_ICONS[flag.icon];
            return (
              <span key={flag.label} className={classes.flagChip} data-severity={flag.severity}>
                <FlagIcon size={12} />
                {flag.label}
              </span>
            );
          })}
        </Group>
      )}
    </Group>
  );
}
