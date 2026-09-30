// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Location, Organization, Practitioner, Reference } from '@medplum/fhirtypes';

/**
 * The clinic directory: which providers and offices exist, and which of them
 * this clinic has switched on.
 *
 * There is no new resource type here on purpose. FHIR already models both
 * sides of it, and both already carry a boolean the spec intends for exactly
 * this:
 *
 *   - a provider is a `Practitioner`, enabled via `Practitioner.active`
 *   - an office is a `Location`, enabled via `Location.status`
 *
 * So "enabled" is not a field we invented and have to keep in step with
 * anything; it is the resource's own state, editable from the Medplum admin UI,
 * visible in every search, and understood by any other FHIR client. The cost of
 * that choice is the merge logic below: a re-pull from DrChrono must not
 * clobber a decision an operator made here.
 */

/** Identifier systems the DrChrono importer stamps on directory resources. */
export const DIRECTORY_SYSTEMS = {
  practitioner: 'https://drchrono.com/doctors',
  location: 'https://drchrono.com/offices',
} as const;

/** One directory row, keyed by the DrChrono id it was imported from. */
export interface DirectoryEntry {
  /** Medplum resource id. */
  readonly id: string;
  /** Whether this clinic currently has it switched on. */
  readonly enabled: boolean;
}

/** Current enablement for both halves of the directory, by DrChrono id. */
export interface DirectoryState {
  readonly practitioners: Map<string, DirectoryEntry>;
  readonly locations: Map<string, DirectoryEntry>;
}

/**
 * A `Location` counts as enabled only while its status is `active`.
 *
 * An absent status is treated as enabled because FHIR makes the field
 * optional and Medplum's own resource editor will happily save a Location
 * without one. Reading that as "disabled" would silently switch off every
 * office created outside this app.
 * @param location - The office.
 * @returns True when appointments at this office may be imported.
 */
export function isLocationEnabled(location: Location): boolean {
  return (location.status ?? 'active') === 'active';
}

/**
 * A `Practitioner` counts as enabled unless `active` is explicitly false.
 *
 * Same reasoning as the Location case: `active` is optional, and most
 * Practitioners on the server were written without it.
 * @param practitioner - The provider.
 * @returns True when appointments with this provider may be imported.
 */
export function isPractitionerEnabled(practitioner: Practitioner): boolean {
  return practitioner.active !== false;
}

/**
 * Read the first identifier value for a given system.
 * @param resource - The resource to read.
 * @param resource.identifier - The resource's identifier list.
 * @param system - The identifier system to match.
 * @returns The identifier value, or undefined when the resource has none.
 */
function identifierValue(
  resource: { identifier?: { system?: string; value?: string }[] },
  system: string
): string | undefined {
  return resource.identifier?.find((i) => i.system === system)?.value;
}

/**
 * Load every DrChrono-sourced Practitioner and Location for a clinic, along
 * with whether it is currently enabled.
 *
 * Only resources carrying a DrChrono identifier are returned. That matters
 * more than it looks: `Practitioner` also holds the login records of the
 * clinic's own staff, which are not directory entries and must never show up
 * on the directory page or gate an import.
 * @param medplum - Medplum client.
 * @param organization - The clinic whose directory to read.
 * @returns Enablement for both resource types, keyed by DrChrono id.
 */
export async function readDirectoryState(
  medplum: MedplumClient,
  organization: Reference<Organization>
): Promise<DirectoryState> {
  // Sequential, NOT Promise.all. Two searches issued in the same tick are
  // merged by MedplumClient's auto-batching into one batch bundle whose flush
  // is scheduled with `setTimeout`. The bot sandbox has no working timer, so
  // that flush never runs: both promises stay pending, the bot hangs until its
  // 900s timeout, and nothing is logged because no error is ever thrown.
  // Two sub-second round trips are a cheap price for not reintroducing that.
  const practitioners = await medplum.searchResources('Practitioner', {
    identifier: `${DIRECTORY_SYSTEMS.practitioner}|`,
    _count: '1000',
  });
  const locations = await medplum.searchResources('Location', {
    identifier: `${DIRECTORY_SYSTEMS.location}|`,
    _count: '1000',
  });

  const orgRef = organization.reference;
  const practitionerMap = new Map<string, DirectoryEntry>();
  for (const p of practitioners) {
    const key = identifierValue(p, DIRECTORY_SYSTEMS.practitioner);
    // Skip other tenants' rows. Practitioner is readable project-wide so that
    // reference display names resolve, which means this search can legitimately
    // return another clinic's directory.
    if (!key || !p.id || !belongsTo(p.meta?.account?.reference, orgRef)) {
      continue;
    }
    practitionerMap.set(key, { id: p.id, enabled: isPractitionerEnabled(p) });
  }

  const locationMap = new Map<string, DirectoryEntry>();
  for (const l of locations) {
    const key = identifierValue(l, DIRECTORY_SYSTEMS.location);
    if (!key || !l.id || !belongsTo(l.meta?.account?.reference, orgRef)) {
      continue;
    }
    locationMap.set(key, { id: l.id, enabled: isLocationEnabled(l) });
  }

  return { practitioners: practitionerMap, locations: locationMap };
}

/**
 * Whether a resource's account reference names this clinic.
 *
 * A resource with no account at all is accepted. Directory rows imported
 * before compartment stamping was added have none, and rejecting them would
 * make the whole directory vanish until the first re-sync rewrites it.
 * @param accountRef - The resource's `meta.account.reference`.
 * @param orgRef - The clinic's reference.
 * @returns True when the resource belongs to this clinic, or to no clinic yet.
 */
function belongsTo(accountRef: string | undefined, orgRef: string | undefined): boolean {
  return !accountRef || accountRef === orgRef;
}

/**
 * Decide the enablement a directory resource should be written with.
 *
 * A re-pull from DrChrono must not silently undo an operator's decision. That
 * is the whole hazard here: the importer upserts by conditional PUT, which
 * replaces the resource, so every chart import would otherwise reset the
 * directory to whatever DrChrono says.
 *
 * The rule:
 *   - DrChrono says it is retired (`archived` / `is_account_suspended`)
 *     -> disabled, and the operator cannot override that. An office that no
 *     longer exists upstream should not be importable.
 *   - otherwise, if we already hold this row, keep whatever it is set to now.
 *   - otherwise this is a first import, so default to enabled.
 * @param args - The upstream retired flag and any existing entry.
 * @param args.retiredUpstream - Whether DrChrono reports it as archived or suspended.
 * @param args.existing - The directory row we already hold, when there is one.
 * @returns True when the resource should be written as enabled.
 */
export function mergeEnabled(args: { retiredUpstream: boolean; existing: DirectoryEntry | undefined }): boolean {
  if (args.retiredUpstream) {
    return false;
  }
  return args.existing?.enabled ?? true;
}

/**
 * The DrChrono office and provider ids whose appointments may be imported.
 *
 * Ids absent from the directory are *not* included here; callers must treat an
 * unknown id as allowed. A DrChrono office added after the last directory sync
 * has never been switched off by anyone, and dropping its appointments would
 * be a silent data loss that looks exactly like a broken import.
 * @param medplum - Medplum client.
 * @param organization - The clinic whose directory to read.
 * @returns The disabled ids, which is what callers actually filter on.
 */
export async function readDisabledDirectoryIds(
  medplum: MedplumClient,
  organization: Reference<Organization>
): Promise<{ offices: Set<string>; doctors: Set<string> }> {
  const state = await readDirectoryState(medplum, organization);
  const offices = new Set<string>();
  for (const [key, entry] of state.locations) {
    if (!entry.enabled) {
      offices.add(key);
    }
  }
  const doctors = new Set<string>();
  for (const [key, entry] of state.practitioners) {
    if (!entry.enabled) {
      doctors.add(key);
    }
  }
  return { offices, doctors };
}
