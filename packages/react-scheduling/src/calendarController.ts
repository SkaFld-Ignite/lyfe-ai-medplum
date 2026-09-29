// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// FullCalendar is bundled into this package, so hosts must use this re-export (not their own
// `@fullcalendar/react`) for a controller that drives `Calendar` / `MultiCalendar`.
export { useCalendarController } from '@fullcalendar/react';
export type { CalendarController } from '@fullcalendar/react';
