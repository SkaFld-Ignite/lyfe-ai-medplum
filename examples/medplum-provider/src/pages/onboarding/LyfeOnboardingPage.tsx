// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Badge, Button, Loader, Paper, Stack, Table, Tabs, Text, TextInput } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertCircle, IconSearch, IconUserPlus } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LyfePageHeader } from '../../components/brand/LyfePageHeader';
import type { DrChronoPatientSummary } from '../../services/onboarding';
import {
  describeNetworkPull,
  formatDrChronoName,
  importDrChronoPatient,
  pullNetworkRecord,
  searchDrChronoPatients,
} from '../../services/onboarding';
import { BulkImportPanel } from './BulkImportPanel';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 350;

/**
 * Step one of the Lyfe onboarding flow: find a patient in DrChrono.
 *
 * Importing one runs both halves — the DrChrono chart and then the patient's
 * network record — because a chart on its own is half a record and whether the
 * second half applies is not a question for whoever is clicking. Both are long
 * server-side jobs with a `Task` apiece, so the page starts them and watches
 * rather than holding a request open. See `services/onboarding.ts`.
 * @returns The onboarding search page.
 */
export function LyfeOnboardingPage(): JSX.Element {
  const medplum = useMedplum();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DrChronoPatientSummary[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [tab, setTab] = useState<string | null>('search');

  // Keyed by DrChrono patient id so each row reports its own progress; a single
  // shared flag would blank every other row's outcome the moment one is clicked.
  const [importing, setImporting] = useState<Record<string, boolean>>({});
  const [imported, setImported] = useState<Record<string, { ok: boolean; detail: string; medplumId?: string }>>({});
  const [zusRunning, setZusRunning] = useState<Record<string, boolean>>({});
  const [zusResult, setZusResult] = useState<Record<string, string>>({});
  const [indexResult, setIndexResult] = useState<Record<string, { ok: boolean; detail: string }>>({});

  /**
   * Import this patient: the DrChrono chart, then their network record.
   *
   * Both halves, always. This screen used to import the chart and stop — the
   * chaining only ever existed inside the bulk import worker — so a patient
   * imported from here ended up with a complete DrChrono chart and no outside
   * record at all, with nothing on screen to suggest anything was missing.
   * `importDrChronoPatient` now does both, and whether this patient qualifies
   * for the second half is decided server-side from their office's Directory
   * configuration.
   *
   * The network outcome is reported beside the chart's, never folded into it: a
   * patient who is not enrolled, or whose networks have not answered yet, still
   * has a perfectly good chart.
   */
  const runImport = useCallback(
    (patient: DrChronoPatientSummary): void => {
      const id = String(patient.id);
      setImporting((m) => ({ ...m, [id]: true }));
      setZusResult((m) => ({ ...m, [id]: '' }));
      setIndexResult((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
      importDrChronoPatient(medplum, id, (status, stage) => {
        if (stage === 'network') {
          setZusResult((m) => ({ ...m, [id]: status }));
        }
      })
        .then((r) => {
          const total = Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0);
          setImported((m) => ({
            ...m,
            [id]: r.ok
              ? { ok: true, detail: `${total} resources`, medplumId: r.medplumPatientId }
              : { ok: false, detail: r.error ?? 'Import failed' },
          }));
          setZusResult((m) => ({ ...m, [id]: r.ok ? describeNetworkPull(r.zus).detail : '' }));
          if (r.ok && r.index) {
            setIndexResult((m) => ({
              ...m,
              [id]: r.index?.ok
                ? { ok: true, detail: 'documents queued — AI summary follows' }
                : { ok: false, detail: `documents not indexed — ${r.index?.error ?? 'unknown reason'}` },
            }));
          }
        })
        .catch((err: Error) => setImported((m) => ({ ...m, [id]: { ok: false, detail: err.message } })))
        .finally(() => setImporting((m) => ({ ...m, [id]: false })));
    },
    [medplum]
  );

  /**
   * Run the network pull again for a patient whose chart is already in.
   *
   * Not an opt-in — the import above always pulls. This is a retry, and it
   * exists because a *fresh* enrolment comes back empty: enrolling starts
   * queries out to the networks that answer over hours, and a direct call like
   * this one gets a single attempt rather than the import worker's 30m/2h/6h
   * ladder. So the first pull of a new patient legitimately lands nothing, and
   * this is how someone gets the rest of it without re-importing the chart.
   */
  const runZus = useCallback(
    (drchronoId: string, medplumPatientId: string): void => {
      setZusRunning((m) => ({ ...m, [drchronoId]: true }));
      setZusResult((m) => ({ ...m, [drchronoId]: 'starting…' }));
      pullNetworkRecord(medplum, medplumPatientId, (status) => setZusResult((m) => ({ ...m, [drchronoId]: status })))
        .then((r) => setZusResult((m) => ({ ...m, [drchronoId]: describeNetworkPull(r).detail })))
        // `pullNetworkRecord` reports every outcome rather than throwing, so
        // this catches nothing in practice. It is here because a promise with no
        // rejection handler is a promise someone will one day wonder about.
        .catch((err: Error) => setZusResult((m) => ({ ...m, [drchronoId]: err.message })))
        .finally(() => setZusRunning((m) => ({ ...m, [drchronoId]: false })));
    },
    [medplum]
  );

  useEffect(() => {
    const trimmed = query.trim();
    abortRef.current?.abort();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults(undefined);
      setLoading(false);
      setError(undefined);
      return undefined;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const timer = setTimeout(() => {
      searchDrChronoPatients(medplum, trimmed)
        .then((found) => {
          setResults(found);
          setError(undefined);
        })
        .catch((err: Error) => {
          if (err.name !== 'AbortError') {
            setError(err.message);
            setResults(undefined);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [medplum, query]);

  return (
    <Stack gap="md" m="xs">
      <LyfePageHeader
        icon={<IconUserPlus size={20} />}
        eyebrow="Onboarding"
        title="New Patient"
        count={tab === 'search' ? results?.length : undefined}
        description="Search DrChrono for an existing record, or import a whole day's schedule"
      />

      <Tabs value={tab} onChange={setTab} variant="pills" radius="md">
        <Tabs.List grow mb="md">
          <Tabs.Tab value="search">Patient Search</Tabs.Tab>
          <Tabs.Tab value="bulk">Bulk Import</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="bulk">
          <Paper shadow="xs" p="md">
            <BulkImportPanel />
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="search">
          <Paper shadow="xs" p="md">
            <Stack gap="md">
              <TextInput
                size="md"
                radius="md"
                placeholder="Search DrChrono by name or chart ID…"
                leftSection={<IconSearch size={16} />}
                rightSection={loading ? <Loader size="xs" /> : undefined}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search DrChrono patients"
              />

              {error && (
                <Alert color="red" icon={<IconAlertCircle size={16} />} title="Search failed">
                  {error}
                </Alert>
              )}

              {results?.length === 0 && !loading && (
                <Text c="gray.5" size="sm" ta="center" py="lg">
                  No DrChrono patients match “{query.trim()}”.
                </Text>
              )}

              {!!results?.length && (
                <Table highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>Date of birth</Table.Th>
                      <Table.Th>Chart ID</Table.Th>
                      <Table.Th>Contact</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {results.map((patient) => (
                      <Table.Tr key={patient.id}>
                        <Table.Td>
                          <Text fw={500} size="sm">
                            {formatDrChronoName(patient)}
                          </Text>
                          {patient.gender && (
                            <Text size="xs" c="gray.5">
                              {patient.gender}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{patient.dateOfBirth ?? '—'}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge variant="light" color="gray" radius="sm">
                            {patient.chartId ?? patient.id}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{patient.email ?? '—'}</Text>
                          {patient.cellPhone && (
                            <Text size="xs" c="gray.5">
                              {patient.cellPhone}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td ta="right">
                          {imported[String(patient.id)] ? (
                            <Stack gap={4} align="flex-end">
                              <Text size="xs" c={imported[String(patient.id)].ok ? 'teal.7' : 'red.7'}>
                                {imported[String(patient.id)].ok ? 'Imported — ' : ''}
                                {imported[String(patient.id)].detail}
                              </Text>
                              {imported[String(patient.id)].medplumId && (
                                <Button
                                  size="compact-xs"
                                  variant="light"
                                  color="cyan"
                                  radius="md"
                                  loading={zusRunning[String(patient.id)]}
                                  onClick={() =>
                                    runZus(String(patient.id), imported[String(patient.id)].medplumId as string)
                                  }
                                >
                                  Pull from Lyfe
                                </Button>
                              )}
                              {zusResult[String(patient.id)] && (
                                <Text size="xs" c="gray.6">
                                  {zusResult[String(patient.id)]}
                                </Text>
                              )}
                              {/*
                                Shown whether it worked or not. A chart whose
                                documents were never indexed also never gets an
                                AI summary, and an absent summary with nothing
                                on screen to explain it is the failure that
                                costs someone an afternoon.
                              */}
                              {indexResult[String(patient.id)] && (
                                <Text size="xs" c={indexResult[String(patient.id)].ok ? 'gray.6' : 'orange.7'}>
                                  {indexResult[String(patient.id)].detail}
                                </Text>
                              )}
                            </Stack>
                          ) : (
                            <Button
                              size="xs"
                              radius="md"
                              loading={importing[String(patient.id)]}
                              onClick={() => runImport(patient)}
                            >
                              Import
                            </Button>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
