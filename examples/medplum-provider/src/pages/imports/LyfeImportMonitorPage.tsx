// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Alert,
  Badge,
  Box,
  Collapse,
  Group,
  Loader,
  Paper,
  Progress,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconActivity, IconAlertTriangle, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LyfePageHeader } from '../../components/brand/LyfePageHeader';
import type { DomainCounts, ImportRun } from '../../services/imports';
import { countPatientDomains, listImportRuns, resolvePatientNames } from '../../services/imports';

/** Uppercase micro-label, matching the roster and directory pages. */
const MICRO_LABEL = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--mantine-color-gray-5)',
} as const;

/** How often the feed refreshes while anything is still running. */
const POLL_MS = 4000;

/** Colour per Task status. */
const STATUS_COLOR: Record<string, string> = {
  'in-progress': 'blue',
  requested: 'gray',
  completed: 'teal',
  failed: 'red',
  cancelled: 'gray',
};

/**
 * Live view of every chart import, what it is pulling right now, and why any
 * of them failed.
 *
 * Everything on this page is read straight from the FHIR `Task` each import
 * keeps up to date, and from counting the imported resources themselves.
 * There is no job table and no status endpoint, so nothing here can drift out
 * of step with the data it describes.
 * @returns The import monitor page.
 */
export function LyfeImportMonitorPage(): JSX.Element {
  const medplum = useMedplum();
  const [runs, setRuns] = useState<ImportRun[]>();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    const next = await listImportRuns(medplum);
    setRuns(next);
    setNames(await resolvePatientNames(medplum, next));
    setError(undefined);
  }, [medplum]);

  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      listImportRuns(medplum)
        .then(async (next) => {
          if (cancelled) {
            return;
          }
          setRuns(next);
          setError(undefined);
          const resolved = await resolvePatientNames(medplum, next);
          if (!cancelled) {
            setNames(resolved);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    };

    tick();
    if (!autoRefresh) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [medplum, autoRefresh]);

  const active = useMemo(() => runs?.filter((r) => r.status === 'in-progress') ?? [], [runs]);
  const failed = useMemo(() => runs?.filter((r) => r.status === 'failed') ?? [], [runs]);

  return (
    <Stack gap="lg" p="md">
      <LyfePageHeader
        icon={<IconActivity size={20} />}
        eyebrow="Operations"
        title="Imports"
        count={runs?.length}
        description="Every chart import, what it is pulling right now, and why any of them failed."
        actions={
          <Group gap="sm">
            {active.length > 0 && <Loader size="xs" />}
            <Switch
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              label="Live"
              aria-label="Refresh automatically"
            />
          </Group>
        }
      />

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Could not load imports">
          {error}
        </Alert>
      )}

      {failed.length > 0 && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {failed.length} import{failed.length === 1 ? '' : 's'} failed. The reason is on each row — expand it for the
          message and for what had already landed before it stopped.
        </Alert>
      )}

      <Paper withBorder radius="md" p="md">
        {!runs && (
          <Stack gap="xs">
            <Skeleton height={34} radius="sm" />
            <Skeleton height={34} radius="sm" />
            <Skeleton height={34} radius="sm" />
          </Stack>
        )}

        {runs?.length === 0 && (
          <Text size="sm" c="dimmed">
            No imports yet. Start one from New Patient.
          </Text>
        )}

        {runs && runs.length > 0 && (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ ...MICRO_LABEL, width: 28 }} />
                <Table.Th style={MICRO_LABEL}>Patient</Table.Th>
                <Table.Th style={MICRO_LABEL}>Source</Table.Th>
                <Table.Th style={MICRO_LABEL}>Status</Table.Th>
                <Table.Th style={MICRO_LABEL}>Doing now</Table.Th>
                <Table.Th style={{ ...MICRO_LABEL, textAlign: 'right' }}>Resources</Table.Th>
                <Table.Th style={{ ...MICRO_LABEL, textAlign: 'right' }}>Took</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runs.map((run) => (
                <RunRows
                  key={run.id}
                  run={run}
                  name={run.patientReference ? names.get(run.patientReference) : undefined}
                  expanded={expanded === run.id}
                  onToggle={() => setExpanded(expanded === run.id ? undefined : run.id)}
                  onRefresh={load}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}

interface RunRowsProps {
  readonly run: ImportRun;
  readonly name?: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onRefresh: () => Promise<void>;
}

/**
 * One run as a summary row plus its expandable detail row.
 * @param props - Component props.
 * @returns Two table rows.
 */
function RunRows(props: RunRowsProps): JSX.Element {
  const { run } = props;
  const running = run.status === 'in-progress';
  const step = parsePhase(run.phase);

  return (
    <>
      <Table.Tr>
        <Table.Td>
          <UnstyledButton onClick={props.onToggle} aria-label={props.expanded ? 'Collapse' : 'Expand'}>
            {props.expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </UnstyledButton>
        </Table.Td>
        <Table.Td>
          <Text size="sm" fw={500}>
            {props.name ?? run.patientName ?? run.patientReference ?? '—'}
          </Text>
        </Table.Td>
        <Table.Td>
          <Badge variant="light" radius="sm" color={run.source === 'zus' ? 'cyan' : 'indigo'} style={BADGE}>
            {run.source === 'zus' ? 'Zus' : 'DrChrono'}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Badge variant="light" radius="sm" color={STATUS_COLOR[run.status] ?? 'gray'} style={BADGE}>
            {run.status}
          </Badge>
        </Table.Td>
        <Table.Td style={{ minWidth: 240 }}>
          {running && step ? (
            <Stack gap={4}>
              <Text size="sm">{step.label}</Text>
              <Progress value={(step.current / step.total) * 100} size="xs" radius="xl" />
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              {run.status === 'failed' ? (run.errorReason ?? 'failed') : (run.phase ?? '—')}
            </Text>
          )}
        </Table.Td>
        <Table.Td style={{ textAlign: 'right' }}>
          <Text size="sm">{run.total > 0 ? run.total.toLocaleString() : '—'}</Text>
        </Table.Td>
        <Table.Td style={{ textAlign: 'right' }}>
          <Text size="sm" c="dimmed">
            {formatDuration(run.durationMs)}
          </Text>
        </Table.Td>
      </Table.Tr>

      <Table.Tr>
        <Table.Td colSpan={7} style={{ padding: 0, border: 'none' }}>
          <Collapse in={props.expanded}>
            <Box p="md" style={{ background: 'var(--mantine-color-gray-0)' }}>
              <RunDetail run={run} />
            </Box>
          </Collapse>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

/**
 * Everything known about one run: failure reason, what it wrote, and what the
 * patient now holds from each source.
 * @param props - Component props.
 * @param props.run - The run to detail.
 * @returns The detail panel.
 */
function RunDetail(props: { run: ImportRun }): JSX.Element {
  const { run } = props;
  const medplum = useMedplum();
  const [domains, setDomains] = useState<DomainCounts[]>();
  const patientId = run.patientReference?.startsWith('Patient/')
    ? run.patientReference.slice('Patient/'.length)
    : undefined;

  useEffect(() => {
    if (!patientId) {
      return undefined;
    }
    let cancelled = false;
    countPatientDomains(medplum, patientId)
      .then((rows) => {
        if (!cancelled) {
          setDomains(rows);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [medplum, patientId]);

  const wrote = Object.entries(run.counts).filter(([, n]) => n > 0);
  const incomplete = Object.entries(run.incomplete);

  return (
    <Stack gap="md">
      {run.status === 'failed' && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={run.errorReason ?? 'Import failed'}>
          <Text size="sm" style={{ wordBreak: 'break-word' }}>
            {run.errorMessage ?? 'No message was recorded.'}
          </Text>
          {wrote.length > 0 && (
            <Text size="xs" c="dimmed" mt="xs">
              {run.total.toLocaleString()} resources had already been written before it stopped, and were kept.
            </Text>
          )}
        </Alert>
      )}

      {incomplete.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Finished short">
          <Stack gap={2}>
            {incomplete.map(([type, reason]) => (
              <Text size="sm" key={type}>
                <b>{type}</b>: {reason}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Group align="flex-start" gap="xl" wrap="wrap">
        <Box style={{ minWidth: 260 }}>
          <Text style={MICRO_LABEL} mb="xs">
            This run wrote
          </Text>
          {wrote.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing yet.
            </Text>
          ) : (
            <Stack gap={2}>
              {wrote
                .sort((a, b) => b[1] - a[1])
                .map(([type, n]) => (
                  <Group key={type} justify="space-between" gap="xl">
                    <Text size="sm">{type}</Text>
                    <Text size="sm" fw={500}>
                      {n.toLocaleString()}
                    </Text>
                  </Group>
                ))}
            </Stack>
          )}
        </Box>

        <Box style={{ flex: 1, minWidth: 320 }}>
          <Text style={MICRO_LABEL} mb="xs">
            This patient now holds
          </Text>
          {!patientId && (
            <Text size="sm" c="dimmed">
              This run is not tied to a patient.
            </Text>
          )}

          {patientId && !domains && <Skeleton height={80} radius="sm" />}

          {patientId && domains && (
            <Table verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={MICRO_LABEL}>Domain</Table.Th>
                  <Table.Th style={{ ...MICRO_LABEL, textAlign: 'right' }}>DrChrono</Table.Th>
                  <Table.Th style={{ ...MICRO_LABEL, textAlign: 'right' }}>Zus</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {domains.map((d) => (
                  <Table.Tr key={d.key}>
                    <Table.Td>
                      <Text size="sm" c={d.drchrono + d.zus === 0 ? 'dimmed' : undefined}>
                        {d.label}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <CountCell value={d.drchrono} />
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <CountCell value={d.zus} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Box>
      </Group>

      <Text size="xs" c="dimmed">
        Counts are read from the resources themselves, not from what the importer reported, so they stay honest about
        what actually landed. Task/{run.id}
      </Text>
    </Stack>
  );
}

/**
 * A count, dimmed to an em dash when nothing was pulled.
 * @param props - Component props.
 * @param props.value - The count.
 * @returns The cell contents.
 */
function CountCell(props: { value: number }): JSX.Element {
  return props.value > 0 ? (
    <Text size="sm" fw={500}>
      {props.value.toLocaleString()}
    </Text>
  ) : (
    <Tooltip label="Nothing pulled from this source">
      <Text size="sm" c="dimmed">
        —
      </Text>
    </Tooltip>
  );
}

const BADGE = { textTransform: 'none', fontWeight: 500 } as const;

/**
 * Split a phase string like "6 of 11 · allergies" into its parts.
 * @param phase - The Task businessStatus text.
 * @returns The step numbers and label, or undefined when it is not a phase.
 */
function parsePhase(phase: string | undefined): { current: number; total: number; label: string } | undefined {
  const match = /^(\d+) of (\d+) · (.+)$/.exec(phase ?? '');
  if (!match) {
    return undefined;
  }
  return { current: Number(match[1]), total: Number(match[2]), label: match[3] };
}

/**
 * Format a duration for the list.
 * @param ms - Duration in milliseconds.
 * @returns A short human-readable duration.
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
