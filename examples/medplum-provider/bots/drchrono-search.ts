// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotEvent, MedplumClient } from '@medplum/core';
import { ENCRYPTION_KEY_SECRET_NAME, deriveEncryptionKey } from './shared/credentials.ts';
import { readDisabledDirectoryIds } from './shared/directory.ts';
import { createDrChronoClient } from './shared/drchrono.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';

/**
 * Read-only DrChrono lookups for the Lyfe onboarding flow.
 *
 * This runs server-side because the DrChrono token must never reach client JS,
 * and DrChrono sends no CORS headers for a browser origin. It deliberately only
 * reads — from DrChrono, and from the clinic's own directory in Medplum to
 * learn which offices and providers are switched off — so it is safe to call
 * on every keystroke.
 *
 * Credentials are per clinic, read from that Organization's credential record
 * rather than from a project-wide secret. A project secret would be one set of
 * DrChrono credentials for every tenant on the server, which is exactly the
 * single-tenancy this rewrite exists to remove. The only project secret used
 * here is the key that decrypts them.
 *
 * Token refresh is handled by the client: DrChrono access tokens last about
 * 48 hours and the refresh token rotates on every use, so the rotated pair is
 * persisted back to the clinic's record. See shared/drchrono.ts.
 */

interface SearchInput {
  action: 'search';
  query: string;
}

interface PreviewInput {
  action: 'preview';
  start: string;
  end?: string;
  /**
   * Keep only appointments whose free-text `reason` contains this phrase.
   *
   * Optional, and absent means "every appointment", which is what the manual
   * onboarding screen wants: a person reading the day's list is doing the
   * filtering themselves and a hidden one would make the count wrong.
   *
   * The scheduled discovery pass supplies it from the clinic's own stored
   * configuration, because the phrase is a clinic's habit and not a fact about
   * DrChrono. This practice writes "new patient" in the Reason field; another
   * writes "NP". A constant here would mean the second clinic needs a release.
   */
  reason?: string;
}

type Input = SearchInput | PreviewInput;

interface PatientSummary {
  id: number;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  chartId?: string;
  email?: string;
  cellPhone?: string;
  appointments?: number;
}

interface DrChronoPatient {
  id: number;
  first_name?: string;
  last_name?: string;
  date_of_birth?: string;
  gender?: string;
  chart_id?: string;
  email?: string;
  cell_phone?: string;
}

interface DrChronoAppointment {
  patient?: number;
  status?: string;
  /** DrChrono office id. Present on every appointment. */
  office?: number;
  /** DrChrono provider id. Present on every appointment. */
  doctor?: number;
  /**
   * The free-text Reason the front desk types when booking.
   *
   * This is the field the manual routine reads to decide whether a visit is a
   * new patient. It only arrives because the request below asks for
   * `verbose=true` — the compact appointment payload omits it — and it was
   * already on the wire and simply unread before the filter existed.
   */
  reason?: string;
}

/** A calendar date, as both DrChrono and the UI exchange them. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Appointments that never happened should not pull a chart in. */
const SKIP_STATUSES = new Set(['Cancelled', 'Rescheduled', 'No Show']);

/** DrChrono rejects a date_range over 190 days unless the whole range is past. */
const CHUNK_DAYS = 180;
const DAY_MS = 86400000;

/**
 * Entry point.
 * @param medplum - The Medplum client, unused: this bot only reads DrChrono.
 * @param event - Carries the action and its arguments, plus project secrets.
 * @returns Matching patients, shaped for the onboarding UI.
 */
export async function handler(medplum: MedplumClient, event: BotEvent<Input>): Promise<unknown> {
  // Errors are returned, not thrown. An uncaught throw surfaces to the caller as
  // a bare 500 "Internal Server Error", which hides the one thing worth knowing —
  // most failures here are configuration ("not scoped to an organization",
  // "DrChrono is not configured"), and a 500 sends people debugging the server.
  try {
    return await run(medplum, event);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The actual work, wrapped by `handler` so failures come back as messages.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - Carries the action, its arguments and project secrets.
 * @returns Matching patients, shaped for the onboarding UI.
 */
async function run(medplum: MedplumClient, event: BotEvent<Input>): Promise<unknown> {
  // Validate the request before doing any work on it. Everything below this
  // reads the clinic's encrypted credentials and builds a DrChrono client, and
  // none of that should happen for a request that was never answerable.
  if (event.input?.action === 'preview') {
    validatePreviewRange(event.input);
  }

  const material = event.secrets[ENCRYPTION_KEY_SECRET_NAME]?.valueString;
  if (!material) {
    throw new Error(`${ENCRYPTION_KEY_SECRET_NAME} is not set in project secrets`);
  }

  const organization = await resolveCallerOrganization({ medplum, requester: event.requester });
  const client = await createDrChronoClient({
    medplum,
    organization,
    key: deriveEncryptionKey({ material }),
  });
  const get = client.fetch;

  const input = event.input;

  if (input.action === 'search') {
    return { results: await searchPatients(get, input.query) };
  }

  if (input.action === 'preview') {
    const { start, end } = validatePreviewRange(input);

    // Offices and providers the clinic has switched off contribute nothing:
    // not a greyed-out row, not a count, nothing. That is the whole point of
    // the toggle, so the filter belongs here at the pull rather than in the UI
    // where a later caller could skip it.
    const disabled = await readDisabledDirectoryIds(medplum, organization);
    return previewAppointments(get, start, end, disabled, input.reason);
  }

  throw new Error(`Unknown action: ${JSON.stringify((input as { action?: string }).action)}`);
}

/**
 * Check a preview request's dates, and normalise a missing end to the start.
 *
 * An end date before the start is not an empty result, it is an impossible
 * question. The chunk loop runs `from = start; from <= end`, so an inverted
 * range never iterates and the caller gets a confident "0 appointments"
 * indistinguishable from a genuinely empty day. A wrong answer delivered
 * calmly is worse than an error.
 *
 * The UI blocks this too, but the UI is not the only way in here, and a guard
 * that only exists in the client is not a guard.
 * @param input - The preview request.
 * @returns The validated start and end dates.
 */
function validatePreviewRange(input: PreviewInput): { start: string; end: string } {
  const start = (input.start ?? '').trim();
  const end = (input.end ?? '').trim() || start;
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
    throw new Error(`Dates must be YYYY-MM-DD; received start="${start}" end="${end}"`);
  }
  if (end < start) {
    throw new Error(`End date ${end} is before start date ${start}, so no appointment could fall in that range`);
  }
  return { start, end };
}

/**
 * DrChrono has no free-text patient endpoint, so fan the term across the fields
 * a receptionist would type and merge by patient id.
 *
 * **A field query that fails stops the search.** It used to `continue`, which
 * made a refusal indistinguishable from an empty result: under throttling all
 * three queries 429, the function returned `[]`, and the onboarding page said
 * "no matches" about a patient who was sitting right there. Someone searching a
 * date of birth concludes the patient is not in DrChrono and stops looking —
 * and a bulk import can exhaust the practice's quota for twenty minutes, which
 * is exactly when a person would be onboarding by hand.
 *
 * This is the failure that CLAUDE.md records for Algolia, in a smaller place: a
 * search that reports empty on failure teaches people the data is not there.
 *
 * Partial results are refused for the same reason. If `last_name` answers and
 * `chart_id` is throttled, what comes back is an unknown fraction of the
 * matches, and showing it as the whole answer is the same lie in quieter form.
 * @param get - Authenticated fetch helper.
 * @param query - The search text.
 * @returns Distinct matching patients.
 */
export async function searchPatients(
  get: (path: string) => Promise<Response>,
  query: string
): Promise<PatientSummary[]> {
  const trimmed = (query ?? '').trim();
  if (trimmed.length < 2) {
    return [];
  }

  const merged = new Map<number, DrChronoPatient>();
  for (const field of ['last_name', 'first_name', 'chart_id']) {
    const res = await get(`/patients?${field}=${encodeURIComponent(trimmed)}`);
    if (!res.ok) {
      // Same shape as previewAppointments, so both actions report a refusal the
      // same way. The body carries DrChrono's own wait hint on a 429
      // ("Expected available in N seconds"), which is the most useful thing
      // anyone can be told here, so it is kept rather than summarised away.
      throw new Error(`DrChrono patient search by ${field} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { results?: DrChronoPatient[] };
    for (const p of body.results ?? []) {
      merged.set(p.id, p);
    }
  }
  return [...merged.values()].map(toSummary);
}

/**
 * Every distinct patient with a real appointment in a date range.
 * @param get - Authenticated fetch helper.
 * @param start - First appointment date, YYYY-MM-DD.
 * @param end - Last appointment date, YYYY-MM-DD.
 * @param disabled - Directory ids whose appointments must be skipped.
 * @param disabled.offices - Switched-off DrChrono office ids.
 * @param disabled.doctors - Switched-off DrChrono provider ids.
 * @param reasonPhrase - Keep only appointments whose reason contains this. Optional.
 * @returns The candidates and how many appointments were examined.
 */
export async function previewAppointments(
  get: (path: string) => Promise<Response>,
  start: string,
  end: string,
  disabled: { offices: Set<string>; doctors: Set<string> },
  reasonPhrase?: string
): Promise<{
  scannedAppointments: number;
  results: PatientSummary[];
  skippedByDirectory: number;
  excludedByStatus: number;
  excludedByReason: number;
}> {
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  const counts = new Map<number, number>();
  let scanned = 0;
  let skippedByDirectory = 0;
  // Counted separately so the caller can explain the gap between appointments
  // and patients found rather than leaving the reader to guess whether
  // somebody was booked twice.
  let excludedByStatus = 0;
  // Counted last, and separately, for the same reason. An unattended run has
  // nobody watching it, so "scanned 171, queued 4" has to be explainable from
  // the record alone or the only available reading is that it is broken.
  let excludedByReason = 0;

  for (let from = startDate; from <= endDate; from = new Date(from.getTime() + CHUNK_DAYS * DAY_MS)) {
    const to = new Date(Math.min(from.getTime() + (CHUNK_DAYS - 1) * DAY_MS, endDate.getTime()));
    let next: string | null = `/appointments?date_range=${iso(from)}/${iso(to)}&verbose=true`;

    while (next) {
      const res: Response = await get(next);
      if (!res.ok) {
        throw new Error(`DrChrono appointments ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as { results?: DrChronoAppointment[]; next?: string | null };
      for (const appt of body.results ?? []) {
        // Blocked time, breaks and admin holds occupy a slot with no patient
        // on it. They are not appointments and are dropped before anything is
        // counted: including them made a day look like it held 171
        // appointments when it held 145, and invited the reader to wonder
        // which patients had gone missing.
        if (typeof appt.patient !== 'number') {
          continue;
        }
        scanned++;
        if (SKIP_STATUSES.has(appt.status ?? '')) {
          excludedByStatus++;
          continue;
        }
        // An id we have never seen is allowed through: it belongs to an office
        // or provider added upstream since the last directory sync, which
        // nobody has switched off. Only an explicit disable filters.
        if (isDisabled(appt.office, disabled.offices) || isDisabled(appt.doctor, disabled.doctors)) {
          skippedByDirectory++;
          continue;
        }
        // Last of the three filters on purpose. A reason exclusion then counts
        // only appointments that were otherwise importable — at a switched-on
        // office, with a switched-on provider, and not cancelled — which is the
        // number that actually answers "why did a 171-appointment day find four
        // patients". Counting it first would fold the cancelled and the
        // switched-off rows into it and say nothing.
        if (!matchesReason(appt.reason, reasonPhrase)) {
          excludedByReason++;
          continue;
        }
        counts.set(appt.patient, (counts.get(appt.patient) ?? 0) + 1);
      }
      next = body.next ?? null;
    }
  }

  // Names are not on the appointment payload, so resolve them in parallel.
  const results = await Promise.all(
    [...counts.keys()].map(async (id) => {
      const res = await get(`/patients/${id}`);
      const p = res.ok ? ((await res.json()) as DrChronoPatient) : ({ id } as DrChronoPatient);
      return { ...toSummary(p), appointments: counts.get(id) ?? 0 };
    })
  );

  return { scannedAppointments: scanned, results, skippedByDirectory, excludedByStatus, excludedByReason };
}

/**
 * Whether an appointment's free-text reason matches the clinic's phrase.
 *
 * Three decisions, each of which is the difference between this working and
 * this quietly importing the wrong people:
 *
 * **No phrase means no filter.** An unset or blank setting is "every
 * appointment", not "no appointment". The opposite reading would make a clinic
 * that saved the settings form without touching the box import nobody, and
 * report it as a day with no new patients — a silence indistinguishable from a
 * quiet Tuesday.
 *
 * **A missing reason never matches a phrase that was set.** The front desk left
 * the box empty, so the appointment does not say "new patient", so it is not
 * one. Letting it through would mean the filter is skipped exactly where the
 * data is weakest.
 *
 * **Substring, case-insensitive, and whitespace-normalised.** The field is typed
 * by a person under time pressure: "New Patient", "new pt / new patient",
 * "NEW  PATIENT eval" are all the same intent. Matching on equality would reject
 * every one of them, and a word-boundary regex would reject "newpatient". The
 * cost is that a phrase of "NP" also matches "NPO" — which is why the phrase is
 * the clinic's to set and to widen when it is wrong.
 * @param reason - The appointment's free-text reason, as DrChrono returns it.
 * @param phrase - The clinic's configured phrase, if it has one.
 * @returns True when this appointment should be kept.
 */
export function matchesReason(reason: string | undefined, phrase: string | undefined): boolean {
  const needle = normalise(phrase ?? '');
  if (!needle) {
    return true;
  }
  return normalise(reason ?? '').includes(needle);
}

/**
 * Lower-case and collapse runs of whitespace.
 * @param value - Free text.
 * @returns The comparable form.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether a DrChrono id appears in a disabled set.
 * @param id - The office or provider id from the appointment.
 * @param disabled - Disabled ids as strings, keyed the way the directory stores them.
 * @returns True when this appointment must be skipped.
 */
function isDisabled(id: number | undefined, disabled: Set<string>): boolean {
  return typeof id === 'number' && disabled.has(String(id));
}

/**
 * Map DrChrono's snake_case payload onto the shape the UI consumes.
 * @param p - A DrChrono patient record.
 * @returns The UI-facing summary.
 */
function toSummary(p: DrChronoPatient): PatientSummary {
  return {
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    dateOfBirth: p.date_of_birth,
    gender: p.gender,
    chartId: p.chart_id,
    email: p.email,
    cellPhone: p.cell_phone,
  };
}
