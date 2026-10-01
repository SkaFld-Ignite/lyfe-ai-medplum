// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, Paper, Skeleton, Stack } from '@mantine/core';
import type { JSX } from 'react';

const INFO_ROW_COUNT = 2;
const CONTENT_ROW_COUNT = 4;

/**
 * Placeholder for the patient identity card while the patient loads: avatar, name and MRN, the
 * meta row, a status badge and the provider/clinic rows.
 * @returns The identity skeleton.
 */
export function PatientIdentitySkeleton(): JSX.Element {
  return (
    <Stack gap="sm" p="md" aria-hidden>
      <Group gap="sm" wrap="nowrap">
        <Skeleton circle h={56} w={56} />
        <Stack gap={6} flex={1}>
          <Skeleton h={14} w="75%" radius="xl" />
          <Skeleton h={14} w="45%" radius="sm" />
        </Stack>
      </Group>
      <Group gap={8}>
        <Skeleton h={16} w={52} radius="sm" />
        <Skeleton h={12} w={30} radius="xl" />
        <Skeleton h={12} w={70} radius="xl" />
      </Group>
      <Skeleton h={30} radius="md" />
      <Skeleton h={18} w={64} radius="xl" />
      {Array.from({ length: INFO_ROW_COUNT }, (_, i) => (
        <Group key={i} gap="xs" wrap="nowrap">
          <Skeleton h={26} w={26} radius="sm" />
          <Stack gap={4} flex={1}>
            <Skeleton h={8} w="30%" radius="xl" />
            <Skeleton h={10} w="70%" radius="xl" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * Placeholder for the tab content while the patient loads.
 * @returns The content skeleton.
 */
export function PatientTabContentSkeleton(): JSX.Element {
  return (
    <Stack gap="md" p="md" aria-hidden>
      <Paper withBorder radius="md" p="md">
        <Group gap="sm" wrap="nowrap">
          <Skeleton h={44} w={44} radius="md" />
          <Stack gap={6} flex={1}>
            <Skeleton h={10} w={70} radius="xl" />
            <Skeleton h={16} w="30%" radius="xl" />
            <Skeleton h={10} w="40%" radius="xl" />
          </Stack>
        </Group>
      </Paper>
      {Array.from({ length: CONTENT_ROW_COUNT }, (_, i) => (
        <Paper key={i} withBorder radius="md" p="md">
          <Stack gap={8}>
            <Skeleton h={12} w={`${50 - i * 6}%`} radius="xl" />
            <Skeleton h={10} w="30%" radius="xl" />
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
