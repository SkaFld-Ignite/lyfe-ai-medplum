// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Badge, Group, Stack, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconDownload, IconEye, IconFile, IconFileText, IconFileTypePdf, IconPhoto } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { showErrorNotification } from '../../utils/notifications';
import { openAttachment } from '../../utils/open-attachment';
import type { DocumentFileKind, DocumentRow } from '../../utils/patient-documents';
import { DOCUMENT_SOURCES, formatDocumentDate, VISIBLE_CATEGORY_COUNT } from './documents-config';
import classes from './PatientDocuments.module.css';

const FILE_ICONS: Record<DocumentFileKind, typeof IconFile> = {
  pdf: IconFileTypePdf,
  image: IconPhoto,
  text: IconFileText,
  other: IconFile,
};

export interface DocumentRowItemProps {
  row: DocumentRow;
  onOpen: (row: DocumentRow) => void;
}

/**
 * One document in the list: file icon, title with its source, type and dates, category chips,
 * and preview/download actions.
 * @param props - The row props.
 * @returns The row.
 */
export function DocumentRowItem(props: DocumentRowItemProps): JSX.Element {
  const { row, onOpen } = props;
  const medplum = useMedplum();
  const [showAllCategories, setShowAllCategories] = useState(false);
  const source = DOCUMENT_SOURCES.find((s) => s.source === row.source);
  const FileIcon = FILE_ICONS[row.fileKind];
  const url = row.attachment?.url;

  const categories = showAllCategories ? row.categories : row.categories.slice(0, VISIBLE_CATEGORY_COUNT);
  const hiddenCount = row.categories.length - VISIBLE_CATEGORY_COUNT;

  const meta = [
    row.typeLabel,
    row.date && `Dated ${formatDocumentDate(row.date)}`,
    row.updated && `Updated ${formatDocumentDate(row.updated)}`,
  ].filter(Boolean) as string[];

  return (
    <Group wrap="nowrap" align="flex-start" gap="md" className={classes.row} data-testid="document-row">
      <ThemeIcon variant="light" color="blue" size={40} radius="md" aria-hidden>
        <FileIcon size={20} stroke={1.6} />
      </ThemeIcon>

      <Stack gap={4} flex={1} miw={0}>
        <Group gap="xs" wrap="wrap">
          <UnstyledButton onClick={() => onOpen(row)} className={classes.title}>
            <Text fw={600} truncate="end">
              {row.title}
            </Text>
          </UnstyledButton>
          {source && (
            <Badge variant="light" color={source.color} radius="sm" tt="none" fw={500}>
              {source.badge}
            </Badge>
          )}
        </Group>
        {meta.length > 0 && (
          <Text size="sm" c="dimmed" className={classes.meta}>
            {meta.join(' · ')}
          </Text>
        )}
        {row.categories.length > 0 && (
          <Group gap={6} mt={4}>
            {categories.map((category) => (
              <Badge key={category} variant="default" radius="sm" tt="none" fw={400} className={classes.chip}>
                {category}
              </Badge>
            ))}
            {hiddenCount > 0 && (
              <UnstyledButton onClick={() => setShowAllCategories((v) => !v)} className={classes.moreChip}>
                {showAllCategories ? 'Show less' : `+${hiddenCount} more`}
              </UnstyledButton>
            )}
          </Group>
        )}
      </Stack>

      <Group gap={4} wrap="nowrap">
        <Tooltip label="Preview" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label={`Preview ${row.title}`}
            onClick={() => onOpen(row)}
          >
            <IconEye size={18} />
          </ActionIcon>
        </Tooltip>
        {url && (
          <Tooltip label="Download" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              aria-label={`Download ${row.title}`}
              onClick={() =>
                openAttachment(medplum, url, {
                  download: true,
                  contentType: row.contentType,
                  filename: row.attachment?.title ?? row.title,
                }).catch(showErrorNotification)
              }
            >
              <IconDownload size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  );
}
