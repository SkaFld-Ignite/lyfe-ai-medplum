// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Group, SegmentedControl, Skeleton, Stack, Text } from '@mantine/core';
import { getReferenceString } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { MedplumLink, ResourceName, useMedplumProfile, useSearchResources } from '@medplum/react';
import { IconChecklist, IconCircleCheck, IconUser } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { humanize } from '../../pages/patient/sections/section-utils';
import { formatFhirDate } from '../../utils/clinic-time';
import type { TaskFilter } from '../../utils/dashboard';
import { filterTasks, isUrgentTask, OPEN_TASK_STATUSES } from '../../utils/dashboard';
import { OverviewSection } from '../patient-overview/OverviewSection';
import { EmptyState } from '../patient-shell/PatientTabShell';
import classes from './Dashboard.module.css';

const FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Urgent', value: 'urgent' },
  { label: 'Pending', value: 'pending' },
];

function taskTitle(task: Task): string {
  return task.description ?? task.code?.text ?? task.code?.coding?.[0]?.display ?? 'Task';
}

/**
 * The open Medplum Tasks owned by the signed-in user, filterable by urgency and progress. A task
 * about a patient opens in that patient's Tasks tab.
 * @returns The task inbox card.
 */
export function TaskInbox(): JSX.Element {
  const profile = useMedplumProfile();
  const timeZone = useClinicTimeZone();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const query = useMemo(
    () =>
      profile && {
        owner: getReferenceString(profile),
        status: OPEN_TASK_STATUSES.join(','),
        _sort: '-_lastUpdated',
        _count: '50',
      },
    [profile]
  );
  const [tasks, loading] = useSearchResources('Task', query || undefined);
  const shown = filterTasks(tasks ?? [], filter);

  return (
    <OverviewSection
      icon={<IconChecklist size={16} />}
      tone="indigo"
      title="Task Inbox"
      subtitle="Tasks requiring your attention"
      right={!loading && <span className={classes.countPill}>{tasks?.length ?? 0}</span>}
    >
      <div className={classes.panelBody}>
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(value) => setFilter(value as TaskFilter)}
          data={FILTERS}
          mb="sm"
          aria-label="Filter tasks"
        />
        {loading && (
          <Stack gap="xs">
            <Skeleton h={52} radius="md" />
            <Skeleton h={52} radius="md" />
          </Stack>
        )}
        {!loading && shown.length === 0 && (
          <EmptyState
            compact
            icon={<IconCircleCheck size={24} />}
            title="No pending tasks"
            description="Great job staying on top of things!"
          />
        )}
        {!loading &&
          shown.map((task) => {
            const patientId = task.for?.reference?.startsWith('Patient/') ? task.for.reference.slice(8) : undefined;
            const due = task.restriction?.period?.end ?? task.authoredOn;
            const content = (
              <>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text className={classes.rowTitle}>{taskTitle(task)}</Text>
                  {isUrgentTask(task) && (
                    <Badge size="xs" color="red" variant="light">
                      {task.priority}
                    </Badge>
                  )}
                </Group>
                <Group gap={12} className={classes.rowMeta}>
                  {task.for && (
                    <span>
                      <IconUser size={12} />
                      <ResourceName value={task.for} />
                    </span>
                  )}
                  <span>{humanize(task.status)}</span>
                  {due && <span>{formatFhirDate(due, timeZone)}</span>}
                </Group>
              </>
            );
            return patientId ? (
              <MedplumLink
                key={task.id}
                to={`/Patient/${patientId}/Task/${task.id}`}
                className={classes.row}
                underline="never"
              >
                {content}
              </MedplumLink>
            ) : (
              <div key={task.id} className={classes.row}>
                {content}
              </div>
            );
          })}
      </div>
    </OverviewSection>
  );
}
