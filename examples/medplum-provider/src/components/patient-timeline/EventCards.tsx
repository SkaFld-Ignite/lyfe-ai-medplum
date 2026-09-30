// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { StatusBadge } from '@medplum/react';
import { IconClock, IconEye } from '@tabler/icons-react';
import type { JSX } from 'react';
import type { ConditionEvent, DayRecordsEvent, TimelineRecord } from '../../utils/patient-timeline';
import classes from './PatientTimeline.module.css';
import { formatMediumDate, KIND_CONFIG, summarizeRecords } from './timeline-config';
import { KindBadge, RecordGroups, SourceBadges } from './TimelineBits';

/**
 * A condition on its onset (or recorded) date.
 * @param props - The card props.
 * @param props.event - The condition event.
 * @param props.onOpen - Opens the condition's details.
 * @returns The condition card.
 */
export function ConditionCard({ event, onOpen }: { event: ConditionEvent; onOpen: () => void }): JSX.Element {
  return (
    <Paper withBorder radius="md" className={classes.card} data-accent={KIND_CONFIG.condition.color}>
      <Box className={classes.accent} aria-hidden />
      <UnstyledButton className={classes.cardBody} onClick={onOpen}>
        <KindBadge kind="condition" />
        <Text fw={600} size="sm" mt={6} className={classes.cardTitle}>
          {event.title}
        </Text>
        {event.detail && (
          <Text size="xs" c="dimmed" lineClamp={1} mt={2}>
            {event.detail}
          </Text>
        )}
        <Group gap={6} mt={8}>
          <Group gap={4} c="dimmed">
            <IconClock size={12} />
            <Text size="xs" className={classes.tabular}>
              Onset {formatMediumDate(event.date)}
            </Text>
          </Group>
          {event.clinicalStatus && <StatusBadge status={event.clinicalStatus} size="xs" variant="light" />}
          <SourceBadges sources={event.sources} />
          {event.copies > 1 && (
            <Text size="xs" c="dimmed">
              · {event.copies} copies merged
            </Text>
          )}
        </Group>
      </UnstyledButton>
      <Group className={classes.actionBar} px="sm" py={4}>
        <UnstyledButton className={classes.actionButton} onClick={onOpen}>
          <IconEye size={14} />
          View details
        </UnstyledButton>
      </Group>
    </Paper>
  );
}

/**
 * One day's records that aren't linked to a visit, grouped by type.
 * @param props - The card props.
 * @param props.event - The day's records event.
 * @param props.onOpenRecord - Opens a record's details.
 * @returns The records card.
 */
export function DayRecordsCard({
  event,
  onOpenRecord,
}: {
  event: DayRecordsEvent;
  onOpenRecord: (record: TimelineRecord) => void;
}): JSX.Element {
  return (
    <Paper withBorder radius="md" className={classes.card} data-accent="gray">
      <Box className={classes.accent} aria-hidden />
      <Stack gap={6} className={classes.cardBody}>
        <Box>
          <KindBadge kind="document" label="Clinical records" />
          <Text fw={600} size="sm" mt={6} className={classes.cardTitle}>
            {summarizeRecords(event.records)}
          </Text>
          <Group gap={6} mt={4}>
            <Text size="xs" c="dimmed">
              Not linked to a visit
            </Text>
            <SourceBadges sources={event.sources} />
          </Group>
        </Box>
        <RecordGroups records={event.records} onOpenRecord={onOpenRecord} />
      </Stack>
    </Paper>
  );
}
