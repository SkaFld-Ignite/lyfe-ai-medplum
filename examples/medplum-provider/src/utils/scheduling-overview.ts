// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MantineColor } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { formatCodeableConcept, formatHumanName, getReferenceString, isResource } from '@medplum/core';
import type { Appointment, Bundle, Location, Patient, Practitioner, Reference, Resource } from '@medplum/fhirtypes';
import { formatClinicLongDate, formatClinicTime, toClinicIsoDate } from './clinic-time';

/** Provider grouping key used when an appointment has no Practitioner participant. */
export const UNASSIGNED_PROVIDER_KEY = 'unassigned';

/** Minimal patient summary shown on the scheduling overview. */
export interface OverviewPatient {
  reference: string;
  id: string;
  name: string;
  mrn?: string;
  email?: string;
  phone?: string;
  primaryProvider?: string;
}

/** An appointment flattened with everything the overview needs to render it. */
export interface OverviewAppointment {
  appointment: WithId<Appointment>;
  start: Date;
  end: Date;
  durationMinutes: number;
  patient?: OverviewPatient;
  providerKey: string;
  providerName: string;
  locationKey?: string;
  locationName?: string;
  typeLabel: string;
  isVirtual: boolean;
  reason?: string;
  notes?: string;
}

export interface FilterOption {
  key: string;
  label: string;
}

export interface StatusDisplay {
  label: string;
  color: MantineColor;
}

const STATUS_DISPLAY: Record<Appointment['status'], StatusDisplay> = {
  proposed: { label: 'Proposed', color: 'yellow' },
  pending: { label: 'Pending', color: 'yellow' },
  booked: { label: 'Scheduled', color: 'blue' },
  arrived: { label: 'Arrived', color: 'violet' },
  'checked-in': { label: 'Checked in', color: 'violet' },
  fulfilled: { label: 'Completed', color: 'gray' },
  cancelled: { label: 'Cancelled', color: 'red' },
  noshow: { label: 'No show', color: 'orange' },
  'entered-in-error': { label: 'Entered in error', color: 'gray' },
  waitlist: { label: 'Waitlist', color: 'cyan' },
};

/**
 * Display label and color for an appointment status.
 * @param status - The FHIR Appointment status.
 * @returns The label and Mantine color to show.
 */
export function getStatusDisplay(status: Appointment['status']): StatusDisplay {
  return STATUS_DISPLAY[status] ?? { label: status, color: 'gray' };
}

/**
 * Whether a status no longer occupies the schedule (cancelled or entered in error).
 * @param status - The FHIR Appointment status.
 * @returns True when the appointment is inactive.
 */
export function isInactiveStatus(status: Appointment['status']): boolean {
  return status === 'cancelled' || status === 'entered-in-error';
}

/**
 * Mantine palette used for provider colors. Kept separate from the calendar's own fallback
 * palette so a provider keeps the same color regardless of which providers are visible.
 */
export const PROVIDER_COLORS: MantineColor[] = [
  'blue',
  'teal',
  'grape',
  'orange',
  'indigo',
  'pink',
  'cyan',
  'lime',
  'violet',
  'red',
];

/**
 * Deterministically picks a color for a key, so a provider has a stable color across renders,
 * filters and page loads.
 * @param key - Any stable identifier, e.g. a Practitioner reference string.
 * @returns A Mantine color name.
 */
export function getColorForKey(key: string): MantineColor {
  if (key === UNASSIGNED_PROVIDER_KEY) {
    return 'gray';
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PROVIDER_COLORS[Math.abs(hash) % PROVIDER_COLORS.length];
}

/**
 * Up to two initials for an avatar, e.g. "Homer Simpson" becomes "HS".
 * @param name - A display name.
 * @returns The initials.
 */
export function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/**
 * The clinic calendar day an appointment starts on, as `YYYY-MM-DD`.
 *
 * Day grouping and the `?day=` URL parameter both run on this. It has to be
 * the clinic's own calendar day rather than the viewer's: from GMT+5 an
 * afternoon Pacific appointment falls on the following local day, which files
 * most of a clinic's afternoon under tomorrow. See `utils/clinic-time.ts`.
 * @param date - The instant.
 * @param timeZone - The clinic's IANA zone.
 * @returns The clinic's calendar day.
 */
export function toDayKey(date: Date, timeZone: string): string {
  return toClinicIsoDate(date, timeZone);
}

/**
 * Validate a `YYYY-MM-DD` day key arriving from the URL.
 *
 * Returns the key itself rather than a `Date`, because a calendar day is not an
 * instant and turning one into the other is what this whole change removes.
 * @param value - The raw parameter value.
 * @returns The key, or undefined when it is absent or not a real calendar day.
 */
export function parseDayKey(value: string | null | undefined): string | undefined {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  return real ? (value ?? undefined) : undefined;
}

/**
 * Time of day as it reads at the clinic, e.g. "9:30 AM".
 * @param date - The instant.
 * @param timeZone - The clinic's IANA zone.
 * @returns The formatted time.
 */
export function formatTime(date: Date, timeZone: string): string {
  return formatClinicTime(date, timeZone);
}

/**
 * Full date as it reads at the clinic, e.g. "Tuesday, September 29, 2026".
 * @param date - The instant.
 * @param timeZone - The clinic's IANA zone.
 * @returns The formatted date.
 */
export function formatLongDate(date: Date, timeZone: string): string {
  return formatClinicLongDate(date, timeZone);
}

function findParticipant<T extends Resource>(
  appointment: Appointment,
  resourceType: T['resourceType']
): Reference<T> | undefined {
  return appointment.participant.find((p) => p.actor?.reference?.startsWith(`${resourceType}/`))?.actor as
    Reference<T> | undefined;
}

/**
 * Resolves who is seeing the patient. Prefers a Practitioner participant; otherwise falls back to
 * a participant that only has a display name (e.g. DrChrono imports record "DrChrono Practice"
 * with no reference), so those appointments are grouped by name instead of as "unassigned".
 * @param appointment - The appointment.
 * @returns The provider grouping key and optional reference, or undefined when there is none.
 */
function findProvider(appointment: Appointment): { key: string; reference?: Reference<Practitioner> } | undefined {
  const practitioner = findParticipant<Practitioner>(appointment, 'Practitioner');
  if (practitioner?.reference) {
    return { key: practitioner.reference, reference: practitioner };
  }
  const displayOnly = appointment.participant.find((p) => !p.actor?.reference && p.actor?.display)?.actor;
  if (displayOnly?.display) {
    return { key: `display:${displayOnly.display}`, reference: displayOnly as Reference<Practitioner> };
  }
  return undefined;
}

/**
 * The appointment's end: `end` when present, otherwise `start + minutesDuration`.
 * @param appointment - The appointment.
 * @param start - The parsed start time.
 * @returns The end time, or undefined when it cannot be determined.
 */
function resolveEnd(appointment: Appointment, start: Date): Date | undefined {
  if (appointment.end) {
    return new Date(appointment.end);
  }
  if (appointment.minutesDuration) {
    return new Date(start.getTime() + appointment.minutesDuration * 60_000);
  }
  return undefined;
}

function findTelecom(patient: Patient, system: 'email' | 'phone'): string | undefined {
  return patient.telecom?.find((t) => t.system === system && t.value)?.value;
}

function findMrn(patient: Patient): string | undefined {
  const mrn = patient.identifier?.find((identifier) => identifier.type?.coding?.some((coding) => coding.code === 'MR'));
  return mrn?.value ?? patient.identifier?.[0]?.value;
}

function toOverviewPatient(reference: Reference<Patient>, resource: Patient | undefined): OverviewPatient | undefined {
  const refString = reference.reference;
  if (!refString) {
    return undefined;
  }
  const id = refString.split('/')[1];
  if (!resource) {
    return { reference: refString, id, name: reference.display ?? 'Unknown patient' };
  }
  return {
    reference: refString,
    id,
    name: formatHumanName(resource.name?.[0]) || reference.display || 'Unknown patient',
    mrn: findMrn(resource),
    email: findTelecom(resource, 'email'),
    phone: findTelecom(resource, 'phone'),
    primaryProvider: resource.generalPractitioner?.[0]?.display,
  };
}

function describeType(appointment: Appointment): { label: string; isVirtual: boolean } {
  const concepts = [appointment.appointmentType, ...(appointment.serviceType ?? [])].filter(Boolean);
  const label = concepts.map((c) => formatCodeableConcept(c)).find((text) => text.length > 0) ?? 'Appointment';
  const isVirtual = concepts.some(
    (c) =>
      /telehealth|virtual|video/i.test(formatCodeableConcept(c)) ||
      c?.coding?.some((coding) => coding.code === 'VR' || coding.code === 'virtual')
  );
  return { label, isVirtual };
}

/**
 * Converts an Appointment search bundle (with `_include`d Patient, Practitioner and Location
 * resources) into flat rows for the overview. Appointments without a start, or without an end
 * or `minutesDuration`, are skipped because they cannot be placed on the calendar.
 * @param bundle - The searchset bundle.
 * @returns The appointments, sorted by start time.
 */
export function buildOverviewAppointments(bundle: Bundle): OverviewAppointment[] {
  const included = new Map<string, Resource>();
  const appointments: WithId<Appointment>[] = [];

  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (!isResource(resource) || !resource.id) {
      continue;
    }
    if (resource.resourceType === 'Appointment' && entry.search?.mode !== 'include') {
      appointments.push(resource as WithId<Appointment>);
    } else {
      included.set(getReferenceString(resource as WithId<Resource>), resource);
    }
  }

  const rows: OverviewAppointment[] = [];
  for (const appointment of appointments) {
    if (!appointment.start) {
      continue;
    }
    const start = new Date(appointment.start);
    const end = resolveEnd(appointment, start);
    if (!end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      continue;
    }

    const patientRef = findParticipant<Patient>(appointment, 'Patient');
    const provider = findProvider(appointment);
    const providerRef = provider?.reference;
    const locationRef = findParticipant<Location>(appointment, 'Location');

    const practitioner = providerRef?.reference
      ? (included.get(providerRef.reference) as Practitioner | undefined)
      : undefined;
    const location = locationRef?.reference ? (included.get(locationRef.reference) as Location | undefined) : undefined;
    const { label, isVirtual } = describeType(appointment);

    rows.push({
      appointment,
      start,
      end,
      durationMinutes: Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000)),
      patient: patientRef
        ? toOverviewPatient(
            patientRef,
            patientRef.reference ? (included.get(patientRef.reference) as Patient | undefined) : undefined
          )
        : undefined,
      providerKey: provider?.key ?? UNASSIGNED_PROVIDER_KEY,
      providerName:
        (practitioner && formatHumanName(practitioner.name?.[0])) || providerRef?.display || 'Unassigned provider',
      locationKey: locationRef?.reference,
      locationName: location?.name ?? locationRef?.display,
      typeLabel: label,
      isVirtual,
      reason:
        appointment.reasonCode?.map((c) => formatCodeableConcept(c)).find((text) => text.length > 0) ??
        appointment.description,
      notes: appointment.comment ?? appointment.patientInstruction,
    });
  }

  return rows.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Unique providers present in the rows, sorted by name with "unassigned" last.
 * @param rows - The appointments.
 * @returns The provider filter options.
 */
export function getProviderOptions(rows: OverviewAppointment[]): FilterOption[] {
  const options = new Map<string, string>();
  for (const row of rows) {
    options.set(row.providerKey, row.providerName);
  }
  return [...options.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => {
      if (a.key === UNASSIGNED_PROVIDER_KEY) {
        return 1;
      }
      if (b.key === UNASSIGNED_PROVIDER_KEY) {
        return -1;
      }
      return a.label.localeCompare(b.label);
    });
}

/**
 * Unique locations present in the rows, sorted by name.
 * @param rows - The appointments.
 * @returns The location filter options.
 */
export function getLocationOptions(rows: OverviewAppointment[]): FilterOption[] {
  const options = new Map<string, string>();
  for (const row of rows) {
    if (row.locationKey) {
      options.set(row.locationKey, row.locationName ?? 'Unnamed location');
    }
  }
  return [...options.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export interface OverviewFilters {
  providers: string[];
  locations: string[];
  showCancelled: boolean;
}

/**
 * Applies the page filters. An empty provider/location selection means "all".
 * @param rows - The appointments to filter.
 * @param filters - The active filters.
 * @returns The rows that pass every filter.
 */
export function filterOverviewAppointments(
  rows: OverviewAppointment[],
  filters: OverviewFilters
): OverviewAppointment[] {
  const providers = new Set(filters.providers);
  const locations = new Set(filters.locations);
  return rows.filter((row) => {
    if (!filters.showCancelled && isInactiveStatus(row.appointment.status)) {
      return false;
    }
    if (providers.size > 0 && !providers.has(row.providerKey)) {
      return false;
    }
    if (locations.size > 0 && (!row.locationKey || !locations.has(row.locationKey))) {
      return false;
    }
    return true;
  });
}

/**
 * Rows that start on the given clinic calendar day, in start-time order.
 * @param rows - The appointments.
 * @param dayKey - The clinic calendar day, as `YYYY-MM-DD`.
 * @param timeZone - The clinic's IANA zone.
 * @returns The appointments on that day.
 */
export function getAppointmentsForDay(
  rows: OverviewAppointment[],
  dayKey: string,
  timeZone: string
): OverviewAppointment[] {
  return rows
    .filter((row) => toClinicIsoDate(row.start, timeZone) === dayKey)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Case-insensitive search across patient name, MRN, reason and appointment type.
 * @param rows - The appointments.
 * @param query - The search text; blank returns every row.
 * @returns The matching appointments.
 */
export function searchAppointments(rows: OverviewAppointment[], query: string): OverviewAppointment[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter((row) =>
    [row.patient?.name, row.patient?.mrn, row.reason, row.typeLabel].some((value) => value?.toLowerCase().includes(q))
  );
}

export interface ProviderGroup {
  providerKey: string;
  providerName: string;
  color: MantineColor;
  appointments: OverviewAppointment[];
}

/**
 * Groups rows by provider, sorted by provider name with "unassigned" last.
 * @param rows - The appointments.
 * @returns One group per provider.
 */
export function groupByProvider(rows: OverviewAppointment[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const row of rows) {
    let group = groups.get(row.providerKey);
    if (!group) {
      group = {
        providerKey: row.providerKey,
        providerName: row.providerName,
        color: getColorForKey(row.providerKey),
        appointments: [],
      };
      groups.set(row.providerKey, group);
    }
    group.appointments.push(row);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.providerKey === UNASSIGNED_PROVIDER_KEY) {
      return 1;
    }
    if (b.providerKey === UNASSIGNED_PROVIDER_KEY) {
      return -1;
    }
    return a.providerName.localeCompare(b.providerName);
  });
}

/**
 * Number of distinct patients across the rows.
 * @param rows - The appointments.
 * @returns The patient count.
 */
export function countPatients(rows: OverviewAppointment[]): number {
  return new Set(rows.map((row) => row.patient?.reference).filter(Boolean)).size;
}
