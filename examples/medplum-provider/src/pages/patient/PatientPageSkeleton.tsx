// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, Paper, Skeleton, Stack } from '@mantine/core';
import type { JSX } from 'react';

const INFO_ROW_WIDTHS = ['55%', '35%', '60%', '45%', '50%'];
const SECTION_COUNT = 3;
const CONTENT_ROW_COUNT = 4;

/**
 * Placeholder for the patient summary sidebar, laid out like `PatientSummary`: header, info rows
 * and a few clinical sections.
 * @returns The sidebar skeleton.
 */
export function PatientSummarySkeleton(): JSX.Element {
  return (
    <Stack gap="lg" p="md" aria-hidden>
      <Group gap="sm" wrap="nowrap">
        <Skeleton circle h={44} w={44} />
        <Stack gap={6} flex={1}>
          <Skeleton h={14} w="65%" radius="xl" />
          <Skeleton h={10} w="45%" radius="xl" />
        </Stack>
      </Group>
      <Stack gap={12}>
        {INFO_ROW_WIDTHS.map((width) => (
          <Group key={width} gap="sm" wrap="nowrap">
            <Skeleton circle h={16} w={16} />
            <Skeleton h={10} w={width} radius="xl" />
          </Group>
        ))}
      </Stack>
      {Array.from({ length: SECTION_COUNT }, (_, i) => (
        <Stack key={i} gap={8}>
          <Skeleton h={12} w="35%" radius="xl" />
          <Skeleton h={10} w="70%" radius="xl" />
          <Skeleton h={16} w={56} radius="xl" />
        </Stack>
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
