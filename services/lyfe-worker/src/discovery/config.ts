// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Basic } from '@medplum/fhirtypes';
import { getConfigValues, INTEGRATION_SYSTEM } from '../../../../examples/medplum-provider/bots/shared/credentials.ts';
import { DRCHRONO_PROVIDER } from '../../../../examples/medplum-provider/bots/shared/drchrono.ts';

/**
 * What the scheduled new-patient discovery pass is allowed to do, per clinic.
 *
 * All of it is read from the clinic's existing DrChrono credential record —
 * the same `Basic` the OAuth tokens and the webhook settings live on. No new
 * resource, no new profile, no migration. See `DISCOVERY_CONFIG_FIELDS` in
 * `bots/shared/credentials.ts` for the field declarations.
 *
 * ## The defaults, and why each one is what it is
 *
 * The horizon numbers are deliberately open questions, so every one of them is
 * a setting with a default chosen to be *safe when wrong* rather than to be
 * right. A default that errs toward importing fewer patients costs a person
 * one manual import; a default that errs the other way spends a practice's
 * DrChrono quota and creates charts nobody asked for.
 *
 * - **Off.** {@link isDiscoveryEnabled} returns true only for a stored `true`.
 *   Deploying this must change nothing for any clinic.
 * - **Eight days** ({@link DEFAULT_LOOKAHEAD_DAYS} is 7, meaning today plus a
 *   week). Imports are paced against DrChrono's hourly budget, so a busy day
 *   drains over hours; the window has to be wide enough that this is slack
 *   rather than a race, and wide enough for a Zus enrolment to have answered.
 * - **Five hundred patients** ({@link DEFAULT_MAX_PATIENTS}). A runaway guard,
 *   not a daily allowance — pacing belongs to the throttle, which queues
 *   instead of discarding. The old 25 was a cliff for any practice booking
 *   more than 25 a day, which is most of them.
 * - **No reason filter.** Every patient with an upcoming active appointment is
 *   onboarded. A clinic that wants to narrow it sets `discoveryReason`, but
 *   nothing is excluded by default — see {@link readDiscoveryConfig}.
 * - **US/Pacific** ({@link DEFAULT_TIME_ZONE}). Matches
 *   `DEFAULT_PRACTICE_TIME_ZONE` in the importer and `DEFAULT_CLINIC_TIME_ZONE`
 *   in the UI. A wrong-but-shared default still agrees with itself; two
 *   different defaults would mean the pass and the calendar disagree about
 *   which day it is.
 */

/**
 * Days past today the window reaches, when the clinic has not said.
 *
 * Seven, not one. The pass no longer races the appointment: chart imports are
 * throttled to DrChrono's hourly budget, so a hundred-patient day drains over
 * hours rather than minutes, and a one-day window would mean patients booked
 * for tomorrow arriving before their chart did. A week turns that race into
 * slack.
 *
 * It also gives Zus somewhere to be. Enrolment answers over hours to days — the
 * network pull legitimately returns empty at first, which is why the import
 * chain re-pulls on a 30m/2h/6h ladder — so finding a patient the day before
 * their visit systematically produces a thin outside record. A week out does
 * not.
 */
export const DEFAULT_LOOKAHEAD_DAYS = 7;

/**
 * The longest window a clinic may configure.
 *
 * Clamped rather than refused. A typo of `300` in a settings box should not
 * take a clinic's discovery offline with a validation error nobody is watching
 * for — but it absolutely must not scan ten months of appointments either. The
 * effective window is reported on the run's Task, so a clamp is visible rather
 * than silent.
 */
export const MAX_LOOKAHEAD_DAYS = 30;

/**
 * The most patients one pass may queue, when the clinic has not said.
 *
 * A runaway guard, not a daily allowance. It used to be 25, chosen to sit just
 * under the 33-patient day that exhausted DrChrono's quota — which made it a
 * cliff: a practice booking a hundred patients a day would have had three
 * quarters of its schedule truncated every morning, with the Task reporting
 * "75 left for the next pass" and the next pass covering a different day.
 *
 * Pacing is the throttle's job now (`DRCHRONO_IMPORTS_PER_HOUR`), which queues
 * rather than discards. So this exists only to stop something absurd — a
 * mis-set window, a duplicated calendar — turning into thousands of imports
 * before a person notices. 500 is far above any real day and far below a
 * runaway.
 */
export const DEFAULT_MAX_PATIENTS = 500;

/** Hard ceiling on {@link DiscoveryConfig.maxPatients}, whatever is configured. */
export const MAX_MAX_PATIENTS = 2000;

/**
 * There is deliberately no default reason phrase.
 *
 * A clinic may set one, and then it filters. Unset, every patient with an
 * upcoming active appointment is onboarded — which is the point: the chart has
 * to be there when the patient is in the room, and whether the booking staff
 * typed "new patient" is not a safe thing to hang that on.
 */

/** The zone "today" is read in, when the clinic has not said. */
export const DEFAULT_TIME_ZONE = 'US/Pacific';

/** One clinic's discovery settings, parsed and bounded. */
export interface DiscoveryConfig {
  /** The clinic. */
  readonly organizationId: string;
  /** Whether the pass may run at all. */
  readonly enabled: boolean;
  /** Days past today the window reaches. `0` is today only. */
  readonly lookaheadDays: number;
  /**
   * A free-text phrase an appointment's Reason must contain, when a clinic
   * wants one. Undefined — the default — means every appointment qualifies.
   */
  readonly reasonPhrase?: string;
  /** The profile the unattended run acts as, e.g. `Practitioner/abc`. */
  readonly requester?: string;
  /** The most patients this pass may queue. */
  readonly maxPatients: number;
  /** IANA zone "today" is read in. */
  readonly timeZone: string;
}

/**
 * Parse one clinic's settings off its credential record.
 *
 * Nothing here throws. A clinic with a nonsense number gets the default and a
 * run that still happens, because the alternative — an unattended job that
 * stops on a malformed setting and tells nobody — is the failure mode this
 * whole feature exists to avoid. The one value that is *not* defaulted into
 * existence is `enabled`.
 * @param props - Where to read from.
 * @param props.organizationId - The clinic.
 * @param props.record - Its DrChrono credential record, if it has one.
 * @returns The clinic's settings, bounded.
 */
export function readDiscoveryConfig(props: { organizationId: string; record: Basic | undefined }): DiscoveryConfig {
  const config = getConfigValues(props.record);
  // `webhookRequester` is the fallback because a clinic that has already named
  // a profile for unattended inbound work has answered the same question. It
  // is still re-resolved against this clinic before it is used — the stored
  // value is a lookup key, never a grant. See `requesterOrganizationProblem`.
  const requester = (config.discoveryRequester || config.webhookRequester || '').trim();
  const reasonPhrase = (config.discoveryReason || '').trim();
  return {
    organizationId: props.organizationId,
    enabled: isDiscoveryEnabled(config.discoveryEnabled),
    lookaheadDays: boundedInteger(config.discoveryLookaheadDays, DEFAULT_LOOKAHEAD_DAYS, 0, MAX_LOOKAHEAD_DAYS),
    // Unset means no reason filter: every patient with an upcoming active
    // appointment is onboarded, which is what this is for. The appointment's
    // free text is not a reliable gate anyway — it is whatever the booking
    // staff typed, and a patient whose chart is missing because somebody wrote
    // "n.p." is a worse outcome than importing a chart that was already there,
    // which is idempotent and costs one conditional update.
    //
    // Volume is bounded by the things that actually bound it — the Directory's
    // offices and providers, the cancelled/rescheduled exclusions, maxPatients
    // and the provider brake — not by hoping the Reason column is tidy.
    ...(reasonPhrase ? { reasonPhrase } : {}),
    ...(requester ? { requester } : {}),
    maxPatients: boundedInteger(config.discoveryMaxPatients, DEFAULT_MAX_PATIENTS, 1, MAX_MAX_PATIENTS),
    timeZone: (config.discoveryTimeZone || '').trim() || DEFAULT_TIME_ZONE,
  };
}

/**
 * Whether a stored value switches discovery on.
 *
 * Only an explicit, case-insensitive `true`. Absent is off, `""` is off,
 * `"yes"` is off, and a record that merely exists is off. An unattended job
 * that creates patient records has to be opted into in so many words, and
 * every other reading of an ambiguous value starts importing somebody's chart.
 * @param raw - The stored `discoveryEnabled` value, if any.
 * @returns True only for a stored "true".
 */
export function isDiscoveryEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * Read a configured integer, falling back and clamping rather than failing.
 * @param raw - The stored value, if any.
 * @param fallback - What to use when it is absent or not a number.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The bounded value.
 */
function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = (raw ?? '').trim();
  const parsed = trimmed ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** The dates one pass covers, as DrChrono and the preview exchange them. */
export interface DiscoveryWindow {
  /** First appointment date, YYYY-MM-DD. */
  readonly start: string;
  /** Last appointment date, YYYY-MM-DD, inclusive. */
  readonly end: string;
}

/**
 * The window a pass covers, read in the clinic's own zone.
 *
 * "Today" is not a property of the worker. A pass firing at 08:00 UTC is the
 * previous evening in Anaheim, so a UTC `new Date().toISOString().slice(0,10)`
 * would scan tomorrow's calendar and silently skip the day it was meant to
 * cover. The zone is therefore the clinic's, and the arithmetic is done on the
 * calendar date rather than on an instant so a daylight-saving boundary inside
 * the window cannot move it.
 * @param props - Inputs.
 * @param props.now - The instant the pass is running at.
 * @param props.timeZone - The clinic's IANA zone.
 * @param props.lookaheadDays - Days past today the window reaches.
 * @returns The inclusive date range to scan.
 */
export function discoveryWindow(props: { now: Date; timeZone: string; lookaheadDays: number }): DiscoveryWindow {
  const start = localDate(props.now, props.timeZone);
  const end = addDays(start, Math.max(0, props.lookaheadDays));
  return { start, end };
}

/**
 * The calendar date an instant falls on, in a given zone.
 *
 * `en-CA` because its short date format is already YYYY-MM-DD; formatting to
 * parts and reassembling them would be the same thing with more to get wrong.
 * An unknown zone name makes `Intl` throw, and one clinic's typo must not take
 * out every clinic's pass, so it falls back to the shared default.
 * @param instant - The moment to read.
 * @param timeZone - An IANA zone name.
 * @returns The date as YYYY-MM-DD.
 */
export function localDate(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(instant);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, dateStyle: 'short' }).format(instant);
  }
}

/**
 * Add whole days to a calendar date.
 * @param date - YYYY-MM-DD.
 * @param days - Days to add.
 * @returns YYYY-MM-DD.
 */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Every clinic that has switched the discovery pass on.
 *
 * One search over the DrChrono credential records, reading only the plaintext
 * config bucket — no secret is decrypted to answer "is this on", and a clinic
 * whose encryption key has rotated is still correctly reported as enabled or
 * not rather than vanishing from the list.
 *
 * A record with no `subject` is skipped rather than guessed at. That field is
 * the lookup key for the whole credential system, and a record without one
 * cannot be attributed to a clinic, so acting on it would mean choosing a
 * tenant at random — the exact failure `credentials.ts` opens with.
 * @param medplum - The worker's own Medplum client.
 * @returns The settings of every enabled clinic.
 */
export async function listDiscoveryConfigs(medplum: MedplumClient): Promise<DiscoveryConfig[]> {
  const records = await medplum.searchResources(
    'Basic',
    `identifier=${encodeURIComponent(INTEGRATION_SYSTEM)}|${DRCHRONO_PROVIDER}&_count=200`
  );

  const found: DiscoveryConfig[] = [];
  for (const record of records) {
    const reference = record.subject?.reference;
    if (!reference?.startsWith('Organization/')) {
      continue;
    }
    const config = readDiscoveryConfig({ organizationId: reference.slice('Organization/'.length), record });
    if (config.enabled) {
      found.push(config);
    }
  }
  return found;
}
