// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Box, Group, Paper, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { MedplumLink, StatusBadge } from '@medplum/react';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconStethoscope,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import type { TimelineRecord, VisitEvent } from '../../utils/patient-timeline';
import { chartPath, getVisitStatusLabel } from '../../utils/patient-timeline';
import classes from './PatientTimeline.module.css';
import { formatMediumDate, formatShortTime, summarizeRecords } from './timeline-config';
import { RecordGroups, SourceBadges } from './TimelineBits';

export interface VisitCardProps {
  patientId: string;
  visit: VisitEvent;
  upcoming: boolean;
  onOpenRecord: (record: TimelineRecord) => void;
}

/**
 * An expandable visit: title, provider and a summary of linked records when collapsed; the
 * reason, links and the linked records grouped by type when expanded.
 * @param props - The card props.
 * @returns The visit card.
 */
export function VisitCard(props: VisitCardProps): JSX.Element {
  const { patientId, visit, upcoming, onOpenRecord } = props;
  const [expanded, setExpanded] = useState(false);
  const subtitle = [visit.provider, visit.location].filter(Boolean).join(' — ');
  const recordSummary = summarizeRecords(visit.records);
  const statusLabel = getVisitStatusLabel(visit.status);

  let eyebrow: JSX.Element | null = null;
  if (visit.isEmergency) {
    eyebrow = (
      <Group gap={4} c="red.7">
        <IconAlertTriangle size={12} />
        <Text size="xs" fw={700} tt="uppercase" className={classes.eyebrow}>
          Emergency visit
        </Text>
      </Group>
    );
  } else if (upcoming) {
    eyebrow = (
      <Text size="xs" fw={700} tt="uppercase" c="blue.7" className={classes.eyebrow}>
        Upcoming
      </Text>
    );
  }

  return (
    <Paper
      withBorder
      radius="md"
      className={classes.card}
      data-expanded={expanded || undefined}
      data-emergency={visit.isEmergency || undefined}
    >
      <Box className={classes.visitAccent} aria-hidden />
      <UnstyledButton className={classes.visitHeader} onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        <ThemeIcon variant={expanded ? 'light' : 'default'} size={22} radius="sm" className={classes.chevron}>
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </ThemeIcon>
        <Stack gap={2} flex={1} miw={0}>
          {eyebrow}
          <Text fw={600} size="sm" className={classes.cardTitle}>
            {visit.title}
          </Text>
          {subtitle && !expanded && (
            <Group gap={6} wrap="nowrap" c="dimmed">
              <IconStethoscope size={12} />
              <Text size="xs" truncate>
                {subtitle}
              </Text>
            </Group>
          )}
          {!expanded && (
            <Group gap={6} mt={4}>
              {recordSummary && (
                <Text size="xs" c="dimmed">
                  {recordSummary}
                </Text>
              )}
              {statusLabel && visit.status && <StatusBadge status={visit.status} size="xs" variant="light" />}
              <SourceBadges sources={visit.sources} />
            </Group>
          )}
        </Stack>
      </UnstyledButton>

      <Group justify="flex-end" px="md" py={6} className={classes.cardFooter}>
        <Stack gap={0} align="flex-end">
          <Text size="xs" fw={600} className={classes.tabular}>
            {formatMediumDate(visit.date)}
          </Text>
          <Text size="xs" c="dimmed" className={classes.tabular}>
            {formatShortTime(visit.date)}
          </Text>
        </Stack>
      </Group>

      {expanded && (
        <Stack gap="sm" px="md" pb="md" pt="sm" className={classes.expanded}>
          {subtitle && (
            <Text size="xs" c="dimmed">
              {subtitle}
            </Text>
          )}
          {visit.reason && <Text size="sm">{visit.reason}</Text>}
          <Group gap={6}>
            {statusLabel && visit.status && <StatusBadge status={visit.status} size="xs" variant="light" />}
            <SourceBadges sources={visit.sources} />
          </Group>
          <Group gap="md">
            {visit.encounter && (
              <Anchor component={MedplumLink} to={chartPath(patientId, visit.encounter)} size="xs" fw={500}>
                <Group gap={4} component="span">
                  Open full encounter
                  <IconExternalLink size={12} />
                </Group>
              </Anchor>
            )}
            {visit.appointment && (
              <Anchor component={MedplumLink} to={`/Appointment/${visit.appointment.id}`} size="xs" fw={500}>
                <Group gap={4} component="span">
                  Open appointment
                  <IconExternalLink size={12} />
                </Group>
              </Anchor>
            )}
          </Group>
          {visit.records.length > 0 ? (
            <RecordGroups records={visit.records} onOpenRecord={onOpenRecord} />
          ) : (
            <Text size="xs" c="dimmed">
              No records are linked to this visit.
            </Text>
          )}
        </Stack>
      )}
    </Paper>
  );
}
