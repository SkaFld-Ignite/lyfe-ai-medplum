// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { JSX } from 'react';
import { CriticalResults } from '../../components/dashboard/CriticalResults';
import classes from '../../components/dashboard/Dashboard.module.css';
import { DashboardHeader } from '../../components/dashboard/DashboardHeader';
import { PatientStats } from '../../components/dashboard/PatientStats';
import { TaskInbox } from '../../components/dashboard/TaskInbox';
import { TodaySchedule } from '../../components/dashboard/TodaySchedule';

/**
 * The provider's home page, as in Lyfe: greeting and server status, patient counts, today's
 * schedule, the task inbox and flagged lab results. Every panel loads on its own.
 * @returns The dashboard.
 */
export function DashboardPage(): JSX.Element {
  return (
    <div className={classes.page}>
      <DashboardHeader />
      <PatientStats />
      <div className={classes.panels}>
        <TodaySchedule />
        <TaskInbox />
      </div>
      <CriticalResults />
    </div>
  );
}
