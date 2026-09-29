// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineSize } from '@mantine/core';
import { Badge, ThemeIcon, Tooltip } from '@mantine/core';
import type { Appointment } from '@medplum/fhirtypes';
import {
  IconAlertCircle,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconHourglassHigh,
  IconList,
  IconStethoscope,
  IconUserCheck,
  IconVideo,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { getStatusDisplay } from '../../utils/scheduling-overview';

const STATUS_ICONS: Partial<Record<Appointment['status'], typeof IconClock>> = {
  proposed: IconHourglassHigh,
  pending: IconHourglassHigh,
  booked: IconClock,
  arrived: IconUserCheck,
  'checked-in': IconUserCheck,
  fulfilled: IconCircleCheck,
  cancelled: IconCircleX,
  noshow: IconAlertCircle,
  waitlist: IconList,
};

export function StatusIcon({
  status,
  size = 'md',
}: {
  status: Appointment['status'];
  size?: MantineSize;
}): JSX.Element {
  const { label, color } = getStatusDisplay(status);
  const Icon = STATUS_ICONS[status] ?? IconClock;
  return (
    <Tooltip label={label} withArrow>
      <ThemeIcon variant="light" color={color} size={size} radius="sm" aria-label={label}>
        <Icon size={14} />
      </ThemeIcon>
    </Tooltip>
  );
}

export function StatusBadge({ status }: { status: Appointment['status'] }): JSX.Element {
  const { label, color } = getStatusDisplay(status);
  const Icon = STATUS_ICONS[status] ?? IconClock;
  return (
    <Badge variant="light" color={color} leftSection={<Icon size={12} />}>
      {label}
    </Badge>
  );
}

export function TypeIcon({ isVirtual, size = 14 }: { isVirtual: boolean; size?: number }): JSX.Element {
  return isVirtual ? <IconVideo size={size} aria-hidden /> : <IconStethoscope size={size} aria-hidden />;
}
