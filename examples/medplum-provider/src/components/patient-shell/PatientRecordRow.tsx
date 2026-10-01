// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import type { JSX, ReactNode } from 'react';
import classes from './PatientShell.module.css';

export type RecordTone =
  'blue' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate' | 'sky' | 'teal' | 'orange' | 'indigo';

export interface RecordBadge {
  label: ReactNode;
  tone: RecordTone;
  icon?: ReactNode;
}

/**
 * A small Lyfe record badge (radius 6, tinted background and ring).
 * @param props - The badge.
 * @param props.label - Badge text.
 * @param props.tone - Colour.
 * @param props.icon - Optional leading icon.
 * @returns The badge.
 */
export function ToneBadge(props: RecordBadge): JSX.Element {
  return (
    <span className={classes.badge} data-tone={props.tone}>
      {props.icon}
      {props.label}
    </span>
  );
}

export interface PatientRecordRowProps {
  icon?: ReactNode;
  title: ReactNode;
  badges?: RecordBadge[];
  /** Short facts shown in one muted line, e.g. dates and prescriber. */
  meta?: ReactNode[];
  description?: ReactNode;
  /** Right-side action, e.g. "Details". */
  actionLabel?: string;
  onAction?: () => void;
  /** Extra right-side controls, e.g. icon buttons. */
  extra?: ReactNode;
  selected?: boolean;
}

/**
 * The Lyfe list row: icon tile, title, badges, metadata and description, with a "Details" action.
 * @param props - The row props.
 * @returns The row.
 */
export function PatientRecordRow(props: PatientRecordRowProps): JSX.Element {
  const { icon, title, badges, meta, description, actionLabel, onAction, extra, selected } = props;
  const facts = (meta ?? []).filter(Boolean);
  return (
    <Group wrap="nowrap" align="flex-start" gap={14} className={classes.row} data-selected={selected || undefined}>
      {icon && <Box className={classes.rowIcon}>{icon}</Box>}
      <Stack gap={6} miw={0} flex={1}>
        <Text fw={600} size="sm" className={classes.rowTitle}>
          {title}
        </Text>
        {badges && badges.length > 0 && (
          <Group gap={6}>
            {badges.map((b, i) => (
              <ToneBadge key={i} {...b} />
            ))}
          </Group>
        )}
        {facts.length > 0 && (
          <Group gap={8} className={classes.rowMeta}>
            {facts.map((fact, i) => (
              <span key={i}>{fact}</span>
            ))}
          </Group>
        )}
        {description && (
          <Text size="xs" className={classes.rowDescription}>
            {description}
          </Text>
        )}
      </Stack>
      {(extra || actionLabel) && (
        <Group gap={6} wrap="nowrap">
          {extra}
          {actionLabel && onAction && (
            <UnstyledButton className={classes.rowAction} onClick={onAction}>
              {actionLabel}
            </UnstyledButton>
          )}
        </Group>
      )}
    </Group>
  );
}
