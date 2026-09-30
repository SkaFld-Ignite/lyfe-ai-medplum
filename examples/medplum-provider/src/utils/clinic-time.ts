// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { TimezoneExtensionURI, getExtensionValue } from '@medplum/core';
import type { Location } from '@medplum/fhirtypes';

/**
 * Dates and times belong to the clinic, not to whoever is looking at the screen.
 *
 * An appointment is at 9:30am *at the clinic*. It does not move because a
 * biller in New York or a developer in Karachi opens the calendar. Every
 * `toLocaleTimeString(undefined, …)` in a scheduling app is therefore a bug
 * waiting for its first out-of-town user, and the damage is not limited to a
 * shifted clock reading: the day a timestamp is filed under is also computed
 * from the viewer's zone, so from GMT+5 an afternoon Pacific clinic lands
 * entirely on the following day.
 *
 * This module is the single answer to "which zone?" for the whole UI, and it
 * deliberately mirrors the importer: `practiceZone()` in `bots/drchrono-import.ts`
 * resolves the same question on the way in, by the same majority rule and with
 * the same default. If those two ever disagree, times written by the importer
 * and times read by the UI describe different moments.
 *
 * The zone is carried on `Location` in the **standard HL7 extension**,
 * `http://hl7.org/fhir/StructureDefinition/timezone`, which `@medplum/core`
 * already exports as `TimezoneExtensionURI` and which its own scheduling code
 * reads through `getSchedulingTimezone`. No custom extension, no new resource
 * type, nothing for anyone to learn.
 */

/**
 * Fallback when no office declares a zone.
 *
 * Matches `DEFAULT_PRACTICE_TIME_ZONE` in the importer. A wrong-but-shared
 * default still renders a self-consistent calendar; two different defaults
 * would not.
 */
export const DEFAULT_CLINIC_TIME_ZONE = 'US/Pacific';

/**
 * Read the IANA zone declared on one office.
 * @param location - The office.
 * @returns The zone name, or undefined when the office does not declare one.
 */
export function getLocationTimeZone(location: Location): string | undefined {
  const value = getExtensionValue(location, TimezoneExtensionURI);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve the practice-wide zone from its offices, by majority.
 *
 * A practice can span zones, but a clinic-wide calendar has to pick one or the
 * columns stop lining up. Majority is the same rule the importer applies, and
 * for the pilot every office agrees anyway — the tie-break only matters for a
 * genuinely multi-zone practice, where the right long-term answer is a
 * per-office view rather than a cleverer vote.
 * @param locations - The clinic's offices.
 * @returns An IANA zone name; the default when nothing declares one.
 */
export function resolveClinicTimeZone(locations: readonly Location[]): string {
  const counts = new Map<string, number>();
  for (const location of locations) {
    const zone = getLocationTimeZone(location);
    if (zone) {
      counts.set(zone, (counts.get(zone) ?? 0) + 1);
    }
  }

  let best = DEFAULT_CLINIC_TIME_ZONE;
  let bestCount = 0;
  for (const [zone, count] of counts) {
    // Ties resolve to the first zone seen, which keeps the result stable across
    // renders for a given search order rather than flickering between equals.
    if (count > bestCount) {
      best = zone;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Break an instant into the clinic's calendar fields.
 *
 * `Intl` is the only thing in the platform that knows what the wall clock read
 * in a given zone at a given moment, DST included. Everything else here is
 * built on this one function so there is a single place that can be wrong.
 * @param date - The instant.
 * @param timeZone - IANA zone name.
 * @returns Year, month, day, hour and minute as they read in that zone.
 */
function partsIn(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some engines; normalise it.
  const hour = get('hour') % 24;
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

/**
 * The calendar day an instant falls on **at the clinic**, as `YYYY-MM-DD`.
 *
 * This is the grouping key for the calendar and the timeline. Deriving it from
 * the viewer's zone is what files an afternoon appointment under tomorrow.
 * @param date - The instant.
 * @param timeZone - IANA zone name.
 * @returns The clinic's calendar day.
 */
export function toClinicIsoDate(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Time of day as it reads at the clinic, e.g. "9:30 AM".
 * @param date - The instant.
 * @param timeZone - IANA zone name.
 * @returns The formatted time.
 */
export function formatClinicTime(date: Date, timeZone: string): string {
  return date.toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
}

/**
 * Full date as it reads at the clinic, e.g. "Tuesday, September 29, 2026".
 * @param date - The instant.
 * @param timeZone - IANA zone name.
 * @returns The formatted date.
 */
export function formatClinicLongDate(date: Date, timeZone: string): string {
  return date.toLocaleDateString(undefined, {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Short date as it reads at the clinic, e.g. "Sep 29, 2026".
 * @param date - The instant.
 * @param timeZone - IANA zone name.
 * @returns The formatted date.
 */
export function formatClinicShortDate(date: Date, timeZone: string): string {
  return date.toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Format a `YYYY-MM-DD` day key for display.
 *
 * Takes the key rather than an instant: the key already *is* a clinic calendar
 * day, so converting it back through an instant and a zone would reintroduce
 * exactly the round-trip this module exists to avoid. It is formatted as a
 * fixed point in UTC and read back in UTC, so no zone is involved at all.
 * @param dayKey - A `YYYY-MM-DD` clinic calendar day.
 * @param options - Any `Intl` date options; `timeZone` is supplied.
 * @returns The formatted day, or the key unchanged when it is malformed.
 */
export function formatDayKey(dayKey: string, options: Intl.DateTimeFormatOptions): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return dayKey;
  }
  // Noon rather than midnight so a formatter that rounds cannot fall into the
  // previous day.
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return at.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

/**
 * Weekday name for a day key, e.g. "Monday".
 * @param dayKey - A `YYYY-MM-DD` clinic calendar day.
 * @returns The weekday name.
 */
export function weekdayForDayKey(dayKey: string): string {
  return formatDayKey(dayKey, { weekday: 'long' });
}

/**
 * Full date for a day key, e.g. "Tuesday, September 29, 2026".
 * @param dayKey - A `YYYY-MM-DD` clinic calendar day.
 * @returns The formatted date.
 */
export function formatDayKeyLong(dayKey: string): string {
  return formatDayKey(dayKey, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * The instant at which a clinic calendar day begins.
 *
 * Used to bound a search: an appointment "on 14 September" means one that falls
 * on that day at the clinic, which is a different window of time for every
 * zone. Resolved by guessing from UTC and correcting by the zone's offset at
 * that guess — twice, because the offset can itself change across a DST
 * boundary within the day.
 * @param dayKey - A `YYYY-MM-DD` clinic calendar day.
 * @param timeZone - IANA zone name.
 * @returns The instant of local midnight, or undefined when the key is malformed.
 */
export function clinicDayStart(dayKey: string, timeZone: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const guess = new Date(Date.UTC(year, month - 1, day));
  const corrected = new Date(guess.getTime() - offsetMs(guess, timeZone));
  // One more pass: if the first correction crossed a DST boundary the offset we
  // applied was the wrong side of it.
  return new Date(guess.getTime() - offsetMs(corrected, timeZone));
}

/**
 * How far ahead of UTC a zone is at a given instant, in milliseconds.
 * @param instant - The moment to measure at.
 * @param timeZone - IANA zone name.
 * @returns Offset in milliseconds; negative for zones behind UTC.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const { year, month, day, hour, minute } = partsIn(instant, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Seconds and milliseconds are not in `partsIn`, so compare on whole minutes.
  const instantMinutes = Math.floor(instant.getTime() / 60_000) * 60_000;
  return asUtc - instantMinutes;
}

/**
 * Shift a clinic calendar day by whole days.
 *
 * Operates on the key rather than on an instant, so it cannot drift across a
 * DST boundary: "the next day" is a calendar question, not a 24-hour question.
 * @param dayKey - A `YYYY-MM-DD` clinic calendar day.
 * @param days - Days to add; may be negative.
 * @returns The shifted day key, or the key unchanged when it is malformed.
 */
export function addClinicDays(dayKey: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return dayKey;
  }
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Today's date at the clinic.
 * @param timeZone - IANA zone name.
 * @returns Today as a `YYYY-MM-DD` clinic calendar day.
 */
export function clinicToday(timeZone: string): string {
  return toClinicIsoDate(new Date(), timeZone);
}

/**
 * The calendar day a FHIR date-or-instant value falls on, at the clinic.
 *
 * FHIR distinguishes a `date` (`2026-03-01`, a calendar day with no time and
 * no zone) from an `instant` (`2026-03-01T09:00:00-08:00`, a moment). They
 * must be read differently: a moment has to be converted into the clinic's
 * zone, and a calendar day must **not** be, because it has no zone to convert
 * from. Parsing `2026-03-01` into a `Date` makes it UTC midnight, which is
 * 28 February on the American west coast — the same off-by-one that displayed
 * "04/01 labs" as "Mar 31" on the old platform.
 *
 * Taking the raw string rather than a parsed `Date` is what makes the
 * distinction visible at all; once it is a `Date`, the information is gone.
 * @param value - A FHIR `date`, `dateTime` or `instant`.
 * @param timeZone - The clinic's IANA zone.
 * @returns The `YYYY-MM-DD` day, or undefined when the value is absent or unparseable.
 */
export function fhirDayKey(value: string | undefined, timeZone: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : toClinicIsoDate(at, timeZone);
}

/**
 * The calendar day a `Date` already represents, as `YYYY-MM-DD`.
 *
 * For a `Date` that was **built from calendar parts** — `new Date(1987, 7, 17)`
 * — the day is whatever those parts said, and reading it back with the local
 * getters returns exactly that. What must not happen is a round-trip through
 * `toISOString()`: that reinterprets local midnight as an instant and renders
 * it in UTC, which west of UTC is the previous day. A C-CDA birth date of
 * `19870817` displayed as "8/16/1987" is that round-trip, not a parsing bug.
 * @param date - A date built from calendar parts.
 * @returns The `YYYY-MM-DD` day it represents.
 */
export function toCalendarDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
