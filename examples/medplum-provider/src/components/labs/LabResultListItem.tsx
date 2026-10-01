// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Group, Stack, Text } from '@mantine/core';
import { formatHumanName } from '@medplum/core';
import type { DiagnosticReport } from '@medplum/fhirtypes';
import { MedplumLink, useResource } from '@medplum/react';
import { IconChevronRight, IconFileAnalytics } from '@tabler/icons-react';
import cx from 'clsx';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import { getDataSource } from '../../utils/patient-timeline';
import classes from './LabListItem.module.css';

interface LabResultListItemProps {
  report: DiagnosticReport;
  selected: boolean;
  to: string;
}

export function LabResultListItem(props: LabResultListItemProps): JSX.Element {
  const { report, selected, to } = props;
  const timeZone = useClinicTimeZone();
  const performer = useResource(report.performer?.[0]);
  const completed = formatFhirDate(report.issued || report.effectiveDateTime || report.meta?.lastUpdated, timeZone);
  const subText = getSubText(report, performer, timeZone);

  return (
    <div className={classes.itemWrapper}>
      <MedplumLink to={to} underline="never">
        <Group
          align="flex-start"
          wrap="nowrap"
          gap={12}
          className={cx(classes.contentContainer, {
            [classes.selected]: selected,
          })}
        >
          <span className={classes.icon}>
            <IconFileAnalytics size={18} />
          </span>
          <Stack gap={5} flex={1} miw={0}>
            <Text fw={600} size="sm" className={classes.title}>
              {getDisplayText(report)}
            </Text>
            <Group gap={6}>
              <Badge variant="light" color={report.status === 'final' ? 'green' : 'blue'} size="sm" radius="sm">
                {report.status ?? 'unknown'}
              </Badge>
              {getDataSource(report) === 'drchrono' && (
                <Badge variant="light" color="teal" size="sm" radius="sm" tt="none">
                  From DrChrono
                </Badge>
              )}
            </Group>
            <Text className={classes.meta}>
              {completed && <span>Completed {completed}</span>}
              {subText && <span>{subText}</span>}
            </Text>
          </Stack>
          <IconChevronRight size={16} className={classes.chevron} />
        </Group>
      </MedplumLink>
    </div>
  );
}

const getDisplayText = (report: DiagnosticReport): string => {
  // If there are multiple codes (2 or more), show them separated by commas
  if (report.code?.coding && report.code.coding.length >= 2) {
    return report.code.coding.map((coding) => coding.display).join(', ');
  }

  // If there's a text field and only one code, use the text field
  if (report.code?.text) {
    return report.code.text;
  }

  // Otherwise, show the first code or fallback
  return report.code?.coding?.[0]?.display || 'Lab Result';
};

const getSubText = (report: DiagnosticReport, performer: ReturnType<typeof useResource>, timeZone: string): string => {
  if (performer?.resourceType === 'Practitioner') {
    return `Performed by ${formatHumanName(performer.name?.[0])}`;
  }
  if (performer?.resourceType === 'Organization' && performer.name) {
    return performer.name;
  }
  const collected = formatFhirDate(report.effectiveDateTime, timeZone);
  return collected ? `Collected ${collected}` : '';
};
