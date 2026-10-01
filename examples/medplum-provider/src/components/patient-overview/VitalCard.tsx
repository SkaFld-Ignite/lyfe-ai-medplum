// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconActivity,
  IconArrowDownRight,
  IconArrowUpRight,
  IconBolt,
  IconHeart,
  IconScale,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import type { VitalKey, VitalSummary } from '../../utils/patient-overview';
import classes from './PatientOverview.module.css';
import { Sparkline } from './Sparkline';

const VITALS: Record<VitalKey, { label: string; icon: Icon; tone: string; line: string }> = {
  bp: { label: 'Blood Pressure', icon: IconHeart, tone: 'rose', line: '#ef4444' },
  hr: { label: 'Heart Rate', icon: IconActivity, tone: 'pink', line: '#ec4899' },
  spo2: { label: 'SpO₂', icon: IconBolt, tone: 'teal', line: '#14b8a6' },
  weight: { label: 'Weight', icon: IconScale, tone: 'sky', line: '#0ea5e9' },
};

function trendChip(history: VitalSummary['history']): JSX.Element {
  if (history.length < 2) {
    return <span className={classes.trendChip}>No trend</span>;
  }
  const last = history[history.length - 1].value;
  const prev = history[history.length - 2].value;
  const diff = Math.round((last - prev) * 10) / 10;
  if (Math.abs(diff) < 0.05) {
    return <span className={classes.trendChip}>Stable</span>;
  }
  return (
    <span className={classes.trendChip} data-direction={diff > 0 ? 'up' : 'down'}>
      {diff > 0 ? <IconArrowUpRight size={11} /> : <IconArrowDownRight size={11} />}
      {Math.abs(diff)}
    </span>
  );
}

/**
 * One Lyfe vital card: icon and status, the latest value, the change since the last reading and a
 * trend line with its range.
 * @param props - The vital summary.
 * @param props.vital - The vital to show.
 * @returns The card.
 */
export function VitalCard({ vital }: { vital: VitalSummary }): JSX.Element {
  const config = VITALS[vital.key];
  const VitalIcon = config.icon;
  const values = vital.history.map((p) => p.value);
  return (
    <Box
      className={classes.vital}
      data-tone={config.tone}
      aria-label={`${config.label}: ${vital.display ?? 'no data'}`}
    >
      <span className={classes.vitalAccent} />
      <Group justify="space-between" wrap="nowrap">
        <span className={classes.vitalTile}>
          <VitalIcon size={18} />
        </span>
        <span className={classes.statusPill} data-severity={vital.severity}>
          <span className={classes.statusDot} />
          {vital.status}
        </span>
      </Group>
      <Text className={classes.vitalLabel}>{config.label}</Text>
      <Group gap={4} align="baseline" wrap="nowrap">
        <Text className={classes.vitalValue}>{vital.display ?? '—'}</Text>
        {vital.display && <Text className={classes.vitalUnit}>{vital.unit}</Text>}
      </Group>
      <Group gap={6} mt={6}>
        {trendChip(vital.history)}
        {values.length > 1 && <Text className={classes.vitalPoints}>{values.length} pts</Text>}
      </Group>
      <Box className={classes.vitalTrend}>
        {values.length > 1 ? (
          <>
            <Sparkline values={values} color={config.line} height={58} />
            <Group justify="space-between" className={classes.vitalRange}>
              <span>min {Math.min(...values)}</span>
              <span>max {Math.max(...values)}</span>
            </Group>
          </>
        ) : (
          <Text className={classes.vitalNoTrend}>No trend data</Text>
        )}
      </Box>
    </Box>
  );
}
