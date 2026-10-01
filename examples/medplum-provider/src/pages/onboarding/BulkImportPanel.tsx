// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
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
import { IMPORT_WORKER_URL, queueBulkImport } from '../../services/bulk-import';
import type { BulkImportCandidate, NetworkPullState } from '../../services/onboarding';
import {
  describeNetworkPull,
  DRCHRONO_IDENTIFIER_SYSTEM,
  formatDrChronoName,
  importDrChronoPatient,
  previewBulkImport,
} from '../../services/onboarding';

const today = (): string => new Date().toISOString().slice(0, 10);

/** Badge colour per run state. */
const RUN_STATUS_COLOR: Record<RunRow['status'], string> = {
  pending: 'gray',
  importing: 'blue',
  zus: 'cyan',
  done: 'teal',
  waiting: 'cyan',
  skipped: 'yellow',
  failed: 'red',
};

const RUN_BADGE = { textTransform: 'none', fontWeight: 500 } as const;

/**
 * The row state each network-pull outcome lands on.
 *
 * None of the three is `failed`, which is the whole point: the chart is in
 * either way, and only the wording about the outside record differs.
 */
const NETWORK_ROW_STATUS: Record<NetworkPullState, RunRow['status']> = {
  pulled: 'done',
  pending: 'waiting',
  skipped: 'skipped',
};

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
 * How many patients are imported at once.
 *
 * Not one, which is what this was — a day's clinic then took as long as all of
 * its patients added together. Not all of them either, and that is the part
 * worth explaining, because "start all 122 jobs" looks like the obvious answer.
 *
 * Medplum runs an async `$execute` **immediately and in-process**:
 * `AsyncJobExecutor.start()` invokes the callback and returns, with no queue
 * and no concurrency limit anywhere in the path. (Medplum does run BullMQ
 * workers with concurrency caps, but bot execution does not go through them.)
 * So 122 started jobs are 122 bot executions running at once inside a single
 * Node process on one Railway instance, each of them also hammering DrChrono
 * and Zus. The server has no way to push back, and neither do they.
 *
 * Bounding it here is therefore the only place the limit can currently live.
 * It is one number, and raising it is a one-line change once a real day has
 * been measured; the split between starting a job and waiting for one is what
 * makes raising it free.
 *
 * The cost of bounding it in the page is honest and worth stating: only the
 * imports already started survive a refresh. Getting durability *and* a
 * concurrency limit needs a real queue behind the bots — see LYF2-209.
 */
const IMPORT_CONCURRENCY = 6;

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
  /**
   * `waiting` and `skipped` both mean the chart is fully imported. They describe
   * the network half only: `waiting` is a fresh enrolment the networks have not
   * answered yet, `skipped` an office without enrolment switched on. Neither is
   * a failure, and neither should ever be shown as one.
   */
  status: 'pending' | 'importing' | 'zus' | 'done' | 'waiting' | 'failed' | 'skipped';
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

    // Preferred path: hand the whole run to the import worker in one call.
    //
    // The worker owns it from that moment, so closing the tab does not stop it
    // and concurrency is decided there, per clinic, rather than by a constant
    // in this file. The page then only watches.
    if (IMPORT_WORKER_URL) {
      try {
        const queued = await queueBulkImport(
          medplum,
          todo.map((c) => String(c.id))
        );
        setRun((prev) =>
          prev?.map((r) => ({ ...r, status: 'importing' as const, detail: `queued · ${queued.batchId}` }))
        );
        setRunning(false);
        return;
      } catch (err) {
        // A worker that is unreachable must not strand the run: fall through to
        // driving it from the page, which is slower but still works.
        setRun((prev) => prev?.map((r) => ({ ...r, detail: err instanceof Error ? err.message : String(err) })));
      }
    }

    // Fallback: drive the imports from here, a bounded number at a time. See
    // IMPORT_CONCURRENCY for why this is bounded rather than started all at
    // once — Medplum runs an async $execute immediately and in-process, so
    // "all at once" means 122 bot executions inside one Node process.
    await mapWithConcurrency(todo, IMPORT_CONCURRENCY, async (candidate) => {
      const id = String(candidate.id);
      update(id, { status: 'importing', detail: 'starting…' });
      try {
        // One call for both halves. The network pull is part of importing a
        // chart rather than something this loop decides to add, so there is no
        // longer a branch here that could skip it — see `importDrChronoPatient`.
        const result = await importDrChronoPatient(medplum, id, (status, stage) =>
          update(id, { status: stage === 'network' ? 'zus' : 'importing', detail: status })
        );
        if (!result.ok || !result.medplumPatientId) {
          update(id, { status: 'failed', detail: result.error ?? 'import failed' });
          return;
        }

        // The chart is in. What the network half did only changes the wording,
        // never whether this row counts as a failure.
        const network = describeNetworkPull(result.zus);
        update(id, {
          status: NETWORK_ROW_STATUS[network.state],
          detail: `chart imported — ${network.detail}`,
        });
      } catch (err) {
        update(id, { status: 'failed', detail: err instanceof Error ? err.message : String(err) });
      }
    });

    setRunning(false);
  }, [medplum, preview]);

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
            {/* What used to be a checkbox here. The record pull is not a choice:
                it always follows the chart, and which patients qualify is read
                from the Directory server-side. So this says what will happen
                rather than asking whether it should. */}
            <Text size="xs" c="gray.6" maw={420}>
              Each chart is followed by a record pull for patients seen at an office with Zus enrolment switched on in
              the{' '}
              <Anchor component={Link} to="/directory">
                Directory
              </Anchor>
              .
            </Text>
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
                {/* `done`, `waiting` and `skipped` are all imported charts, so
                    they are counted apart from `failed` rather than lumped in
                    with it. */}
                <Text size="sm" c="dimmed">
                  {run.filter((r) => r.status === 'done').length} done ·{' '}
                  {run.filter((r) => r.status === 'waiting').length} awaiting records ·{' '}
                  {run.filter((r) => r.status === 'skipped').length} not enrolled ·{' '}
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
