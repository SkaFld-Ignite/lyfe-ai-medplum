// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { formatHumanName } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import { clinicToday } from '../../utils/clinic-time';

/** Identifier systems the roster knows how to label as an MRN. */
const MRN_SYSTEMS: { system: string; label: string }[] = [
  { system: 'https://drchrono.com/patients', label: 'DRCHRONO' },
  { system: 'https://zusapi.com/fhir/identifier/universal-id', label: 'ZUS' },
];

/**
 * The record number a clinician recognises. Prefers DrChrono, since that is the
 * system of record patients are imported from, and falls back to any identifier
 * the resource happens to carry.
 * @param patient - The patient to read an identifier from.
 * @returns A labelled MRN, or undefined when the patient carries no identifier.
 */
export function getMrn(patient: Patient): string | undefined {
  for (const { system, label } of MRN_SYSTEMS) {
    const match = patient.identifier?.find((i) => i.system === system)?.value;
    if (match) {
      return `${label}-${match}`;
    }
  }
  return patient.identifier?.find((i) => i.value)?.value;
}

export function getDisplayName(patient: Patient): string {
  const name = patient.name?.[0];
  return (name && formatHumanName(name)) || 'Unnamed patient';
}

export function getInitials(patient: Patient): string {
  const name = patient.name?.[0];
  const given = name?.given?.[0]?.[0] ?? '';
  const family = name?.family?.[0] ?? '';
  return (given + family).toUpperCase() || '?';
}

/**
 * US-style date, matching how the Lyfe roster renders a date of birth.
 * @param birthDate - An ISO date string, if the patient has one.
 * @returns The date as MM/DD/YYYY, or an em dash.
 */
export function formatDob(birthDate: string | undefined): string {
  if (!birthDate) {
    return '—';
  }
  const [y, m, d] = birthDate.split('-');
  return y && m && d ? `${m}/${d}/${y}` : birthDate;
}

/**
 * Whole years elapsed, accounting for whether this year's birthday has passed.
 *
 * A birth date is a **calendar date**, not an instant, and it is never parsed
 * into a `Date` here. `new Date('1987-01-01')` is midnight **UTC**, while
 * `getFullYear()` reads it back in **local** time, so west of UTC that date
 * becomes 31 December 1986 and everyone born on 1 January reads a year too
 * old — all year round, not just on their birthday. This is the same class of
 * bug as the "04/01 labs displayed as Mar 31" report on the old platform.
 *
 * The comparison runs on the parts of the string, so it gives the same answer
 * in every timezone.
 * @param birthDate - A `YYYY-MM-DD` date, if the patient has one.
 * @param timeZone - The clinic's IANA zone, which decides what "today" is.
 * @returns Whole years as a string, or an em dash.
 */
export function getAge(birthDate: string | undefined, timeZone: string): string {
  const born = birthDate ? /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate) : null;
  if (!born) {
    return '—';
  }
  const today = clinicToday(timeZone).split('-').map(Number);
  const [bornYear, bornMonth, bornDay] = [Number(born[1]), Number(born[2]), Number(born[3])];
  const [year, month, day] = today;

  let age = year - bornYear;
  if (month < bornMonth || (month === bornMonth && day < bornDay)) {
    age--;
  }
  return age >= 0 ? String(age) : '—';
}

// Avatar tints, picked deterministically from the name so a given patient keeps
// the same colour across renders and sessions.
const AVATAR_COLORS = ['blue', 'grape', 'violet', 'teal', 'cyan', 'indigo', 'pink'];

export function getAvatarColor(patient: Patient): string {
  const seed = getDisplayName(patient);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function getContact(patient: Patient): { email?: string; phone?: string } {
  return {
    email: patient.telecom?.find((t) => t.system === 'email')?.value,
    phone: patient.telecom?.find((t) => t.system === 'phone' || t.system === 'sms')?.value,
  };
}

/**
 * Translate an age range into FHIR `birthdate` bounds.
 *
 * FHIR has no age search parameter — age is derived from `birthDate` — so the
 * filter has to be expressed as a date window. Someone who is at least `minAge`
 * was born on or before today minus `minAge` years; someone who is at most
 * `maxAge` was born after today minus `maxAge + 1` years, because they have not
 * yet had the birthday that would age them out.
 * @param minAge - Youngest age to include, in whole years.
 * @param maxAge - Oldest age to include, in whole years.
 * @returns `ge` and `le` ISO dates for the `birthdate` parameter, either possibly absent.
 */
export function ageToBirthDateBounds(
  minAge: number | undefined,
  maxAge: number | undefined
): { ge?: string; le?: string } {
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const today = new Date();
  const bounds: { ge?: string; le?: string } = {};

  if (minAge !== undefined && Number.isFinite(minAge)) {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - minAge);
    bounds.le = iso(d);
  }

  if (maxAge !== undefined && Number.isFinite(maxAge)) {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - maxAge - 1);
    d.setDate(d.getDate() + 1);
    bounds.ge = iso(d);
  }

  return bounds;
}
