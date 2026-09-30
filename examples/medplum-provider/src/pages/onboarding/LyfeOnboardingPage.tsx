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
  formatDrChronoName,
  importDrChronoPatient,
  importZusRecord,
  searchDrChronoPatients,
} from '../../services/onboarding';
import { BulkImportPanel } from './BulkImportPanel';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 350;

/**
 * Step one of the Lyfe onboarding flow: find a patient in DrChrono.
 *
 * Importing is deliberately not wired up yet — the import runs DrChrono and Zus
 * pulls that take minutes, so it belongs in a Medplum Bot with a Task to track
 * progress, not in a request the browser holds open. See `services/onboarding.ts`.
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

  const runImport = useCallback(
    (patient: DrChronoPatientSummary): void => {
      const id = String(patient.id);
      setImporting((m) => ({ ...m, [id]: true }));
      importDrChronoPatient(medplum, id)
        .then((r) => {
          const total = Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0);
          setImported((m) => ({
            ...m,
            [id]: r.ok
              ? { ok: true, detail: `${total} resources`, medplumId: r.medplumPatientId }
              : { ok: false, detail: r.error ?? 'Import failed' },
          }));
        })
        .catch((err: Error) => setImported((m) => ({ ...m, [id]: { ok: false, detail: err.message } })))
        .finally(() => setImporting((m) => ({ ...m, [id]: false })));
    },
    [medplum]
  );

  /**
   * Pull (and publish back) this patient's Zus record.
   *
   * Separate from the chart import on purpose. A patient already in Medplum
   * has no reason to re-import their DrChrono chart just to refresh Zus, and
   * before this there was no way to run the Zus leg on its own at all.
   */
  const runZus = useCallback(
    (drchronoId: string, medplumPatientId: string): void => {
      setZusRunning((m) => ({ ...m, [drchronoId]: true }));
      setZusResult((m) => ({ ...m, [drchronoId]: 'starting…' }));
      importZusRecord(medplum, medplumPatientId, (status) => setZusResult((m) => ({ ...m, [drchronoId]: status })))
        .then((r) => {
          const total = Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0);
          setZusResult((m) => ({
            ...m,
            [drchronoId]: r.ok ? `Zus — ${total} resources` : (r.error ?? 'Zus failed'),
          }));
        })
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
                                  Pull from Zus
                                </Button>
                              )}
                              {zusResult[String(patient.id)] && (
                                <Text size="xs" c="gray.6">
                                  {zusResult[String(patient.id)]}
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
