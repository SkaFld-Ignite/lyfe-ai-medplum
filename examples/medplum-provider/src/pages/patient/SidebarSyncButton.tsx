// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Text, Tooltip } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import type { JSX } from 'react';
import { usePatientResync } from '../../hooks/usePatientResync';
import { isRunning } from '../../services/imports';
import classes from './SidebarSyncButton.module.css';

export interface SidebarSyncButtonProps {
  patientId: string;
}

/**
 * The patient sidebar's re-sync control.
 *
 * The previous platform put a Sync button here, under the provider and address
 * block and above the section menu, and it is where people look for it. The
 * card on the Overview tab answers "when did this last run and what came back";
 * this answers "go and look again" from any tab without scrolling.
 *
 * It shares {@link usePatientResync} with the card rather than owning a second
 * trigger. Two controls that each tracked their own in-flight state would
 * eventually disagree — one enabled while the other said "syncing" — and the
 * one thing a duplicated action must not do is let someone start a run twice
 * because the second control had not noticed the first.
 *
 * Pulls every available source rather than offering a choice. A sidebar is the
 * wrong place to make someone pick, and the card is where per-source control
 * lives. One source is configured today, so this is the same action either way.
 *
 * Renders nothing when nothing can be pulled — no clinic integration, or no
 * import worker — matching the card. A disabled button explaining a feature
 * this deployment does not have is worse than no button.
 * @param props - The patient.
 * @param props.patientId - The Medplum patient id.
 * @returns The control, or null when there is nothing to offer.
 */
export function SidebarSyncButton(props: SidebarSyncButtonProps): JSX.Element | null {
  const { sources, latest, queued, loading, error, resync } = usePatientResync(props.patientId);

  if (loading || sources.length === 0) {
    return null;
  }

  const pending = sources.some((source) => queued.has(source.id) || isRunning(latest[source.id]));

  return (
    <div className={classes.root}>
      <Tooltip
        label={pending ? 'A sync is already running for this patient' : "Pull this patient's outside record again"}
        position="right"
        withArrow
      >
        <Button
          variant="default"
          size="compact-sm"
          radius="md"
          fullWidth
          leftSection={<IconRefresh size={14} />}
          loading={pending}
          onClick={() => sources.forEach((source) => resync(source.id))}
        >
          {pending ? 'Syncing…' : 'Sync'}
        </Button>
      </Tooltip>
      {/* The sidebar is too narrow for a run's detail, so a failure says only
          that it failed and sends you to the Overview card, which has the
          reason. Silence here would make a dead button look like a working
          one. */}
      {error && (
        <Text size="xs" c="red.7" mt={6}>
          Could not start — see Record sync on Overview.
        </Text>
      )}
    </div>
  );
}
