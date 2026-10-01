// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Collapse, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { Resource } from '@medplum/fhirtypes';
import { ResourceTable, useResource } from '@medplum/react';
import { IconChevronDown } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useParams } from 'react-router';
import { CarePlanSummary } from '../../components/care-plan/CarePlanSummary';
import classes from './ResourcePage.module.css';

/**
 * A Lyfe summary for the record types that have one; others show Medplum's table alone.
 * @param resource - The record.
 * @returns The summary, or undefined.
 */
function summaryFor(resource: Resource): JSX.Element | undefined {
  if (resource.resourceType === 'CarePlan') {
    return <CarePlanSummary carePlan={resource} />;
  }
  return undefined;
}

/**
 * This is an example of a generic "Resource Display" page.
 * It uses the Medplum `<ResourceTable>` component to display a resource, hiding empty fields.
 * Types with a Lyfe summary show it first, with the full table folded under "All fields".
 * @returns A React component that displays a resource.
 */
export function ResourceDetailPage(): JSX.Element | null {
  const { resourceType, id } = useParams();
  const resource = useResource({ reference: resourceType + '/' + id });
  const [allFieldsOpen, { toggle }] = useDisclosure(false);

  if (!resource) {
    return null;
  }

  // The page header already names the record; empty fields are left out.
  const table = <ResourceTable key={`${resourceType}/${id}`} value={resource} ignoreMissingValues />;
  const summary = summaryFor(resource);
  if (!summary) {
    return table;
  }

  return (
    <>
      {summary}
      <Box className={classes.allFields}>
        <UnstyledButton className={classes.allFieldsToggle} onClick={toggle} aria-expanded={allFieldsOpen}>
          <IconChevronDown size={14} data-open={allFieldsOpen || undefined} />
          All fields
        </UnstyledButton>
        <Collapse in={allFieldsOpen}>{table}</Collapse>
      </Box>
    </>
  );
}
