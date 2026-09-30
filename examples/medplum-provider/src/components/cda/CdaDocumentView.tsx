// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Box, Group, Paper, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { formatDate } from '@medplum/core';
import type { JSX } from 'react';
import { useId } from 'react';
import type { CdaDocument, CdaSection } from '../../utils/cda';
import classes from './CdaDocumentView.module.css';
import { CdaNarrative } from './CdaNarrative';

function Meta({ label, value }: { label: string; value?: string }): JSX.Element | null {
  if (!value) {
    return null;
  }
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} className={classes.metaLabel}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}

function Section({ section, id, level }: { section: CdaSection; id: string; level: number }): JSX.Element {
  return (
    <Box component="section" id={id} aria-label={section.title} className={classes.section} data-level={level}>
      <Group gap="xs" mb={6}>
        <Title order={level === 0 ? 4 : 5}>{section.title}</Title>
        {section.empty && (
          <Badge size="xs" variant="light" color="gray">
            No information
          </Badge>
        )}
      </Group>
      {!section.empty && <CdaNarrative nodes={section.narrative} />}
      {section.subsections.map((sub, i) => (
        <Section key={i} section={sub} id={`${id}-${i}`} level={level + 1} />
      ))}
    </Box>
  );
}

/**
 * A readable C-CDA document: who and when, a jump list of sections, then every section's narrative.
 * @param props - The parsed document.
 * @param props.document - The document to show.
 * @returns The document view.
 */
export function CdaDocumentView({ document }: { document: CdaDocument }): JSX.Element {
  const baseId = useId();
  const sectionId = (i: number): string => `${baseId}-section-${i}`;
  const patient = document.patient;
  const patientLine = [
    patient?.name,
    patient?.gender,
    patient?.birthDate && `born ${formatDate(patient.birthDate.toISOString())}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const withContent = document.sections.filter((s) => !s.empty).length;

  return (
    <Stack gap="md" data-testid="cda-document">
      <Paper withBorder radius="md" p="md" className={classes.header}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} className={classes.metaLabel}>
          Clinical document (C-CDA)
        </Text>
        <Title order={3} mt={2}>
          {document.title}
        </Title>
        <Group gap="xl" mt="sm" align="flex-start">
          <Meta label="Date" value={document.date && formatDate(document.date.toISOString())} />
          <Meta label="Patient" value={patientLine || undefined} />
          <Meta label="Author" value={document.authors.join(', ') || undefined} />
          <Meta label="Source" value={document.custodian} />
        </Group>
      </Paper>

      {document.sections.length > 1 && (
        <Group gap={6} aria-label="Document sections">
          <Text size="xs" c="dimmed" mr={4}>
            {withContent} of {document.sections.length} sections have content:
          </Text>
          {document.sections.map((section, i) => (
            <UnstyledButton
              key={i}
              className={classes.jump}
              data-empty={section.empty || undefined}
              onClick={() => window.document.getElementById(sectionId(i))?.scrollIntoView({ behavior: 'smooth' })}
            >
              {section.title}
            </UnstyledButton>
          ))}
        </Group>
      )}

      {document.sections.length === 0 ? (
        <Text c="dimmed" size="sm">
          This document has no readable sections.
        </Text>
      ) : (
        document.sections.map((section, i) => <Section key={i} section={section} id={sectionId(i)} level={0} />)
      )}
    </Stack>
  );
}
