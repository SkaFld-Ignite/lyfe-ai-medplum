// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Center, Drawer, Group, Loader, Stack, Text } from '@mantine/core';
import type { WithId } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { ResourceTable, useMedplum } from '@medplum/react';
import { IconExternalLink } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { TimelineEventKind } from '../../utils/patient-timeline';
import { KindBadge } from './TimelineBits';

export interface TimelineRecordDrawerProps {
  /** The record to show, or undefined when closed. */
  record?: { kind: TimelineEventKind; title: string; resource: WithId<Resource> };
  onClose: () => void;
  onOpenInChart: (resource: WithId<Resource>) => void;
}

/**
 * Side drawer showing every field of a timeline record through Medplum's `ResourceTable`.
 * @param props - The drawer props.
 * @returns The drawer.
 */
export function TimelineRecordDrawer(props: TimelineRecordDrawerProps): JSX.Element {
  const { record, onClose, onOpenInChart } = props;
  const medplum = useMedplum();
  const resourceType = record?.resource.resourceType;
  // ResourceTable renders nothing until its schema is loaded, so load it here and show a loader meanwhile.
  const [loadedType, setLoadedType] = useState<string>();

  useEffect(() => {
    if (!resourceType) {
      return undefined;
    }
    let active = true;
    medplum
      .requestSchema(resourceType)
      .then(() => active && setLoadedType(resourceType))
      .catch(console.error);
    return () => {
      active = false;
    };
  }, [medplum, resourceType]);

  return (
    <Drawer
      opened={Boolean(record)}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        record && (
          <Stack gap={4}>
            <KindBadge kind={record.kind} />
            <Text fw={700}>{record.title}</Text>
          </Stack>
        )
      }
    >
      {record && (
        <Stack gap="md">
          {loadedType === resourceType ? (
            <ResourceTable value={record.resource} ignoreMissingValues />
          ) : (
            <Center py="xl">
              <Loader size="sm" aria-label="Loading record" />
            </Center>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
            <Button rightSection={<IconExternalLink size={14} />} onClick={() => onOpenInChart(record.resource)}>
              Open in chart
            </Button>
          </Group>
        </Stack>
      )}
    </Drawer>
  );
}
