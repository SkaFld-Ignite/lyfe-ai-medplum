// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Group, Stack, Text } from '@mantine/core';
import { formatHumanName } from '@medplum/core';
import type { Practitioner, ServiceRequest } from '@medplum/fhirtypes';
import { MedplumLink, useResource } from '@medplum/react';
import { IconChevronRight, IconFlask } from '@tabler/icons-react';
import cx from 'clsx';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import classes from './LabListItem.module.css';

type LabTab = 'open' | 'completed';

interface LabListItemProps {
  item: ServiceRequest;
  selectedItem: ServiceRequest | undefined;
  activeTab: LabTab;
  onItemSelect: (item: ServiceRequest) => string;
}

export function LabListItem(props: LabListItemProps): JSX.Element {
  const { item, selectedItem, activeTab, onItemSelect } = props;
  const isSelected = selectedItem?.id === item.id;
  const requester = useResource(item.requester) as Practitioner | undefined;

  const timeZone = useClinicTimeZone();

  return (
    <div className={classes.itemWrapper}>
      <MedplumLink to={onItemSelect(item)} underline="never">
        <Group
          align="flex-start"
          wrap="nowrap"
          gap={12}
          className={cx(classes.contentContainer, {
            [classes.selected]: isSelected,
          })}
        >
          <span className={classes.icon}>
            <IconFlask size={18} />
          </span>
          <Stack gap={5} flex={1} miw={0}>
            <Text fw={600} size="sm" className={classes.title}>
              {getDisplayText(item)}
            </Text>
            {activeTab !== 'completed' && (
              <Group gap={6}>
                <Badge size="sm" radius="sm" color={getStatusColor(item.status)} variant="light">
                  {getStatusDisplayText(item.status)}
                </Badge>
              </Group>
            )}
            <Text className={classes.meta}>
              {getAdditionalInfo(item, activeTab, timeZone).map((info) => (
                <span key={info}>{info}</span>
              ))}
              <span>{getSubText(item, requester, timeZone)}</span>
            </Text>
          </Stack>
          <IconChevronRight size={16} className={classes.chevron} />
        </Group>
      </MedplumLink>
    </div>
  );
}

const getStatusColor = (status: string | undefined): string => {
  switch (status) {
    case 'active':
      return 'blue';
    case 'draft':
    case 'requested':
      return 'yellow';
    case 'on-hold':
      return 'orange';
    case 'revoked':
    case 'cancelled':
    case 'entered-in-error':
      return 'red';
    case 'completed':
      return 'green';
    case 'unknown':
      return 'gray';
    default:
      return 'gray';
  }
};

const getStatusDisplayText = (status: string | undefined): string => {
  switch (status) {
    case 'active':
      return 'Active';
    case 'draft':
      return 'Draft';
    case 'requested':
      return 'Requested';
    case 'on-hold':
      return 'On Hold';
    case 'revoked':
      return 'Revoked';
    case 'cancelled':
      return 'Cancelled';
    case 'entered-in-error':
      return 'Error';
    case 'completed':
      return 'Completed';
    case 'unknown':
      return 'Unknown';
    default:
      return status || 'Unknown';
  }
};

const getDisplayText = (item: ServiceRequest): string => {
  // If there are multiple codes (2 or more), show them separated by commas
  if (item.code?.coding && item.code.coding.length >= 2) {
    return item.code.coding.map((coding) => coding.display).join(', ');
  }

  // If there's a text field and only one code, use the text field
  if (item.code?.text) {
    return item.code.text;
  }

  // Otherwise, show the first code or fallback
  return item.code?.coding?.[0]?.display || 'Lab Order';
};

const getSubText = (item: ServiceRequest, requester: Practitioner | undefined, timeZone: string): string => {
  // Use authoredOn if available, otherwise fall back to meta.lastUpdated
  const date = formatFhirDate(item.authoredOn || item.meta?.lastUpdated, timeZone) ?? '';
  if (requester?.resourceType === 'Practitioner') {
    return `Ordered ${date} by ${formatHumanName(requester.name?.[0])}`;
  }
  return `Ordered ${date}`;
};

const getAdditionalInfo = (item: ServiceRequest, activeTab: LabTab, timeZone: string): string[] => {
  const info: string[] = [];

  if (activeTab === 'completed') {
    // For completed items, show completion date instead of REQ #
    const completionDate = formatFhirDate(item.meta?.lastUpdated, timeZone) ?? 'Unknown date';
    info.push(`Completed ${completionDate}`);
  } else if (item.requisition?.value) {
    // For open items, show REQ # as before
    info.push(`REQ #${item.requisition.value}`);
  }

  return info;
};
