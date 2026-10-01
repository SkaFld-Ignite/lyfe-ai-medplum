// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Badge,
  Box,
  Collapse,
  Divider,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconEye } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { DataSource, RecordKind, TimelineEventKind, TimelineRecord } from '../../utils/patient-timeline';
import classes from './PatientTimeline.module.css';
import { KIND_CONFIG, SOURCE_CONFIG } from './timeline-config';

export interface KindBadgeProps {
  kind: TimelineEventKind;
  /** Overrides the kind's default label. */
  label?: string;
}

/**
 * Small uppercase pill naming the kind of event, e.g. "CONDITION".
 * @param props - The badge props.
 * @returns The badge.
 */
export function KindBadge(props: KindBadgeProps): JSX.Element {
  const { kind, label } = props;
  const config = KIND_CONFIG[kind];
  return (
    <Badge variant="light" color={config.color} size="xs" radius="xl" className={classes.kindBadge}>
      {label ?? config.label}
    </Badge>
  );
}

/**
 * "From EHR" / "From Lyfe" chips for the sources an event was merged from.
 *
 * Both sources are labelled. There used to be a third, unlabelled bucket for
 * records entered in Lyfe, kept quiet to reduce noise; now that Lyfe covers
 * everything that is not the EHR, hiding it would drop the provenance of every
 * record pulled over the Lyfe Data Network.
 * @param props - The component props.
 * @param props.sources - The sources to show.
 * @returns The chips, or null when there is nothing to show.
 */
export function SourceBadges(props: { sources: DataSource[] }): JSX.Element | null {
  const { sources } = props;
  if (sources.length === 0) {
    return null;
  }
  return (
    <>
      {sources.map((source) => (
        <Badge
          key={source}
          variant="light"
          color={SOURCE_CONFIG[source].color}
          size="xs"
          radius="xl"
          leftSection={<Box className={classes.sourceDot} bg={`${SOURCE_CONFIG[source].color}.6`} />}
          tt="none"
        >
          {SOURCE_CONFIG[source].label}
        </Badge>
      ))}
    </>
  );
}

export interface RailItemProps {
  kind: TimelineEventKind;
  /** "upcoming" renders a blue dot, "alert" a red one. */
  highlight?: 'upcoming' | 'alert';
  children: ReactNode;
}

/**
 * A row on the timeline rail: a colored icon dot, with the card to its right.
 * @param props - The row props.
 * @returns The rail row.
 */
export function RailItem(props: RailItemProps): JSX.Element {
  const { kind, highlight, children } = props;
  const config = KIND_CONFIG[kind];
  const Icon = config.icon;
  let color = config.color;
  if (highlight === 'upcoming') {
    color = 'blue';
  } else if (highlight === 'alert') {
    color = 'red';
  }
  return (
    <Box className={classes.railItem} data-testid="timeline-event">
      <ThemeIcon variant="light" color={color} radius="xl" size={28} className={classes.railDot} aria-hidden>
        <Icon size={14} />
      </ThemeIcon>
      <Box className={classes.railContent}>{children}</Box>
    </Box>
  );
}

/**
 * Records grouped by kind into collapsible sections, each row with a "Details" action.
 * @param props - The records and the open callback.
 * @param props.records - The records to show.
 * @param props.onOpenRecord - Called when a record's details are requested.
 * @returns The grouped record list.
 */
export function RecordGroups({
  records,
  onOpenRecord,
}: {
  records: TimelineRecord[];
  onOpenRecord: (record: TimelineRecord) => void;
}): JSX.Element {
  const groups = new Map<RecordKind, TimelineRecord[]>();
  for (const record of records) {
    const list = groups.get(record.kind) ?? [];
    list.push(record);
    groups.set(record.kind, list);
  }
  return (
    <Stack gap={2}>
      {[...groups.entries()].map(([kind, list]) => (
        <RecordGroup key={kind} kind={kind} records={list} onOpenRecord={onOpenRecord} />
      ))}
    </Stack>
  );
}

function RecordGroup({
  kind,
  records,
  onOpenRecord,
}: {
  kind: RecordKind;
  records: TimelineRecord[];
  onOpenRecord: (record: TimelineRecord) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const config = KIND_CONFIG[kind];
  const Icon = config.icon;
  return (
    <Box>
      <UnstyledButton
        className={classes.groupToggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${config.plural} (${records.length})`}
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <Icon size={14} className={classes.groupIcon} />
        <Text size="xs" fw={600}>
          {config.plural}
        </Text>
        <Badge variant="default" size="xs" ml="auto">
          {records.length}
        </Badge>
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap={0} className={classes.groupList}>
          {records.map((record) => (
            <Group key={record.resource.id} gap="xs" wrap="nowrap" className={classes.groupRow}>
              <Box miw={0} flex={1}>
                <Text size="xs" fw={500} truncate>
                  {record.title}
                </Text>
                {record.detail && (
                  <Text size="xs" c="dimmed" truncate>
                    {record.detail}
                  </Text>
                )}
              </Box>
              <UnstyledButton
                className={classes.detailsLink}
                onClick={() => onOpenRecord(record)}
                aria-label={`View ${record.title}`}
              >
                <IconEye size={12} />
                Details
              </UnstyledButton>
            </Group>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}

// Two placeholder days, shaped like the real day sections so nothing jumps when data arrives.
const SKELETON_DAYS = [3, 2];

/**
 * Loading placeholder shaped like the timeline: day headers and cards on the rail.
 * @returns The skeleton.
 */
export function TimelineSkeleton(): JSX.Element {
  return (
    <Stack gap="xl" aria-busy="true" aria-label="Loading timeline">
      {SKELETON_DAYS.map((cards, day) => (
        <Box key={day}>
          <Group gap="sm" wrap="nowrap" className={classes.dayHeader}>
            <Skeleton h={30} w={132} radius="md" />
            <Divider flex={1} />
            <Skeleton h={10} w={48} radius="xl" />
          </Group>
          <Box className={classes.rail}>
            {Array.from({ length: cards }, (_, i) => (
              <Box key={i} className={classes.railItem}>
                <Skeleton circle h={28} w={28} className={classes.railDot} />
                <Paper withBorder radius="md" p="md">
                  <Stack gap={8}>
                    <Skeleton h={12} w={`${45 - i * 8}%`} radius="xl" />
                    <Skeleton h={10} w="28%" radius="xl" />
                    <Group gap={6}>
                      <Skeleton h={16} w={64} radius="xl" />
                      <Skeleton h={16} w={72} radius="xl" />
                    </Group>
                  </Stack>
                </Paper>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
