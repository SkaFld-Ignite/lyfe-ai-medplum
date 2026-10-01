// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Group, Stack, Text } from '@mantine/core';
import type { MedicationOrderExtensions } from '@medplum/core';
import { formatCodeableConcept, formatHumanName, getPendingMedicationOrderStatus } from '@medplum/core';
import type { MedicationRequest, Practitioner } from '@medplum/fhirtypes';
import { MedplumLink, useResource } from '@medplum/react';
import { IconChevronRight, IconPill } from '@tabler/icons-react';
import cx from 'clsx';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { formatFhirDate } from '../../utils/clinic-time';
import classes from './MedListItem.module.css';

export type MedTab = 'active' | 'draft' | 'completed';

interface MedListItemProps {
  item: MedicationRequest;
  selectedItem: MedicationRequest | undefined;
  activeTab: MedTab;
  /**
   * Returns the URL the row should link to. Invoked during render, so callers
   * must keep it pure (memoize with `useCallback` to avoid extra renders).
   */
  getItemUrl: (item: MedicationRequest) => string;
  medicationOrderExtensions: MedicationOrderExtensions;
}

export function MedListItem(props: MedListItemProps): JSX.Element {
  const { item, selectedItem, activeTab, getItemUrl, medicationOrderExtensions } = props;
  const isSelected = selectedItem?.id === item.id;
  const requester = useResource(item.requester) as Practitioner | undefined;
  const pendingStatus = getPendingMedicationOrderStatus(item, medicationOrderExtensions);
  const timeZone = useClinicTimeZone();
  const meta = getMetaLine(item, requester, timeZone);
  const dosage = item.dosageInstruction?.[0]?.text;

  return (
    <MedplumLink to={getItemUrl(item)} underline="never">
      <Group
        align="flex-start"
        wrap="nowrap"
        gap={12}
        className={cx(classes.contentContainer, {
          [classes.selected]: isSelected,
        })}
      >
        <span className={classes.icon}>
          <IconPill size={18} />
        </span>
        <Stack gap={5} flex={1} miw={0}>
          <Text fw={600} size="sm" className={classes.title}>
            {getMedicationDisplay(item)}
          </Text>
          {(pendingStatus || activeTab !== 'completed') && (
            <Group gap={6}>
              {activeTab !== 'completed' && (
                <Badge size="sm" radius="sm" color={getStatusColor(item.status)} variant="light">
                  {getStatusDisplayText(item.status)}
                </Badge>
              )}
              {pendingStatus && (
                <Badge size="sm" radius="sm" color="violet" variant="light" tt="none">
                  ScriptSure: {pendingStatus}
                </Badge>
              )}
            </Group>
          )}
          {meta && <Text className={classes.meta}>{meta}</Text>}
          {dosage && <Text className={classes.dosage}>{dosage}</Text>}
        </Stack>
        <IconChevronRight size={16} className={classes.chevron} />
      </Group>
    </MedplumLink>
  );
}

function getMedicationDisplay(mr: MedicationRequest): string {
  return formatCodeableConcept(mr.medicationCodeableConcept) || 'Medication order';
}

const getStatusColor = (status: string | undefined): string => {
  switch (status) {
    case 'active':
      return 'yellow';
    case 'draft':
      return 'yellow';
    case 'on-hold':
      return 'orange';
    case 'cancelled':
    case 'entered-in-error':
      return 'red';
    case 'completed':
      return 'green';
    case 'stopped':
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
    case 'on-hold':
      return 'On Hold';
    case 'cancelled':
      return 'Cancelled';
    case 'entered-in-error':
      return 'Error';
    case 'completed':
      return 'Completed';
    case 'stopped':
      return 'Stopped';
    default:
      return status || 'Unknown';
  }
};

function getMetaLine(item: MedicationRequest, requester: Practitioner | undefined, timeZone: string): string {
  const date = formatFhirDate(item.authoredOn || item.meta?.lastUpdated, timeZone);
  const prescriber = requester?.resourceType === 'Practitioner' ? formatHumanName(requester.name?.[0]) : undefined;
  return [date && `Prescribed: ${date}`, prescriber].filter(Boolean).join(' · ');
}
