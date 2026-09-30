// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Alert,
  Button,
  CloseButton,
  Group,
  Menu,
  Pagination,
  Paper,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import type { Patient, Reference } from '@medplum/fhirtypes';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCopy,
  IconFileText,
  IconFilter,
  IconSearch,
  IconTag,
  IconUpload,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { usePatientDocuments } from '../../hooks/usePatientDocuments';
import { showErrorNotification, showSuccessNotification } from '../../utils/notifications';
import type { DocumentFilters } from '../../utils/patient-documents';
import {
  collectCategories,
  countBySource,
  DEFAULT_DOCUMENT_FILTERS,
  DOCUMENT_SORT_OPTIONS,
  filterDocuments,
  formatDocumentList,
} from '../../utils/patient-documents';
import { FilterMenu } from '../scheduling-overview/FilterMenu';
import { DocumentPreviewModal } from './DocumentPreviewModal';
import { DocumentRowItem } from './DocumentRowItem';
import { DOCUMENT_SOURCES, DOCUMENTS_PER_PAGE } from './documents-config';
import classes from './PatientDocuments.module.css';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';

export interface PatientDocumentsViewProps {
  patientId: string;
  /** The document open in the preview, from the URL. */
  documentId?: string;
  onOpenDocument: (documentId: string) => void;
  onClosePreview: () => void;
  onUpload: () => void;
  /** Changes when a document is uploaded elsewhere, to reload the list. */
  reloadKey: number;
}

/**
 * The patient's documents as one searchable list: header with counts and actions, search,
 * source chips, category and sort menus, paged rows, and a preview modal.
 * @param props - The view props.
 * @returns The documents view.
 */
export function PatientDocumentsView(props: PatientDocumentsViewProps): JSX.Element {
  const { patientId, documentId, onOpenDocument, onClosePreview, onUpload, reloadKey } = props;
  const { rows, loading, error, truncated, reload } = usePatientDocuments(patientId, reloadKey);
  const timeZone = useClinicTimeZone();
  const [filters, setFilters] = useState<DocumentFilters>(DEFAULT_DOCUMENT_FILTERS);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => filterDocuments(rows, filters), [rows, filters]);
  const sourceCounts = useMemo(() => countBySource(rows), [rows]);
  const categoryOptions = useMemo(
    () => collectCategories(rows).map((c) => ({ key: c.label, label: `${c.label} (${c.count})` })),
    [rows]
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / DOCUMENTS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const shown = filtered.slice((currentPage - 1) * DOCUMENTS_PER_PAGE, currentPage * DOCUMENTS_PER_PAGE);
  const initialLoading = loading && rows.length === 0;
  const patient: Reference<Patient> = { reference: `Patient/${patientId}` };
  const openRow = rows.find((row) => row.id === documentId);

  const update = (changes: Partial<DocumentFilters>): void => {
    setFilters((prev) => ({ ...prev, ...changes }));
    setPage(1);
  };

  const copyList = (): void => {
    navigator.clipboard
      .writeText(formatDocumentList(filtered, timeZone))
      .then(() => showSuccessNotification({ message: `Copied ${filtered.length} documents` }))
      .catch(showErrorNotification);
  };

  const subtitle = initialLoading
    ? 'Loading documents…'
    : [
        `${filtered.length} of ${rows.length} documents`,
        sourceCounts.drchrono > 0 && `${sourceCounts.drchrono} from DrChrono`,
      ]
        .filter(Boolean)
        .join(' • ');

  let list: JSX.Element;
  if (initialLoading) {
    list = (
      <Stack gap={0} aria-busy="true" aria-label="Loading documents">
        {[0, 1, 2, 3, 4].map((i) => (
          <Group key={i} wrap="nowrap" gap="md" className={classes.row}>
            <Skeleton h={40} w={40} radius="md" />
            <Stack gap={8} flex={1}>
              <Skeleton h={14} w={`${50 - i * 5}%`} radius="xl" />
              <Skeleton h={10} w="35%" radius="xl" />
            </Stack>
          </Group>
        ))}
      </Stack>
    );
  } else if (shown.length === 0) {
    list = (
      <Stack align="center" gap={6} py={56}>
        <ThemeIcon variant="light" color="gray" size={48} radius="xl">
          <IconFileText size={24} />
        </ThemeIcon>
        <Text fw={600}>{rows.length === 0 ? 'No documents yet' : 'No documents match'}</Text>
        <Text size="sm" c="dimmed">
          {rows.length === 0 ? 'Uploaded and imported documents will appear here.' : 'Try another search or filter.'}
        </Text>
      </Stack>
    );
  } else {
    list = (
      <div>
        {shown.map((row) => (
          <DocumentRowItem key={row.id} row={row} onOpen={(r) => onOpenDocument(r.id)} />
        ))}
      </div>
    );
  }

  return (
    <Stack gap="md" p="md" data-testid="patient-documents">
      <Paper withBorder radius="lg" p="lg" className={classes.headerCard}>
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <IconFileText size={26} stroke={1.6} className={classes.headerIcon} />
            <div>
              <Title order={3}>Documents</Title>
              <Text size="sm" c="dimmed">
                {subtitle}
              </Text>
            </div>
          </Group>
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconCopy size={16} />}
              onClick={copyList}
              disabled={filtered.length === 0}
            >
              Copy
            </Button>
            <Button leftSection={<IconUpload size={16} />} onClick={onUpload}>
              Upload
            </Button>
          </Group>
        </Group>

        <TextInput
          mt="lg"
          size="md"
          radius="md"
          value={filters.query}
          onChange={(e) => update({ query: e.currentTarget.value })}
          placeholder="Search documents..."
          aria-label="Search documents"
          leftSection={<IconSearch size={16} />}
          rightSection={
            filters.query ? <CloseButton aria-label="Clear search text" onClick={() => update({ query: '' })} /> : null
          }
        />

        <Group mt="md" gap="xs" wrap="wrap">
          <Group gap={6} c="dimmed">
            <IconFilter size={16} />
            <Text size="sm">Source:</Text>
          </Group>
          <UnstyledButton
            className={classes.sourceChip}
            data-active={!filters.source || undefined}
            aria-pressed={!filters.source}
            aria-label="All sources"
            onClick={() => update({ source: undefined })}
          >
            All
          </UnstyledButton>
          {DOCUMENT_SOURCES.map(({ source, label, color }) => (
            <UnstyledButton
              key={source}
              className={classes.sourceChip}
              data-active={filters.source === source || undefined}
              aria-pressed={filters.source === source}
              aria-label={`${label} (${sourceCounts[source]} ${sourceCounts[source] === 1 ? 'document' : 'documents'})`}
              onClick={() => update({ source: filters.source === source ? undefined : source })}
            >
              <span className={classes.sourceDot} style={{ background: `var(--mantine-color-${color}-6)` }} />
              {label}
              <span className={classes.sourceCount}>{sourceCounts[source]}</span>
            </UnstyledButton>
          ))}

          <Menu position="bottom-start" shadow="md" withinPortal>
            <Menu.Target>
              <Button variant="default" rightSection={<IconChevronDown size={14} />} className={classes.menuButton}>
                Sort: {DOCUMENT_SORT_OPTIONS.find((o) => o.value === filters.sort)?.label}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {DOCUMENT_SORT_OPTIONS.map((option) => (
                <Menu.Item
                  key={option.value}
                  onClick={() => update({ sort: option.value })}
                  fw={option.value === filters.sort ? 600 : undefined}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>

          {categoryOptions.length > 0 && (
            <FilterMenu
              label="Categories"
              pluralLabel="Categories"
              icon={<IconTag size={14} />}
              options={categoryOptions}
              selected={filters.categories}
              onChange={(categories) => update({ categories })}
            />
          )}
        </Group>
      </Paper>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not load documents">
          {error}
          <Button variant="subtle" color="red" size="compact-sm" ml="sm" onClick={reload}>
            Retry
          </Button>
        </Alert>
      )}
      {truncated && (
        <Alert color="yellow" icon={<IconAlertTriangle />}>
          This patient has more documents than can be listed at once. The newest are shown.
        </Alert>
      )}

      <Paper withBorder radius="lg" className={classes.listCard}>
        {list}
      </Paper>

      {pageCount > 1 && (
        <Group justify="center">
          <Pagination total={pageCount} value={currentPage} onChange={setPage} radius="md" />
        </Group>
      )}

      <DocumentPreviewModal
        documentId={documentId}
        document={openRow?.document}
        patient={patient}
        onClose={onClosePreview}
        onChanged={reload}
        onDeleted={() => {
          reload();
          onClosePreview();
        }}
      />
    </Stack>
  );
}
