// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconBuildingHospital, IconRefresh, IconSearch, IconStethoscope } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LyfePageHeader } from '../../components/brand/LyfePageHeader';
import type { Directory, DirectoryRow } from '../../services/directory';
import {
  DirectoryBackendUnavailableError,
  loadDirectory,
  setLocationEnabled,
  setPractitionerEnabled,
  syncDirectoryFromDrChrono,
} from '../../services/directory';
import { showErrorNotification, showSuccessNotification } from '../../utils/notifications';

/** Uppercase micro-label, matching the roster and integrations pages. */
const MICRO_LABEL = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--mantine-color-gray-5)',
} as const;

/** Which half of the directory a section renders. */
type Section = 'practitioners' | 'locations';

/**
 * Providers and offices pulled from DrChrono, each switchable on or off.
 *
 * Switching an office off means the clinic imports nothing from it: no new
 * appointments are pulled for it, on a bulk preview or on a single chart
 * import. The same holds for a provider.
 *
 * The rows are plain FHIR `Practitioner` and `Location` resources and the
 * switch writes their own `active` / `status` field, so the state lives on the
 * resource rather than in a table this page would have to keep in step.
 * @returns The directory page.
 */
export function LyfeDirectoryPage(): JSX.Element {
  const medplum = useMedplum();
  const [directory, setDirectory] = useState<Directory>();
  const [error, setError] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDirectory(await loadDirectory(medplum));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [medplum]);

  useEffect(() => {
    let cancelled = false;
    loadDirectory(medplum)
      .then((next) => {
        if (!cancelled) {
          setDirectory(next);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [medplum]);

  const onSync = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      const summary = await syncDirectoryFromDrChrono(medplum);
      await refresh();
      showSuccessNotification({
        title: 'Directory updated',
        message: `Pulled ${summary.practitioners.wrote} providers and ${summary.locations.wrote} offices from DrChrono.`,
      });
    } catch (err) {
      const message =
        err instanceof DirectoryBackendUnavailableError
          ? err.message
          : `Could not pull from DrChrono: ${err instanceof Error ? err.message : String(err)}`;
      showErrorNotification(message);
    } finally {
      setSyncing(false);
    }
  }, [medplum, refresh]);

  const onToggle = useCallback(
    async (section: Section, row: DirectoryRow, enabled: boolean): Promise<void> => {
      const key = `${section}:${row.id}`;
      setPending((prev) => new Set(prev).add(key));

      // Move the switch immediately and roll it back on failure. Waiting for
      // the round trip makes the control feel broken on a slow connection.
      setDirectory((prev) => (prev ? patchRow(prev, section, row.id, enabled) : prev));

      try {
        if (section === 'practitioners') {
          await setPractitionerEnabled(medplum, row.id, enabled);
        } else {
          await setLocationEnabled(medplum, row.id, enabled);
        }
      } catch (err) {
        setDirectory((prev) => (prev ? patchRow(prev, section, row.id, !enabled) : prev));
        showErrorNotification(`Could not update ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [medplum]
  );

  const term = filter.trim().toLowerCase();
  const matches = useCallback(
    (rows: DirectoryRow[]): DirectoryRow[] =>
      term
        ? rows.filter(
            (r) =>
              r.name.toLowerCase().includes(term) || r.detail?.toLowerCase().includes(term) || r.sourceId.includes(term)
          )
        : rows,
    [term]
  );

  const practitioners = useMemo(() => matches(directory?.practitioners ?? []), [directory, matches]);
  const locations = useMemo(() => matches(directory?.locations ?? []), [directory, matches]);

  const disabledOffices = directory?.locations.filter((l) => !l.enabled).length ?? 0;
  const disabledProviders = directory?.practitioners.filter((p) => !p.enabled).length ?? 0;
  const total = (directory?.practitioners.length ?? 0) + (directory?.locations.length ?? 0);

  return (
    <Stack gap="lg" p="md">
      <LyfePageHeader
        icon={<IconBuildingHospital size={20} />}
        eyebrow="Configuration"
        title="Directory"
        count={directory ? total : undefined}
        description="Providers and offices pulled from DrChrono. Switching one off stops every future import from it."
        actions={
          <Button
            leftSection={<IconRefresh size={16} />}
            variant="light"
            loading={syncing}
            onClick={() => {
              onSync().catch(() => undefined);
            }}
          >
            Pull from DrChrono
          </Button>
        }
      />

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title="Could not load the directory">
          {error}
        </Alert>
      )}

      {(disabledOffices > 0 || disabledProviders > 0) && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
          {describeDisabled(disabledOffices, disabledProviders)} Their appointments are excluded from bulk previews and
          from single chart imports.
        </Alert>
      )}

      <TextInput
        placeholder="Search providers and offices"
        leftSection={<IconSearch size={16} />}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ maxWidth: 360 }}
      />

      <DirectorySection
        icon={<IconStethoscope size={16} />}
        title="Providers"
        emptyHint="No providers yet. Use “Pull from DrChrono” to load them."
        detailHeading="Specialty"
        loading={!directory}
        rows={practitioners}
        pending={pending}
        section="practitioners"
        onToggle={onToggle}
      />

      <DirectorySection
        icon={<IconBuildingHospital size={16} />}
        title="Offices"
        emptyHint="No offices yet. Use “Pull from DrChrono” to load them."
        detailHeading="Address"
        loading={!directory}
        rows={locations}
        pending={pending}
        section="locations"
        onToggle={onToggle}
      />
    </Stack>
  );
}

interface DirectorySectionProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly emptyHint: string;
  readonly detailHeading: string;
  readonly loading: boolean;
  readonly rows: DirectoryRow[];
  readonly pending: ReadonlySet<string>;
  readonly section: Section;
  readonly onToggle: (section: Section, row: DirectoryRow, enabled: boolean) => Promise<void>;
}

/**
 * One half of the directory as a table of switchable rows.
 * @param props - Component props.
 * @returns The section element.
 */
function DirectorySection(props: DirectorySectionProps): JSX.Element {
  const enabledCount = props.rows.filter((r) => r.enabled).length;

  return (
    <Paper withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <Group gap="xs">
          <Box style={{ color: 'var(--mantine-primary-color-filled)', display: 'grid', placeItems: 'center' }}>
            {props.icon}
          </Box>
          <Text fw={600}>{props.title}</Text>
          {!props.loading && (
            <Badge variant="light" radius="sm">
              {enabledCount} of {props.rows.length} on
            </Badge>
          )}
        </Group>
      </Group>

      {props.loading && (
        <Stack gap="xs">
          <Skeleton height={32} radius="sm" />
          <Skeleton height={32} radius="sm" />
          <Skeleton height={32} radius="sm" />
        </Stack>
      )}

      {!props.loading && props.rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {props.emptyHint}
        </Text>
      )}

      {!props.loading && props.rows.length > 0 && (
        <Table highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={MICRO_LABEL}>Name</Table.Th>
              <Table.Th style={MICRO_LABEL}>{props.detailHeading}</Table.Th>
              <Table.Th style={MICRO_LABEL}>DrChrono ID</Table.Th>
              <Table.Th style={{ ...MICRO_LABEL, textAlign: 'right' }}>Enabled</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {props.rows.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td>
                  <Text size="sm" fw={500} c={row.enabled ? undefined : 'dimmed'}>
                    {row.name}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {row.detail ?? '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed" ff="monospace">
                    {row.sourceId}
                  </Text>
                </Table.Td>
                <Table.Td style={{ textAlign: 'right' }}>
                  <Switch
                    checked={row.enabled}
                    disabled={props.pending.has(`${props.section}:${row.id}`)}
                    aria-label={`Enable ${row.name}`}
                    onChange={(e) => {
                      props.onToggle(props.section, row, e.target.checked).catch(() => undefined);
                    }}
                    style={{ display: 'inline-flex' }}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Paper>
  );
}

/**
 * Replace one row's enabled state without mutating the directory in place.
 * @param directory - Current directory.
 * @param section - Which half the row is in.
 * @param id - Resource id of the row to change.
 * @param enabled - The new state.
 * @returns A new directory with that row updated.
 */
function patchRow(directory: Directory, section: Section, id: string, enabled: boolean): Directory {
  const update = (rows: DirectoryRow[]): DirectoryRow[] => rows.map((r) => (r.id === id ? { ...r, enabled } : r));
  return section === 'practitioners'
    ? { ...directory, practitioners: update(directory.practitioners) }
    : { ...directory, locations: update(directory.locations) };
}

/**
 * Sentence describing what is currently switched off.
 * @param offices - How many offices are off.
 * @param providers - How many providers are off.
 * @returns A sentence naming both counts, or just the non-zero one.
 */
function describeDisabled(offices: number, providers: number): string {
  const parts: string[] = [];
  if (offices > 0) {
    parts.push(`${offices} ${offices === 1 ? 'office' : 'offices'}`);
  }
  if (providers > 0) {
    parts.push(`${providers} ${providers === 1 ? 'provider' : 'providers'}`);
  }
  // "is" only when a single subject of one, so this never reads
  // "1 office is and 3 providers are switched off".
  const verb = parts.length === 1 && offices + providers === 1 ? 'is' : 'are';
  return `${parts.join(' and ')} ${verb} switched off.`;
}
