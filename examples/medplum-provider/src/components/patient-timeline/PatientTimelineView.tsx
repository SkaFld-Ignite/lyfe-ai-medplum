// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  CloseButton,
  Collapse,
  Divider,
  Group,
  Paper,
  Pill,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import type { WithId } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendar,
  IconCalendarEvent,
  IconChevronDown,
  IconChevronRight,
  IconFilter,
  IconRefresh,
  IconSearch,
  IconStethoscope,
  IconTag,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { usePatientTimelineData } from '../../hooks/usePatientTimelineData';
import type {
  DataSource,
  OngoingItem,
  TimelineEvent,
  TimelineEventKind,
  TimelineFilters,
  TimelineRecord,
} from '../../utils/patient-timeline';
import {
  chartPath,
  countByKind,
  EMPTY_FILTERS,
  filterTimeline,
  getRelativeDayLabel,
  getVisitStatusLabel,
  groupByCondition,
  groupByDay,
  hasActiveFilters,
  toDayKey,
  UNCATEGORIZED_GROUP,
} from '../../utils/patient-timeline';
import { FilterMenu } from '../scheduling-overview/FilterMenu';
import { ConditionCard, DayRecordsCard } from './EventCards';
import { OngoingCareCard } from './OngoingCareCard';
import classes from './PatientTimeline.module.css';
import { DAYS_PER_PAGE, formatMediumDate, KIND_CONFIG, KIND_ORDER, SOURCE_FILTER_LABELS } from './timeline-config';
import { RailItem, TimelineSkeleton } from './TimelineBits';
import { TimelineRecordDrawer } from './TimelineRecordDrawer';
import { VisitCard } from './VisitCard';

type OpenRecord = { kind: TimelineEventKind; title: string; resource: WithId<Resource> };
type GroupBy = 'date' | 'condition';

export interface PatientTimelineViewProps {
  patientId: string;
}

/**
 * The patient's chronological history: visits (with the records linked to them), conditions and
 * each day's other records, grouped by day or by condition, with search and filters.
 * @param props - The view props.
 * @returns The patient timeline.
 */
export function PatientTimelineView(props: PatientTimelineViewProps): JSX.Element {
  const { patientId } = props;
  const navigate = useNavigate();
  const { timeline, loading, error, truncatedTypes, reload } = usePatientTimelineData(patientId);
  const [filters, setFilters] = useState<TimelineFilters>(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('date');
  const [visibleDays, setVisibleDays] = useState(DAYS_PER_PAGE);
  const [openRecord, setOpenRecord] = useState<OpenRecord>();

  const events = useMemo(() => timeline?.events ?? [], [timeline]);
  const filtered = useMemo(() => filterTimeline(events, filters), [events, filters]);
  const kindCounts = useMemo(() => countByKind(events), [events]);
  const dayGroups = useMemo(() => groupByDay(filtered), [filtered]);
  const conditionGroups = useMemo(() => groupByCondition(filtered), [filtered]);

  const providerOptions = useMemo(() => {
    const names = new Set<string>();
    for (const event of events) {
      if (event.type === 'visit' && event.provider) {
        names.add(event.provider);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ key: name, label: name }));
  }, [events]);

  const sourceOptions = useMemo(() => {
    const present = new Set(events.flatMap((e) => e.sources));
    return (Object.keys(SOURCE_FILTER_LABELS) as DataSource[])
      .filter((s) => present.has(s))
      .map((s) => ({ key: s, label: SOURCE_FILTER_LABELS[s] }));
  }, [events]);

  const statusOptions = useMemo(() => {
    const statuses = new Set<string>();
    for (const event of events) {
      if (event.type === 'visit' && event.status) {
        statuses.add(event.status);
      }
    }
    return [...statuses].sort().map((s) => ({ key: s, label: getVisitStatusLabel(s) ?? s }));
  }, [events]);

  const typeOptions = KIND_ORDER.filter((kind) => kindCounts[kind]).map((kind) => ({
    key: kind,
    label: `${KIND_CONFIG[kind].plural} (${kindCounts[kind]})`,
  }));

  const timeZone = useClinicTimeZone();
  const now = new Date();
  const todayKey = toDayKey(now, timeZone);
  const total = events.length;
  const visiblePercent = total > 0 ? Math.round((filtered.length / total) * 100) : 0;
  const active = hasActiveFilters(filters);
  const activeFilterCount =
    filters.kinds.length + filters.providers.length + filters.sources.length + filters.statuses.length;

  const update = (changes: Partial<TimelineFilters>): void => {
    setFilters((prev) => ({ ...prev, ...changes }));
    setVisibleDays(DAYS_PER_PAGE);
  };

  const openTimelineRecord = (record: TimelineRecord): void =>
    setOpenRecord({ kind: record.kind, title: record.title, resource: record.resource });
  const openOngoing = (item: OngoingItem): void =>
    setOpenRecord({ kind: item.kind, title: item.title, resource: item.resource });

  const renderEvent = (event: TimelineEvent): JSX.Element => {
    if (event.type === 'visit') {
      const upcoming = event.date.getTime() > now.getTime();
      let highlight: 'alert' | 'upcoming' | undefined;
      if (event.isEmergency) {
        highlight = 'alert';
      } else if (upcoming) {
        highlight = 'upcoming';
      }
      return (
        <RailItem key={event.id} kind="visit" highlight={highlight}>
          <VisitCard patientId={patientId} visit={event} upcoming={upcoming} onOpenRecord={openTimelineRecord} />
        </RailItem>
      );
    }
    if (event.type === 'condition') {
      return (
        <RailItem key={event.id} kind="condition">
          <ConditionCard
            event={event}
            onOpen={() => setOpenRecord({ kind: 'condition', title: event.title, resource: event.condition })}
          />
        </RailItem>
      );
    }
    return (
      <RailItem key={event.id} kind={event.records[0]?.kind ?? 'document'}>
        <DayRecordsCard event={event} onOpenRecord={openTimelineRecord} />
      </RailItem>
    );
  };

  // Only the first load shows placeholders; a refresh keeps the current timeline on screen.
  const initialLoading = !timeline && loading;

  let body: JSX.Element | null;
  if (initialLoading) {
    body = <TimelineSkeleton />;
  } else if (!timeline) {
    // Failed to load: the error alert above says why.
    body = null;
  } else if (filtered.length === 0) {
    body = (
      <Stack align="center" gap={6} py={48} className={classes.empty}>
        <ThemeIcon variant="light" color="gray" size={44} radius="xl">
          <IconCalendar size={22} />
        </ThemeIcon>
        <Text fw={600} size="sm">
          {total === 0 ? 'No history yet' : 'No events match'}
        </Text>
        <Text size="xs" c="dimmed">
          {total === 0
            ? 'Visits, conditions and records will appear here as they are added.'
            : 'Try adjusting your filters or search.'}
        </Text>
      </Stack>
    );
  } else if (groupBy === 'condition') {
    body = (
      <Stack gap="md">
        {conditionGroups.map((group) => (
          <ConditionSection key={group.name} name={group.name} count={group.events.length}>
            {group.events.map(renderEvent)}
          </ConditionSection>
        ))}
      </Stack>
    );
  } else {
    const shown = dayGroups.slice(0, visibleDays);
    body = (
      <Stack gap="xl">
        {shown.map((day) => {
          const [y, m, d] = day.dayKey.split('-').map(Number);
          const date = new Date(y, m - 1, d);
          const relative = getRelativeDayLabel(day.dayKey, todayKey);
          const isToday = day.dayKey === todayKey;
          const isFuture = day.dayKey > todayKey;
          return (
            <Box component="section" key={day.dayKey} aria-label={formatMediumDate(date, timeZone)}>
              <Group gap="sm" wrap="nowrap" className={classes.dayHeader}>
                <Badge
                  variant={isToday ? 'light' : 'default'}
                  color={isToday ? 'blue' : 'gray'}
                  size="lg"
                  radius="md"
                  leftSection={<IconCalendar size={13} />}
                  tt="none"
                  className={classes.dayChip}
                >
                  {formatMediumDate(date, timeZone)}
                </Badge>
                {relative && (
                  <Badge
                    size="xs"
                    radius="xl"
                    variant={isToday ? 'filled' : 'light'}
                    color={isToday || isFuture ? 'blue' : 'gray'}
                  >
                    {relative}
                  </Badge>
                )}
                <Divider flex={1} />
                <Text size="xs" c="dimmed" className={classes.tabular}>
                  {day.events.length} {day.events.length === 1 ? 'event' : 'events'}
                </Text>
              </Group>
              <Box className={classes.rail}>{day.events.map(renderEvent)}</Box>
            </Box>
          );
        })}
        {dayGroups.length > visibleDays && (
          <Button variant="default" onClick={() => setVisibleDays((n) => n + DAYS_PER_PAGE)} mx="auto">
            Show older ({dayGroups.length - visibleDays} more {dayGroups.length - visibleDays === 1 ? 'day' : 'days'})
          </Button>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="md" p="md" data-testid="patient-timeline">
      {timeline && timeline.ongoing.length > 0 && <OngoingCareCard items={timeline.ongoing} onOpen={openOngoing} />}

      <Paper withBorder radius="md" className={classes.main}>
        <Group justify="space-between" wrap="wrap" gap="md" p="md" className={classes.header}>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={44} radius="md" variant="gradient" gradient={{ from: 'blue.5', to: 'indigo.7', deg: 135 }}>
              <IconCalendarEvent size={22} />
            </ThemeIcon>
            <Box>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase" className={classes.eyebrow}>
                Records
              </Text>
              <Title order={3}>Patient Timeline</Title>
              <Text size="sm" c="dimmed">
                Chronological history of patient events
              </Text>
            </Box>
          </Group>
          <Group gap="sm">
            <Group gap="md" className={classes.statsPill}>
              <Box ta="right">
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" className={classes.eyebrow}>
                  Total events
                </Text>
                {initialLoading ? (
                  <Skeleton h={18} w={32} ml="auto" mt={3} radius="sm" />
                ) : (
                  <Text fw={700} className={classes.tabular} aria-label={`Total events: ${total}`}>
                    {total}
                  </Text>
                )}
              </Box>
              <Divider orientation="vertical" />
              <Box ta="right">
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" className={classes.eyebrow}>
                  Visible
                </Text>
                {initialLoading ? (
                  <Skeleton h={18} w={40} ml="auto" mt={3} radius="sm" />
                ) : (
                  <Text fw={700} c="blue.7" className={classes.tabular}>
                    {visiblePercent}%
                  </Text>
                )}
              </Box>
            </Group>
            <Tooltip label="Refresh" withArrow>
              <ActionIcon variant="default" size="lg" aria-label="Refresh timeline" onClick={reload} loading={loading}>
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        <Stack gap="sm" p="md">
          <TextInput
            size="md"
            radius="md"
            value={filters.query}
            onChange={(e) => update({ query: e.currentTarget.value })}
            placeholder="Search by event, provider, condition, medication..."
            aria-label="Search timeline"
            leftSection={<IconSearch size={16} />}
            rightSection={
              filters.query ? <CloseButton aria-label="Clear search" onClick={() => update({ query: '' })} /> : null
            }
            classNames={{ input: classes.search }}
          />

          <Group gap="sm" className={classes.toolbar}>
            <Group gap={6}>
              <IconFilter size={16} className={classes.muted} />
              <Text size="sm" fw={600}>
                Filters
              </Text>
              {activeFilterCount > 0 && (
                <Badge size="sm" circle>
                  {activeFilterCount}
                </Badge>
              )}
            </Group>
            <FilterMenu
              label="All types"
              pluralLabel="Types"
              icon={<IconActivity size={14} />}
              options={typeOptions}
              selected={filters.kinds}
              onChange={(kinds) => update({ kinds: kinds as TimelineEventKind[] })}
            />
            {providerOptions.length > 0 && (
              <FilterMenu
                label="Provider"
                pluralLabel="Providers"
                icon={<IconStethoscope size={14} />}
                options={providerOptions}
                selected={filters.providers}
                onChange={(providers) => update({ providers })}
              />
            )}
            {sourceOptions.length > 1 && (
              <FilterMenu
                label="Source"
                pluralLabel="Sources"
                icon={<IconWorld size={14} />}
                options={sourceOptions}
                selected={filters.sources}
                onChange={(sources) => update({ sources: sources as DataSource[] })}
              />
            )}
            {statusOptions.length > 0 && (
              <FilterMenu
                label="Visit status"
                pluralLabel="Statuses"
                icon={<IconFilter size={14} />}
                options={statusOptions}
                selected={filters.statuses}
                onChange={(statuses) => update({ statuses })}
              />
            )}
            <SegmentedControl
              size="xs"
              radius="md"
              ml="auto"
              value={groupBy}
              onChange={(value) => setGroupBy(value as GroupBy)}
              aria-label="Group timeline by"
              data={[
                { value: 'date', label: 'Date' },
                { value: 'condition', label: 'Condition' },
              ]}
            />
            {initialLoading ? (
              <Skeleton h={26} w={130} radius="md" />
            ) : (
              <Text size="xs" c="dimmed" className={classes.countPill}>
                Showing <b>{filtered.length}</b> of <b>{total}</b> ·{' '}
                <b className={classes.percent}>{visiblePercent}%</b>
              </Text>
            )}
            {active && (
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconX size={12} />}
                onClick={() => update(EMPTY_FILTERS)}
              >
                Clear all
              </Button>
            )}
          </Group>

          {active && (
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                Active filters:
              </Text>
              {filters.query.trim() && (
                <Pill withRemoveButton onRemove={() => update({ query: '' })}>
                  “{filters.query.trim()}”
                </Pill>
              )}
              {filters.kinds.map((kind) => (
                <Pill
                  key={kind}
                  withRemoveButton
                  onRemove={() => update({ kinds: filters.kinds.filter((k) => k !== kind) })}
                >
                  {KIND_CONFIG[kind].plural}
                </Pill>
              ))}
              {filters.providers.map((name) => (
                <Pill
                  key={name}
                  withRemoveButton
                  onRemove={() => update({ providers: filters.providers.filter((p) => p !== name) })}
                >
                  {name}
                </Pill>
              ))}
              {filters.sources.map((source) => (
                <Pill
                  key={source}
                  withRemoveButton
                  onRemove={() => update({ sources: filters.sources.filter((s) => s !== source) })}
                >
                  {SOURCE_FILTER_LABELS[source]}
                </Pill>
              ))}
              {filters.statuses.map((status) => (
                <Pill
                  key={status}
                  withRemoveButton
                  onRemove={() => update({ statuses: filters.statuses.filter((s) => s !== status) })}
                >
                  {getVisitStatusLabel(status)}
                </Pill>
              ))}
            </Group>
          )}

          {error && (
            <Alert color="red" icon={<IconAlertTriangle />} title="Could not load the timeline">
              {error}
            </Alert>
          )}
          {truncatedTypes.length > 0 && (
            <Alert color="yellow" icon={<IconAlertTriangle />}>
              This patient has more records than can be shown at once ({truncatedTypes.join(', ')}). The newest are
              shown; older ones may be missing.
            </Alert>
          )}

          <Box pt="xs">{body}</Box>
        </Stack>
      </Paper>

      <TimelineRecordDrawer
        record={openRecord}
        onClose={() => setOpenRecord(undefined)}
        onOpenInChart={(resource) => navigate(chartPath(patientId, resource))?.catch(console.error)}
      />
    </Stack>
  );
}

function ConditionSection({
  name,
  count,
  children,
}: {
  name: string;
  count: number;
  children: JSX.Element[];
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const uncategorized = name === UNCATEGORIZED_GROUP;
  return (
    <Box component="section" aria-label={name}>
      <UnstyledButton className={classes.conditionHeader} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ThemeIcon variant="light" color={uncategorized ? 'gray' : 'violet'} size={28} radius="md">
          <IconTag size={14} />
        </ThemeIcon>
        <Text size="sm" fw={600} flex={1}>
          {name}
        </Text>
        <Badge variant="default" size="sm">
          {count} {count === 1 ? 'event' : 'events'}
        </Badge>
        {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
      </UnstyledButton>
      <Collapse in={open}>
        <Box className={classes.rail} mt="sm">
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}
