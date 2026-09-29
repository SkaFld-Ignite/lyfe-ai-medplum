// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import { formatCodeableConcept, formatObservationValue, getReferenceString } from '@medplum/core';
import type {
  AllergyIntolerance,
  Appointment,
  CodeableConcept,
  Condition,
  DiagnosticReport,
  DocumentReference,
  Encounter,
  Immunization,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Procedure,
  Reference,
  Resource,
} from '@medplum/fhirtypes';

/** Where a record came from, derived from `meta.tag` (e.g. `https://lyfe.com/source|drchrono`). */
export type DataSource = 'drchrono' | 'zus' | 'other';

/** Kinds of clinical record shown on the timeline. */
export type RecordKind =
  'condition' | 'vitals' | 'lab' | 'observation' | 'document' | 'medication' | 'allergy' | 'immunization' | 'procedure';

/** Kinds of timeline event, used by the type filter. */
export type TimelineEventKind = 'visit' | RecordKind;

export interface TimelineRecord {
  kind: RecordKind;
  resource: WithId<Resource>;
  title: string;
  detail?: string;
  date?: Date;
  source: DataSource;
}

interface TimelineEventBase {
  id: string;
  date: Date;
  /** Local calendar day, `YYYY-MM-DD`. */
  dayKey: string;
  sources: DataSource[];
}

/** A visit: an Encounter and/or its Appointment, merged across duplicate copies from different sources. */
export interface VisitEvent extends TimelineEventBase {
  type: 'visit';
  encounter?: WithId<Encounter>;
  appointment?: WithId<Appointment>;
  /** Every Encounter id merged into this visit, used to attach linked records. */
  encounterIds: string[];
  title: string;
  status?: string;
  provider?: string;
  location?: string;
  reason?: string;
  isEmergency: boolean;
  /** Condition names this visit was for (diagnosis / reason), used for "group by condition". */
  conditionLabels: string[];
  /** Records that reference this visit through an `encounter` field. */
  records: TimelineRecord[];
}

/** A condition with an onset or recorded date, merged across duplicate copies. */
export interface ConditionEvent extends TimelineEventBase {
  type: 'condition';
  condition: WithId<Condition>;
  title: string;
  detail?: string;
  clinicalStatus?: string;
  /** How many duplicate copies were merged into this event. */
  copies: number;
}

/** All of one day's records that are not linked to any visit. */
export interface DayRecordsEvent extends TimelineEventBase {
  type: 'records';
  records: TimelineRecord[];
}

export type TimelineEvent = VisitEvent | ConditionEvent | DayRecordsEvent;

export interface OngoingItem {
  id: string;
  kind: RecordKind;
  title: string;
  detail?: string;
  resource: WithId<Resource>;
}

export interface TimelineSources {
  encounters: WithId<Encounter>[];
  appointments: WithId<Appointment>[];
  conditions: WithId<Condition>[];
  observations: WithId<Observation>[];
  diagnosticReports: WithId<DiagnosticReport>[];
  documents: WithId<DocumentReference>[];
  medicationRequests: WithId<MedicationRequest>[];
  medicationStatements: WithId<MedicationStatement>[];
  allergies: WithId<AllergyIntolerance>[];
  immunizations: WithId<Immunization>[];
  procedures: WithId<Procedure>[];
}

export interface PatientTimeline {
  /** Newest first. */
  events: TimelineEvent[];
  ongoing: OngoingItem[];
}

// ---- Small helpers ---------------------------------------------------------------------------

/**
 * Formats a date as a local `YYYY-MM-DD` key, so days are the viewer's calendar days.
 * @param date - The date.
 * @returns The local day key.
 */
export function toDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function conceptText(concept: CodeableConcept | undefined): string | undefined {
  const text = concept ? formatCodeableConcept(concept).trim() : '';
  return text || undefined;
}

function firstText(concepts: (CodeableConcept | undefined)[] | undefined): string | undefined {
  for (const concept of concepts ?? []) {
    const text = conceptText(concept);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Where a resource came from, based on its `meta.tag` codes.
 * @param resource - Any FHIR resource.
 * @returns The data source.
 */
export function getDataSource(resource: Resource): DataSource {
  const codes = (resource.meta?.tag ?? []).map((tag) => tag.code?.toLowerCase());
  if (codes.includes('drchrono')) {
    return 'drchrono';
  }
  if (codes.includes('zus')) {
    return 'zus';
  }
  return 'other';
}

function isEnteredInError(resource: Resource): boolean {
  const r = resource as { status?: string; verificationStatus?: CodeableConcept };
  return (
    r.status === 'entered-in-error' ||
    r.verificationStatus?.coding?.some((coding) => coding.code === 'entered-in-error') === true
  );
}

function referenceId(reference: Reference | undefined, resourceType: string): string | undefined {
  const value = reference?.reference;
  return value?.startsWith(`${resourceType}/`) ? value.slice(resourceType.length + 1) : undefined;
}

const ENCOUNTER_CLASS_TITLES: Record<string, string> = {
  AMB: 'Office visit',
  EMER: 'Emergency visit',
  IMP: 'Inpatient stay',
  ACUTE: 'Inpatient stay',
  VR: 'Virtual visit',
  HH: 'Home health visit',
  OBSENC: 'Observation stay',
};

const STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  proposed: 'Proposed',
  pending: 'Pending',
  booked: 'Scheduled',
  arrived: 'Arrived',
  'checked-in': 'Checked in',
  triaged: 'Triaged',
  'in-progress': 'In progress',
  onleave: 'On leave',
  fulfilled: 'Completed',
  finished: 'Completed',
  cancelled: 'Cancelled',
  noshow: 'No show',
  waitlist: 'Waitlist',
  unknown: 'Unknown',
};

/**
 * Display label for an Encounter or Appointment status.
 * @param status - The FHIR status code.
 * @returns A human-readable label.
 */
export function getVisitStatusLabel(status: string | undefined): string | undefined {
  return status ? (STATUS_LABELS[status] ?? status) : undefined;
}

// ---- Records ---------------------------------------------------------------------------------

function observationKind(observation: Observation): RecordKind {
  const codes = (observation.category ?? []).flatMap((c) => c.coding?.map((coding) => coding.code) ?? []);
  if (codes.includes('vital-signs')) {
    return 'vitals';
  }
  if (codes.includes('laboratory')) {
    return 'lab';
  }
  return 'observation';
}

function toRecord(resource: WithId<Resource>): TimelineRecord | undefined {
  const source = getDataSource(resource);
  switch (resource.resourceType) {
    case 'Observation': {
      const title = conceptText(resource.code) ?? 'Observation';
      const value = formatObservationValue(resource);
      return {
        kind: observationKind(resource),
        resource,
        title,
        detail: value || undefined,
        date: parseDate(resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued),
        source,
      };
    }
    case 'DiagnosticReport':
      return {
        kind: 'lab',
        resource,
        title: conceptText(resource.code) ?? 'Diagnostic report',
        detail: resource.conclusion,
        date: parseDate(resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued),
        source,
      };
    case 'DocumentReference':
      return {
        kind: 'document',
        resource,
        title: resource.description ?? conceptText(resource.type) ?? 'Document',
        detail: firstText(resource.category),
        date: parseDate(resource.date ?? resource.context?.period?.start),
        source,
      };
    case 'MedicationRequest':
      return {
        kind: 'medication',
        resource,
        title: conceptText(resource.medicationCodeableConcept) ?? resource.medicationReference?.display ?? 'Medication',
        detail: resource.dosageInstruction?.[0]?.text,
        date: parseDate(resource.authoredOn),
        source,
      };
    case 'MedicationStatement':
      return {
        kind: 'medication',
        resource,
        title: conceptText(resource.medicationCodeableConcept) ?? resource.medicationReference?.display ?? 'Medication',
        detail: resource.dosage?.[0]?.text,
        date: parseDate(resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.dateAsserted),
        source,
      };
    case 'AllergyIntolerance':
      return {
        kind: 'allergy',
        resource,
        title: conceptText(resource.code) ?? 'Allergy',
        detail: resource.reaction?.[0]?.manifestation
          ?.map((m) => conceptText(m))
          .filter(Boolean)
          .join(', '),
        date: parseDate(resource.recordedDate ?? resource.onsetDateTime),
        source,
      };
    case 'Immunization':
      return {
        kind: 'immunization',
        resource,
        title: conceptText(resource.vaccineCode) ?? 'Immunization',
        date: parseDate(resource.occurrenceDateTime),
        source,
      };
    case 'Procedure':
      return {
        kind: 'procedure',
        resource,
        title: conceptText(resource.code) ?? 'Procedure',
        date: parseDate(resource.performedDateTime ?? resource.performedPeriod?.start),
        source,
      };
    case 'Condition':
      return {
        kind: 'condition',
        resource,
        title: conceptText(resource.code) ?? 'Condition',
        detail: conceptText(resource.clinicalStatus),
        date: conditionDate(resource),
        source,
      };
    default:
      return undefined;
  }
}

function conditionDate(condition: Condition): Date | undefined {
  return parseDate(condition.onsetDateTime ?? condition.onsetPeriod?.start ?? condition.recordedDate);
}

function linkedEncounterId(resource: Resource): string | undefined {
  switch (resource.resourceType) {
    case 'DocumentReference':
      return referenceId(resource.context?.encounter?.[0], 'Encounter');
    case 'Observation':
    case 'DiagnosticReport':
    case 'Condition':
    case 'MedicationRequest':
    case 'Procedure':
    case 'Immunization':
    case 'AllergyIntolerance':
      return referenceId((resource as { encounter?: Reference }).encounter, 'Encounter');
    default:
      return undefined;
  }
}

// Keeps one record per kind + title (+ day), dropping exact duplicates that arrive from several sources.
function dedupeRecords(records: TimelineRecord[]): TimelineRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.kind}|${normalize(record.title)}|${record.detail ?? ''}|${record.date ? toDayKey(record.date) : ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const RECORD_KIND_ORDER: RecordKind[] = [
  'condition',
  'vitals',
  'lab',
  'medication',
  'allergy',
  'immunization',
  'procedure',
  'observation',
  'document',
];

function sortRecords(records: TimelineRecord[]): TimelineRecord[] {
  return [...records].sort(
    (a, b) => RECORD_KIND_ORDER.indexOf(a.kind) - RECORD_KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title)
  );
}

function uniqueSources(sources: DataSource[]): DataSource[] {
  return [...new Set(sources)];
}

// ---- Visits ----------------------------------------------------------------------------------

function visitTitle(encounter: Encounter | undefined, appointment: Appointment | undefined): string {
  return (
    firstText(encounter?.type) ??
    conceptText(appointment?.appointmentType) ??
    firstText(appointment?.serviceType) ??
    (encounter?.class?.code ? ENCOUNTER_CLASS_TITLES[encounter.class.code] : undefined) ??
    'Visit'
  );
}

// Scores how informative an encounter is, to pick the best copy when merging duplicates.
function encounterScore(encounter: Encounter): number {
  let score = 0;
  if (encounter.appointment?.length) {
    score += 8;
  }
  if (firstText(encounter.type)) {
    score += 4;
  }
  if (encounter.status === 'finished' || encounter.status === 'in-progress') {
    score += 2;
  }
  if (encounter.participant?.length) {
    score += 1;
  }
  return score;
}

interface VisitDraft {
  start: Date;
  encounters: WithId<Encounter>[];
  appointment?: WithId<Appointment>;
}

function buildVisits(sources: TimelineSources): VisitDraft[] {
  const appointmentsById = new Map(sources.appointments.map((a) => [a.id, a]));
  const claimedAppointments = new Set<string>();
  // Duplicate copies of the same visit share a start minute; merge them.
  const drafts = new Map<string, VisitDraft>();

  for (const encounter of sources.encounters) {
    if (isEnteredInError(encounter)) {
      continue;
    }
    const start = parseDate(encounter.period?.start);
    if (!start) {
      continue;
    }
    const key = start.toISOString().slice(0, 16);
    const draft = drafts.get(key) ?? { start, encounters: [] };
    draft.encounters.push(encounter);
    const appointmentId = referenceId(encounter.appointment?.[0], 'Appointment');
    const appointment = appointmentId ? appointmentsById.get(appointmentId) : undefined;
    if (appointment && !draft.appointment) {
      draft.appointment = appointment;
      claimedAppointments.add(appointment.id);
    }
    drafts.set(key, draft);
  }

  for (const appointment of sources.appointments) {
    if (claimedAppointments.has(appointment.id) || isEnteredInError(appointment)) {
      continue;
    }
    const start = parseDate(appointment.start);
    if (!start) {
      continue;
    }
    const key = start.toISOString().slice(0, 16);
    const draft = drafts.get(key);
    if (draft && !draft.appointment) {
      draft.appointment = appointment;
    } else if (!draft) {
      drafts.set(key, { start, encounters: [], appointment });
    }
  }

  return [...drafts.values()];
}

function toVisitEvent(draft: VisitDraft, recordsByEncounter: Map<string, TimelineRecord[]>): VisitEvent {
  const encounters = [...draft.encounters].sort((a, b) => encounterScore(b) - encounterScore(a));
  const encounter = encounters[0];
  const appointment = draft.appointment;

  const provider =
    encounters
      .flatMap((e) => e.participant ?? [])
      .map((p) => p.individual?.display)
      .find(Boolean) ??
    appointment?.participant.find((p) => !p.actor?.reference?.startsWith('Patient/'))?.actor?.display;

  const location =
    encounters.map((e) => e.location?.[0]?.location?.display ?? e.serviceProvider?.display).find(Boolean) ??
    appointment?.participant.find((p) => p.actor?.reference?.startsWith('Location/'))?.actor?.display;

  const reason =
    encounters.map((e) => firstText(e.reasonCode)).find(Boolean) ??
    firstText(appointment?.reasonCode) ??
    appointment?.description;

  const conditionLabels: string[] = [];
  for (const e of encounters) {
    for (const diagnosis of e.diagnosis ?? []) {
      if (diagnosis.condition?.display) {
        conditionLabels.push(diagnosis.condition.display);
      }
    }
    for (const ref of e.reasonReference ?? []) {
      if (ref.display) {
        conditionLabels.push(ref.display);
      }
    }
  }

  const title = visitTitle(encounter, appointment);
  const encounterIds = encounters.map((e) => e.id);
  const records = sortRecords(dedupeRecords(encounterIds.flatMap((id) => recordsByEncounter.get(id) ?? [])));

  const id = encounter ? `visit-${encounter.id}` : `visit-${appointment?.id}`;
  return {
    type: 'visit',
    id,
    date: draft.start,
    dayKey: toDayKey(draft.start),
    sources: uniqueSources([...encounters.map(getDataSource), ...(appointment ? [getDataSource(appointment)] : [])]),
    encounter,
    appointment,
    encounterIds,
    title,
    status: appointment?.status ?? encounter?.status,
    provider,
    location,
    reason: reason && reason !== title ? reason : undefined,
    isEmergency: encounters.some((e) => e.class?.code === 'EMER'),
    conditionLabels: [...new Set(conditionLabels)],
    records,
  };
}

// ---- Timeline --------------------------------------------------------------------------------

/**
 * Builds the patient timeline from FHIR resources:
 * - Encounters and Appointments become visits, with duplicate copies (same start minute) merged.
 * - Records that reference a visit's Encounter are nested inside that visit.
 * - Dated conditions become their own events, deduplicated by name and day.
 * - Other dated records are collected into one "records" event per day.
 * - Undated conditions, medications and allergies become "ongoing care" items.
 * Entered-in-error resources are ignored.
 * @param sources - The patient's resources, grouped by type.
 * @returns The timeline events (newest first) and ongoing-care items.
 */
export function buildPatientTimeline(sources: TimelineSources): PatientTimeline {
  const drafts = buildVisits(sources);
  const visitEncounterIds = new Set(drafts.flatMap((d) => d.encounters.map((e) => e.id)));

  const recordsByEncounter = new Map<string, TimelineRecord[]>();
  const unlinked: TimelineRecord[] = [];
  const conditionRecords: TimelineRecord[] = [];

  const recordResources: WithId<Resource>[] = [
    ...sources.conditions,
    ...sources.observations,
    ...sources.diagnosticReports,
    ...sources.documents,
    ...sources.medicationRequests,
    ...sources.medicationStatements,
    ...sources.allergies,
    ...sources.immunizations,
    ...sources.procedures,
  ];

  for (const resource of recordResources) {
    if (isEnteredInError(resource)) {
      continue;
    }
    const record = toRecord(resource);
    if (!record) {
      continue;
    }
    const encounterId = linkedEncounterId(resource);
    if (encounterId && visitEncounterIds.has(encounterId)) {
      const list = recordsByEncounter.get(encounterId) ?? [];
      list.push(record);
      recordsByEncounter.set(encounterId, list);
    } else if (record.kind === 'condition') {
      conditionRecords.push(record);
    } else {
      unlinked.push(record);
    }
  }

  const events: TimelineEvent[] = drafts.map((draft) => toVisitEvent(draft, recordsByEncounter));
  const ongoing: OngoingItem[] = [];

  // Conditions: dated ones become events (deduplicated by name + day); undated ones are ongoing.
  const conditionEvents = new Map<string, ConditionEvent>();
  for (const record of conditionRecords) {
    const condition = record.resource as WithId<Condition>;
    if (!record.date) {
      ongoing.push({
        id: condition.id,
        kind: 'condition',
        title: record.title,
        detail: record.detail,
        resource: condition,
      });
      continue;
    }
    const key = `${normalize(record.title)}|${toDayKey(record.date)}`;
    const existing = conditionEvents.get(key);
    if (existing) {
      existing.copies++;
      existing.sources = uniqueSources([...existing.sources, record.source]);
      continue;
    }
    const code = condition.code?.coding?.find((coding) => coding.code)?.code;
    conditionEvents.set(key, {
      type: 'condition',
      id: `condition-${condition.id}`,
      date: record.date,
      dayKey: toDayKey(record.date),
      sources: [record.source],
      condition,
      title: record.title,
      // Clinical status is shown as its own badge, so the detail is just the code.
      detail: code,
      clinicalStatus: condition.clinicalStatus?.coding?.[0]?.code,
      copies: 1,
    });
  }
  events.push(...conditionEvents.values());

  // Other records: dated ones are grouped per day; undated ones are ongoing.
  const byDay = new Map<string, TimelineRecord[]>();
  for (const record of unlinked) {
    if (!record.date) {
      ongoing.push({
        id: record.resource.id,
        kind: record.kind,
        title: record.title,
        detail: record.detail,
        resource: record.resource,
      });
      continue;
    }
    const key = toDayKey(record.date);
    const list = byDay.get(key) ?? [];
    list.push(record);
    byDay.set(key, list);
  }
  for (const [dayKey, records] of byDay) {
    const [year, month, day] = dayKey.split('-').map(Number);
    const unique = sortRecords(dedupeRecords(records));
    events.push({
      type: 'records',
      id: `records-${dayKey}`,
      // Records cards sort to the end of their day.
      date: new Date(year, month - 1, day),
      dayKey,
      sources: uniqueSources(unique.map((r) => r.source)),
      records: unique,
    });
  }

  events.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { events, ongoing: dedupeOngoing(ongoing) };
}

function dedupeOngoing(items: OngoingItem[]): OngoingItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.kind}|${normalize(item.title)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) => RECORD_KIND_ORDER.indexOf(a.kind) - RECORD_KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title)
    );
}

// ---- Filtering and grouping ------------------------------------------------------------------

export interface TimelineFilters {
  query: string;
  kinds: TimelineEventKind[];
  providers: string[];
  sources: DataSource[];
  statuses: string[];
}

export const EMPTY_FILTERS: TimelineFilters = { query: '', kinds: [], providers: [], sources: [], statuses: [] };

/**
 * Whether any filter or search is active.
 * @param filters - The filters.
 * @returns True when something is narrowing the timeline.
 */
export function hasActiveFilters(filters: TimelineFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.kinds.length > 0 ||
    filters.providers.length > 0 ||
    filters.sources.length > 0 ||
    filters.statuses.length > 0
  );
}

function recordMatchesQuery(record: TimelineRecord, q: string): boolean {
  return [record.title, record.detail].some((value) => value?.toLowerCase().includes(q));
}

/**
 * Applies search and filters. Kind filters narrow a day's "records" card to the matching
 * records; provider and status filters apply to visits only; an empty selection means "all".
 * @param events - The timeline events.
 * @param filters - The active filters.
 * @returns The events that pass, with records cards trimmed to matching records.
 */
export function filterTimeline(events: TimelineEvent[], filters: TimelineFilters): TimelineEvent[] {
  const q = filters.query.trim().toLowerCase();
  const kinds = new Set(filters.kinds);
  const providers = new Set(filters.providers);
  const sourceSet = new Set(filters.sources);
  const statuses = new Set(filters.statuses);
  const result: TimelineEvent[] = [];

  for (const event of events) {
    if (sourceSet.size > 0 && !event.sources.some((s) => sourceSet.has(s))) {
      continue;
    }
    if (event.type === 'visit') {
      if (kinds.size > 0 && !kinds.has('visit')) {
        continue;
      }
      if (providers.size > 0 && (!event.provider || !providers.has(event.provider))) {
        continue;
      }
      if (statuses.size > 0 && (!event.status || !statuses.has(event.status))) {
        continue;
      }
      if (
        q &&
        ![event.title, event.provider, event.location, event.reason, ...event.conditionLabels].some((v) =>
          v?.toLowerCase().includes(q)
        ) &&
        !event.records.some((r) => recordMatchesQuery(r, q))
      ) {
        continue;
      }
      result.push(event);
    } else if (event.type === 'condition') {
      if (providers.size > 0 || statuses.size > 0) {
        continue;
      }
      if (kinds.size > 0 && !kinds.has('condition')) {
        continue;
      }
      if (q && ![event.title, event.detail].some((v) => v?.toLowerCase().includes(q))) {
        continue;
      }
      result.push(event);
    } else {
      if (providers.size > 0 || statuses.size > 0) {
        continue;
      }
      const records = event.records.filter(
        (r) =>
          (kinds.size === 0 || kinds.has(r.kind)) &&
          (sourceSet.size === 0 || sourceSet.has(r.source)) &&
          (!q || recordMatchesQuery(r, q))
      );
      if (records.length > 0) {
        result.push(records.length === event.records.length ? event : { ...event, records });
      }
    }
  }
  return result;
}

export interface DayGroup {
  dayKey: string;
  events: TimelineEvent[];
}

/**
 * Groups events (already newest first) into local days.
 * @param events - The events.
 * @returns One group per day, newest first.
 */
export function groupByDay(events: TimelineEvent[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last?.dayKey === event.dayKey) {
      last.events.push(event);
    } else {
      groups.push({ dayKey: event.dayKey, events: [event] });
    }
  }
  return groups;
}

export const UNCATEGORIZED_GROUP = 'Other / Uncategorized';

export interface ConditionGroup {
  name: string;
  events: TimelineEvent[];
}

/**
 * Groups events by condition: condition events under their own name, visits under the first
 * condition they were for, everything else under "Other / Uncategorized" (always last).
 * @param events - The events.
 * @returns The groups, largest first.
 */
export function groupByCondition(events: TimelineEvent[]): ConditionGroup[] {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    let name = UNCATEGORIZED_GROUP;
    if (event.type === 'condition') {
      name = event.title;
    } else if (event.type === 'visit') {
      name =
        event.conditionLabels[0] ?? event.records.find((r) => r.kind === 'condition')?.title ?? UNCATEGORIZED_GROUP;
    }
    const list = groups.get(name) ?? [];
    list.push(event);
    groups.set(name, list);
  }
  return [...groups.entries()]
    .map(([name, list]) => ({ name, events: list }))
    .sort((a, b) => {
      if (a.name === UNCATEGORIZED_GROUP) {
        return 1;
      }
      if (b.name === UNCATEGORIZED_GROUP) {
        return -1;
      }
      return b.events.length - a.events.length || a.name.localeCompare(b.name);
    });
}

/**
 * A relative label for a day header: "Today", "Yesterday", "Tomorrow", a weekday within the last
 * week, "Upcoming" for later days, or undefined when the date alone is clearer.
 * @param dayKey - The day, `YYYY-MM-DD`.
 * @param todayKey - Today, `YYYY-MM-DD`.
 * @returns The label, if any.
 */
export function getRelativeDayLabel(dayKey: string, todayKey: string): string | undefined {
  if (dayKey === todayKey) {
    return 'Today';
  }
  const toDate = (key: string): Date => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const diffDays = Math.round((toDate(dayKey).getTime() - toDate(todayKey).getTime()) / 86_400_000);
  if (diffDays === -1) {
    return 'Yesterday';
  }
  if (diffDays === 1) {
    return 'Tomorrow';
  }
  if (diffDays > 1) {
    return 'Upcoming';
  }
  if (diffDays >= -6) {
    return toDate(dayKey).toLocaleDateString(undefined, { weekday: 'long' });
  }
  return undefined;
}

/**
 * Counts events per kind for the type filter. Records cards count each record kind they contain.
 * @param events - The events.
 * @returns A count per kind.
 */
export function countByKind(events: TimelineEvent[]): Partial<Record<TimelineEventKind, number>> {
  const counts: Partial<Record<TimelineEventKind, number>> = {};
  const add = (kind: TimelineEventKind, n = 1): void => {
    counts[kind] = (counts[kind] ?? 0) + n;
  };
  for (const event of events) {
    if (event.type === 'visit') {
      add('visit');
    } else if (event.type === 'condition') {
      add('condition');
    } else {
      for (const record of event.records) {
        add(record.kind);
      }
    }
  }
  return counts;
}

/**
 * Link to a resource inside the patient chart.
 * @param patientId - The patient id.
 * @param resource - The resource.
 * @returns The provider-app path.
 */
export function chartPath(patientId: string, resource: WithId<Resource>): string {
  if (resource.resourceType === 'Encounter') {
    return `/Patient/${patientId}/Encounter/${resource.id}`;
  }
  return `/Patient/${patientId}/${getReferenceString(resource)}`;
}
