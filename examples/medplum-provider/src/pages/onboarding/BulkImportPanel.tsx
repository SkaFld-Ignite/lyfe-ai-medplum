// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertCircle, IconDatabase, IconSearch } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import type { BulkImportCandidate } from '../../services/onboarding';
import {
  DRCHRONO_IDENTIFIER_SYSTEM,
  formatDrChronoName,
  importDrChronoPatient,
  importZusRecord,
  previewBulkImport,
} from '../../services/onboarding';

const today = (): string => new Date().toISOString().slice(0, 10);

/** Badge colour per run state. */
const RUN_STATUS_COLOR: Record<RunRow['status'], string> = {
  pending: 'gray',
  importing: 'blue',
  zus: 'cyan',
  done: 'teal',
  skipped: 'yellow',
  failed: 'red',
};

const RUN_BADGE = { textTransform: 'none', fontWeight: 500 } as const;

/** Per-patient outcome while a bulk run is in flight. */
interface RunRow {
  readonly drchronoId: string;
  readonly name: string;
  status: 'pending' | 'importing' | 'zus' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

interface PreviewState {
  readonly scannedAppointments: number;
  readonly candidates: BulkImportCandidate[];
  /** Appointments dropped because their office or provider is switched off. */
  readonly skippedByDirectory: number;
  /** DrChrono ids already present in Medplum, so the UI can show what is genuinely new. */
  readonly existing: ReadonlySet<string>;
}

/**
 * Import every patient on a day's schedule, rather than one name at a time.
 *
 * Preview is deliberately separate from import: a clinic day can be a hundred
 * charts, and each one pulls minutes of DrChrono and Zus data, so the count is
 * confirmed before anything is written.
 * @returns The bulk import panel.
 */
export function BulkImportPanel(): JSX.Element {
  const medplum = useMedplum();
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<PreviewState>();
  const [run, setRun] = useState<RunRow[]>();
  const [running, setRunning] = useState(false);
  const [withZus, setWithZus] = useState(true);

  const runPreview = useCallback(() => {
    setLoading(true);
    setError(undefined);
    setPreview(undefined);

    previewBulkImport(medplum, start, end || undefined)
      .then(async (result) => {
        // One search rather than N: FHIR treats comma-separated values as OR, so
        // the whole day's roster is checked for existing charts in a single call.
        const existing = new Set<string>();
        if (result.candidates.length > 0) {
          const ids = result.candidates.map((c) => c.id).join(',');
          const found = await medplum.searchResources(
            'Patient',
            `identifier=${encodeURIComponent(`${DRCHRONO_IDENTIFIER_SYSTEM}|`)}${ids}&_count=1000`
          );
          for (const p of found) {
            const value = p.identifier?.find((i) => i.system === DRCHRONO_IDENTIFIER_SYSTEM)?.value;
            if (value) {
              existing.add(value);
            }
          }
        }
        setPreview({ ...result, existing });
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [medplum, start, end]);

  const newCount = preview ? preview.candidates.filter((c) => !preview.existing.has(String(c.id))).length : 0;

  /**
   * Import every new patient on the previewed day, one at a time.
   *
   * Sequential on purpose. Each chart is thousands of writes and Medplum's
   * rate limiter is per-project, so running these concurrently makes them all
   * fail together rather than finishing sooner. One patient's failure is
   * recorded and the run continues: a bad chart in the middle of a day's
   * schedule should not cost the rest of the day.
   */
  const startRun = useCallback(async (): Promise<void> => {
    if (!preview) {
      return;
    }
    const todo = preview.candidates.filter((c) => !preview.existing.has(String(c.id)));
    setRunning(true);
    setRun(todo.map((c) => ({ drchronoId: String(c.id), name: formatDrChronoName(c), status: 'pending' as const })));

    const update = (id: string, patch: Partial<RunRow>): void =>
      setRun((prev) => prev?.map((r) => (r.drchronoId === id ? { ...r, ...patch } : r)));

    for (const candidate of todo) {
      const id = String(candidate.id);
      update(id, { status: 'importing', detail: undefined });
      try {
        const result = await importDrChronoPatient(medplum, id, (status) => update(id, { detail: status }));
        if (!result.ok || !result.medplumPatientId) {
          update(id, { status: 'failed', detail: result.error ?? 'import failed' });
          continue;
        }

        if (!withZus) {
          update(id, { status: 'done', detail: 'chart imported' });
          continue;
        }

        update(id, { status: 'zus', detail: 'enrolling…' });
        const zus = await importZusRecord(medplum, result.medplumPatientId, (status) => update(id, { detail: status }));
        if (zus.ok) {
          const total = Object.values(zus.counts ?? {}).reduce((sum, n) => sum + n, 0);
          update(id, { status: 'done', detail: `chart + ${total} Zus resources` });
        } else {
          // Not a failure of the run: the office may simply not be enrolled in
          // Zus, which is a configuration choice rather than an error.
          update(id, { status: 'skipped', detail: zus.error ?? 'Zus skipped' });
        }
      } catch (err) {
        update(id, { status: 'failed', detail: err instanceof Error ? err.message : String(err) });
      }
    }

    setRunning(false);
  }, [medplum, preview, withZus]);

  return (
    <Stack gap="md">
      <Box>
        <Text fw={600} size="lg" c="gray.9">
          Bulk Patient Import
        </Text>
        <Text size="sm" c="gray.5">
          Import all patients from a specific appointment date
        </Text>
      </Box>

      <Alert variant="light" color="gray" icon={<IconDatabase size={16} />}>
        Select an appointment date to import all patients from that day. Only new patients will be imported (existing
        patients are skipped).
      </Alert>

      <Box>
        <Text fw={600} size="sm" c="gray.9" mb="xs">
          Appointment Date Range
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <TextInput label="Start Date" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextInput label="End Date (Optional)" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          <Box style={{ display: 'flex', alignItems: 'flex-end' }}>
            <Button
              fullWidth
              leftSection={<IconSearch size={16} />}
              loading={loading}
              disabled={!start}
              onClick={runPreview}
            >
              Preview
            </Button>
          </Box>
        </SimpleGrid>
        <Text size="xs" c="gray.5" mt={6}>
          Fetch appointments from {start}
          {end && end !== start ? ` to ${end}` : ''} (excluding Cancelled/Rescheduled/No Show)
        </Text>
      </Box>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} title="Preview failed">
          {error}
        </Alert>
      )}

      {preview && (
        <Paper withBorder p="md" radius="md">
          <Group gap="lg" mb="sm">
            <Stat label="Appointments scanned" value={preview.scannedAppointments} />
            <Stat label="Patients found" value={preview.candidates.length} />
            <Stat label="New to import" value={newCount} highlight />
            <Stat label="Already in Medplum" value={preview.candidates.length - newCount} />
          </Group>

          {preview.skippedByDirectory > 0 && (
            <Text size="sm" c="dimmed" mb="sm">
              {preview.skippedByDirectory} appointment{preview.skippedByDirectory === 1 ? ' was' : 's were'} skipped:
              their office or provider is switched off in the{' '}
              <Anchor component={Link} to="/directory">
                Directory
              </Anchor>
              .
            </Text>
          )}

          {preview.candidates.length > 0 && (
            <Table highlightOnHover verticalSpacing="xs" mt="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Date of birth</Table.Th>
                  <Table.Th>Chart ID</Table.Th>
                  <Table.Th>Appts</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.candidates.map((c) => {
                  const already = preview.existing.has(String(c.id));
                  return (
                    <Table.Tr key={c.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {formatDrChronoName(c)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{c.dateOfBirth ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="default" radius="sm" style={{ textTransform: 'none', fontWeight: 500 }}>
                          {c.chartId ?? c.id}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{c.appointments}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          radius="sm"
                          color={already ? 'gray' : 'teal'}
                          style={{ textTransform: 'none', fontWeight: 500 }}
                        >
                          {already ? 'Skip — already imported' : 'New'}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}

          <Group justify="space-between" mt="md">
            <Checkbox
              checked={withZus}
              disabled={running}
              onChange={(e) => setWithZus(e.target.checked)}
              label="Also pull each patient's Zus record"
              description="Only offices with Zus enrolment switched on in the Directory are sent to Zus."
            />
            <Button
              loading={running}
              disabled={newCount === 0}
              onClick={() => {
                startRun().catch(() => undefined);
              }}
            >
              Start Bulk Import ({newCount})
            </Button>
          </Group>

          {run && run.length > 0 && (
            <Paper withBorder p="md" radius="md" mt="md">
              <Group justify="space-between" mb="sm">
                <Text fw={600} size="sm">
                  Import progress
                </Text>
                <Text size="sm" c="dimmed">
                  {run.filter((r) => r.status === 'done').length} done ·{' '}
                  {run.filter((r) => r.status === 'skipped').length} Zus skipped ·{' '}
                  {run.filter((r) => r.status === 'failed').length} failed · {run.length} total
                </Text>
              </Group>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Patient</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Detail</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {run.map((r) => (
                    <Table.Tr key={r.drchronoId}>
                      <Table.Td>
                        <Text size="sm">{r.name}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" radius="sm" color={RUN_STATUS_COLOR[r.status]} style={RUN_BADGE}>
                          {r.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {r.detail ?? '—'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          )}
        </Paper>
      )}
    </Stack>
  );
}

/**
 * A single labelled figure in the preview summary.
 * @param props - Component props.
 * @param props.label - What the figure counts.
 * @param props.value - The figure itself.
 * @param props.highlight - Renders the value in the primary colour.
 * @returns The stat element.
 */
function Stat(props: { readonly label: string; readonly value: number; readonly highlight?: boolean }): JSX.Element {
  return (
    <Box>
      <Text fz={11} fw={600} c="gray.5" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {props.label}
      </Text>
      <Text fz={24} fw={600} c={props.highlight ? 'primary.6' : 'gray.9'}>
        {props.value}
      </Text>
    </Box>
  );
}
