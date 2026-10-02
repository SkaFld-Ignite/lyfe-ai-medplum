// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { formatDateTime } from '@medplum/core';
import { IconAlertTriangle, IconCloudDownload, IconRefresh } from '@tabler/icons-react';
import type { JSX } from 'react';
import { usePatientResync } from '../../hooks/usePatientResync';
import type { ImportRun } from '../../services/imports';
import { isRunning } from '../../services/imports';
import { OverviewSection } from './OverviewSection';

export interface RecordSyncCardProps {
  patientId: string;
}

/**
 * One line saying where a source's record stands.
 * @param props - The run and whether a new one is queued.
 * @param props.run - The newest run for this source, if there is one.
 * @param props.queued - A sync queued in this session whose run has not appeared yet.
 * @returns The sentence shown under the source's name.
 */
function statusLine(props: { run?: ImportRun; queued: boolean }): string {
  if (props.queued) {
    return 'Queued — starting shortly';
  }
  const run = props.run;
  if (!run) {
    return 'Never synced';
  }
  if (isRunning(run)) {
    return run.phase ? `Syncing — ${run.phase}` : 'Syncing…';
  }
  const when = formatDateTime(run.endedAt ?? run.startedAt);
  if (run.status === 'failed') {
    return `Last attempt ${when} failed${run.errorReason ? ` — ${run.errorReason}` : ''}`;
  }
  return `Last synced ${when} · ${run.total} record${run.total === 1 ? '' : 's'}`;
}

/**
 * The record sync card on the patient overview.
 *
 * Deliberately one row per source and nothing else. The previous platform's
 * patient page carried a bank of sync buttons — pull demographics, pull
 * encounters, pull documents, push back — and the result was that nobody knew
 * which one to press, so people pressed all of them. There is one thing to ask
 * for here, "go and look again", and the only honest things to show alongside
 * it are when it last happened and what came back.
 *
 * The card renders nothing at all when no source is available. A clinic with
 * no network integration connected, or a deployment with no import worker,
 * should see no control rather than a disabled one explaining a feature it
 * does not have.
 * @param props - The card props.
 * @returns The card, or null when there is nothing to offer.
 */
export function RecordSyncCard(props: RecordSyncCardProps): JSX.Element | null {
  const { sources, latest, queued, loading, error, resync } = usePatientResync(props.patientId);

  if (loading || sources.length === 0) {
    return null;
  }

  return (
    <OverviewSection
      icon={<IconCloudDownload size={16} />}
      tone="indigo"
      title="Record sync"
      subtitle="Pull this patient's outside record again"
    >
      <Stack gap="xs">
        {error && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Could not start the sync">
            {error}
          </Alert>
        )}
        {sources.map((source) => {
          const run = latest[source.id];
          const pending = queued.has(source.id) || isRunning(run);
          return (
            <Group key={source.id} justify="space-between" wrap="nowrap" gap="md">
              <div>
                <Text fw={600} size="sm">
                  {source.label}
                </Text>
                <Text size="xs" c="dimmed">
                  {statusLine({ run, queued: queued.has(source.id) })}
                </Text>
              </div>
              <Button
                variant="light"
                size="compact-sm"
                disabled={pending}
                leftSection={pending ? <Loader size={12} /> : <IconRefresh size={14} />}
                onClick={() => resync(source.id)}
              >
                {pending ? 'Syncing' : 'Sync now'}
              </Button>
            </Group>
          );
        })}
        <Text size="xs" c="dimmed">
          A sync adds what is new and updates what has changed. Anything edited here is kept as you left it.
        </Text>
      </Stack>
    </OverviewSection>
  );
}
