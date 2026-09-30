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
  awaitDrChronoImport,
  awaitZusImport,
  DRCHRONO_IDENTIFIER_SYSTEM,
  formatDrChronoName,
  previewBulkImport,
  startDrChronoImport,
  startZusImport,
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

/**
 * Explain the gap between appointments scanned and patients found.
 * @param preview - The preview result.
 * @returns A clause listing each reason an appointment was excluded.
 */
function describeExclusions(preview: PreviewState): string {
  const parts: string[] = [];
  if (preview.excludedByStatus > 0) {
    parts.push(`${preview.excludedByStatus} were cancelled, rescheduled or no-shows`);
  }
  if (preview.skippedByDirectory > 0) {
    parts.push(`${preview.skippedByDirectory} were at a switched-off office or provider`);
  }
  const total = preview.scannedAppointments - preview.candidates.length;
  if (parts.length === 0) {
    return `${total} were excluded,`;
  }
  return `${parts.join(', ')},`;
}

/** Per-patient outcome while a bulk run is in flight. */
/**
 * How many import jobs are *started* at once.
 *
 * This paces the starting requests, not the work: a start returns as soon as
 * the job is queued server-side, so all of a day's patients are running within
 * a few seconds either way. Issuing 122 POSTs in one burst is just impolite to
 * the API, and a burst is also the one shape most likely to trip a rate limit
 * before any real work has happened.
 */
const START_CONCURRENCY = 6;

/**
 * Run an async mapper over a list with a bounded number of calls in flight.
 * @param items - What to process.
 * @param limit - Maximum concurrent calls.
 * @param worker - Applied to each item.
 * @returns Results, index-aligned to `items`.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor++;
      out[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runner()));
  return out;
}

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
  readonly excludedByStatus: number;
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

  // An end date before the start date is a silent no-op against DrChrono: the
  // chunk loop simply never runs and the preview reports zero appointments,
  // which reads as "that day is empty" rather than "those dates are the wrong
  // way round". Catch it here, and again in the bot, so neither a typo nor a
  // caller that skips this form can ask for an impossible range.
  const rangeInverted = Boolean(end) && end < start;
  const canPreview = Boolean(start) && !rangeInverted;

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

    // Every chart import is started up front, as its own server-side job.
    //
    // This used to be a `for` loop that awaited each patient in turn, which
    // made a day's clinic take as long as all of its patients added together —
    // hours for a hundred-odd charts — and abandoned every patient that had not
    // been reached yet if the tab was closed, because the loop driving them
    // lived in the page.
    //
    // Starting them all first inverts that. The work belongs to the server
    // immediately, so the run survives a refresh and the patients proceed
    // concurrently; the page is only watching. Starts are issued a few at a
    // time rather than as one burst of 122 requests, which is about politeness
    // to the API, not about pacing the work — a start returns as soon as the
    // job is queued.
    const started = await mapWithConcurrency(todo, START_CONCURRENCY, async (candidate) => {
      const id = String(candidate.id);
      try {
        const jobId = await startDrChronoImport(medplum, id);
        update(id, { status: 'importing', detail: 'queued' });
        return { id, jobId };
      } catch (err) {
        update(id, { status: 'failed', detail: err instanceof Error ? err.message : String(err) });
        return { id, jobId: undefined };
      }
    });

    // Then watch them. Each patient's Zus pull is chained onto its own chart
    // import rather than waiting for the whole batch, so a fast patient is not
    // held up behind a slow one.
    await Promise.all(
      started.map(async ({ id, jobId }) => {
        if (!jobId) {
          return;
        }
        try {
          const result = await awaitDrChronoImport(medplum, jobId, (status) => update(id, { detail: status }));
          if (!result.ok || !result.medplumPatientId) {
            update(id, { status: 'failed', detail: result.error ?? 'import failed' });
            return;
          }

          if (!withZus) {
            update(id, { status: 'done', detail: 'chart imported' });
            return;
          }

          update(id, { status: 'zus', detail: 'enrolling…' });
          const zusJob = await startZusImport(medplum, result.medplumPatientId);
          const zus = await awaitZusImport(medplum, zusJob, (status) => update(id, { detail: status }));
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
      })
    );

    setRunning(false);
  }, [medplum, preview, withZus]);

  return (
    <Stack gap="md">
      <Box>
        <Text fw={600} size="lg" c="gray.9">
          Bulk Patient Import
        </Text>
        <Text size="sm" c="gray.5">
          Import every patient with an appointment in a date range
        </Text>
      </Box>

      <Alert variant="light" color="gray" icon={<IconDatabase size={16} />}>
        Cancelled, rescheduled and no-show appointments are excluded. Patients already in Medplum are skipped.
      </Alert>

      <Box>
        <Text fw={600} size="sm" c="gray.9" mb="xs">
          Appointment Date Range
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <TextInput
            label="Start Date"
            type="date"
            value={start}
            max={end || undefined}
            onChange={(e) => setStart(e.target.value)}
          />
          <TextInput
            label="End Date (Optional)"
            type="date"
            value={end}
            min={start || undefined}
            error={rangeInverted ? 'Must be on or after the start date' : undefined}
            onChange={(e) => setEnd(e.target.value)}
          />
          <Box style={{ display: 'flex', alignItems: 'flex-end' }}>
            <Button
              fullWidth
              leftSection={<IconSearch size={16} />}
              loading={loading}
              disabled={!canPreview}
              onClick={runPreview}
            >
              Preview
            </Button>
          </Box>
        </SimpleGrid>
        <Text size="xs" c={rangeInverted ? 'red.7' : 'gray.5'} mt={6}>
          {rangeInverted ? (
            `${end} is before ${start} — no appointments could fall in that range.`
          ) : (
            <>
              Fetch appointments from {start}
              {end && end !== start ? ` to ${end}` : ''} (excluding Cancelled/Rescheduled/No Show)
            </>
          )}
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
            <Stat label="Appointments" value={preview.scannedAppointments} />
            <Stat label="Patients found" value={preview.candidates.length} />
            <Stat label="New to import" value={newCount} highlight />
            <Stat label="Already in Medplum" value={preview.candidates.length - newCount} />
          </Group>

          {/* "171 scanned, 113 patients" reads like somebody was booked twice.
              Saying what came out of the 171 removes the question. */}
          {preview.scannedAppointments > preview.candidates.length && (
            <Text size="xs" c="gray.6" mb="sm">
              Of {preview.scannedAppointments} appointments on the schedule, {describeExclusions(preview)} leaving{' '}
              {preview.candidates.length}.
            </Text>
          )}

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
