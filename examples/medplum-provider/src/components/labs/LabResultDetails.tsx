// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import type { DiagnosticReport } from '@medplum/fhirtypes';
import { CodeableConceptDisplay } from '@medplum/react';
import { IconFileAnalytics } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import { getDataSource } from '../../utils/patient-timeline';
import { LabReportContent } from './LabReportContent';
import classes from './LabReportContent.module.css';

interface LabResultDetailsProps {
  result: DiagnosticReport;
}

export function LabResultDetails(props: LabResultDetailsProps): JSX.Element {
  const { result } = props;
  const timeZone = useClinicTimeZone();
  const issued = formatFhirDate(result.issued, timeZone);
  const collected = formatFhirDate(result.effectiveDateTime, timeZone);
  const dates = [issued && `Issued ${issued}`, collected && `Collected ${collected}`].filter(Boolean).join(' · ');

  return (
    <ScrollArea h="100%">
      <Paper h="100%" bg="transparent">
        <Stack gap="md" p="lg">
          <Group gap={14} wrap="nowrap" align="flex-start">
            <span className={classes.icon}>
              <IconFileAnalytics size={22} />
            </span>
            <Stack gap={6} miw={0}>
              <Text className={classes.title}>
                <CodeableConceptDisplay value={result.code} />
              </Text>
              <Group gap={6}>
                <Badge size="sm" radius="sm" color={getStatusColor(result.status)} variant="light">
                  {getStatusDisplayText(result.status)}
                </Badge>
                {getDataSource(result) === 'drchrono' && (
                  <Badge size="sm" radius="sm" color="teal" variant="light" tt="none">
                    From DrChrono
                  </Badge>
                )}
                {dates && <Text className={classes.subtle}>{dates}</Text>}
              </Group>
            </Stack>
          </Group>

          <LabReportContent report={result} />
        </Stack>
      </Paper>
    </ScrollArea>
  );
}

const getStatusColor = (status: string | undefined): string => {
  switch (status) {
    case 'final':
      return 'green';
    case 'partial':
      return 'yellow';
    case 'preliminary':
      return 'blue';
    case 'cancelled':
    case 'entered-in-error':
      return 'red';
    default:
      return 'gray';
  }
};

const getStatusDisplayText = (status: string | undefined): string => {
  switch (status) {
    case 'final':
      return 'Final';
    case 'partial':
      return 'Partial';
    case 'preliminary':
      return 'Preliminary';
    case 'cancelled':
      return 'Cancelled';
    case 'entered-in-error':
      return 'Error';
    default:
      return status || 'Unknown';
  }
};
