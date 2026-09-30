// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The clinic directory: providers and offices, and whether each is switched on.
 *
 * There is no new resource type behind this page. A provider is a FHIR
 * `Practitioner` and an office is a FHIR `Location`, and each already carries
 * the flag this page toggles — `Practitioner.active` and `Location.status`.
 * Reading and writing them is therefore plain Medplum: `searchResources` to
 * list, `patchResource` to toggle. Nothing is denormalised, so nothing can
 * drift out of step.
 *
 * Refreshing the list from DrChrono is the one part that cannot happen in the
 * browser, because DrChrono sends no CORS headers and the token must not ship
 * in client JS. That goes through the import bot's `syncDirectory` action.
 */
import type { MedplumClient } from '@medplum/core';
import type { Location, Practitioner } from '@medplum/fhirtypes';

/**
 * Marks an office whose patients may be enrolled in Zus.
 *
 * Separate from `Location.status` on purpose. Importing an office's charts and
 * enrolling its patients with a third party are different decisions with
 * different costs, so the Directory asks them separately.
 */
export const ZUS_ENROLMENT_EXTENSION = 'https://lyfe.health/fhir/StructureDefinition/zus-enrolment';

/** Identifier systems the DrChrono importer stamps on directory resources. */
export const DIRECTORY_SYSTEMS = {
  practitioner: 'https://drchrono.com/doctors',
  location: 'https://drchrono.com/offices',
} as const;

/** Identifier of the bot that owns the DrChrono pull. */
const IMPORT_BOT_IDENTIFIER = 'https://lyfe.health/bots|lyfe-drchrono-import';

/** Thrown when the bot is absent or refuses, so the UI can say which. */
export class DirectoryBackendUnavailableError extends Error {}

/** One row on the Directory page. */
export interface DirectoryRow {
  /** Medplum resource id. */
  readonly id: string;
  /** DrChrono's own id, shown so a row can be matched against DrChrono. */
  readonly sourceId: string;
  readonly name: string;
  /** Speciality for a provider, address for an office. */
  readonly detail?: string;
  readonly enabled: boolean;
  /** Offices only: whether patients seen here may be enrolled in Zus. */
  readonly zusEnabled: boolean;
}

/** Both halves of the directory. */
export interface Directory {
  readonly practitioners: DirectoryRow[];
  readonly locations: DirectoryRow[];
}

/**
 * Read the first identifier value for a system.
 * @param resource - Resource to read.
 * @param resource.identifier - The resource's identifier list.
 * @param system - Identifier system to match.
 * @returns The value, or undefined.
 */
function identifierValue(
  resource: { identifier?: { system?: string; value?: string }[] },
  system: string
): string | undefined {
  return resource.identifier?.find((i) => i.system === system)?.value;
}

/**
 * Human-readable name for a Practitioner.
 * @param p - The provider.
 * @returns Given and family joined, falling back to the resource id.
 */
function practitionerName(p: Practitioner): string {
  const n = p.name?.[0];
  const joined = [n?.given?.join(' '), n?.family].filter(Boolean).join(' ').trim();
  const suffix = n?.suffix?.join(' ');
  return [joined || p.id, suffix].filter(Boolean).join(', ');
}

/**
 * Single-line address for a Location.
 * @param l - The office.
 * @returns Street, city and state joined, or undefined when there is no address.
 */
function locationAddress(l: Location): string | undefined {
  const a = l.address;
  if (!a) {
    return undefined;
  }
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  return [a.line?.join(' '), cityState].filter(Boolean).join(' · ') || undefined;
}

/**
 * Load the clinic's directory.
 *
 * Only resources carrying a DrChrono identifier are listed. That filter is
 * load-bearing rather than cosmetic: `Practitioner` also holds the login
 * records of the clinic's own staff, and those are not directory entries —
 * switching one off would be meaningless at best.
 * @param medplum - Authenticated Medplum client.
 * @returns Providers and offices, each sorted by name.
 */
export async function loadDirectory(medplum: MedplumClient): Promise<Directory> {
  const [practitioners, locations] = await Promise.all([
    medplum.searchResources('Practitioner', {
      identifier: `${DIRECTORY_SYSTEMS.practitioner}|`,
      _count: '1000',
    }),
    medplum.searchResources('Location', {
      identifier: `${DIRECTORY_SYSTEMS.location}|`,
      _count: '1000',
    }),
  ]);

  const byName = (a: DirectoryRow, b: DirectoryRow): number => a.name.localeCompare(b.name);

  return {
    practitioners: practitioners
      .filter((p) => p.id)
      .map((p) => ({
        id: p.id,
        sourceId: identifierValue(p, DIRECTORY_SYSTEMS.practitioner) ?? '—',
        name: practitionerName(p),
        detail: p.qualification?.[0]?.code?.text,
        // `active` is optional in FHIR, so only an explicit false is "off".
        enabled: p.active !== false,
        // Zus enrolment is an office-level decision; providers never carry it.
        zusEnabled: false,
      }))
      .sort(byName),
    locations: locations
      .filter((l) => l.id)
      .map((l) => ({
        id: l.id,
        sourceId: identifierValue(l, DIRECTORY_SYSTEMS.location) ?? '—',
        name: l.name ?? l.id,
        detail: locationAddress(l),
        enabled: (l.status ?? 'active') === 'active',
        zusEnabled: l.extension?.find((e) => e.url === ZUS_ENROLMENT_EXTENSION)?.valueBoolean === true,
      }))
      .sort(byName),
  };
}

/**
 * Switch a provider on or off.
 *
 * A JSON Patch rather than a full update, so two operators toggling different
 * rows cannot overwrite each other's row with a stale copy of the resource.
 * @param medplum - Authenticated Medplum client.
 * @param id - Practitioner resource id.
 * @param enabled - The new state.
 */
export async function setPractitionerEnabled(medplum: MedplumClient, id: string, enabled: boolean): Promise<void> {
  await medplum.patchResource('Practitioner', id, [{ op: 'add', path: '/active', value: enabled }]);
}

/**
 * Switch an office on or off.
 *
 * `suspended` rather than `inactive` is deliberate: FHIR reads `inactive` as
 * "this location no longer exists", which is a claim about DrChrono, not about
 * what this clinic wants imported. `suspended` is the reversible one.
 * @param medplum - Authenticated Medplum client.
 * @param id - Location resource id.
 * @param enabled - The new state.
 */
export async function setLocationEnabled(medplum: MedplumClient, id: string, enabled: boolean): Promise<void> {
  await medplum.patchResource('Location', id, [
    { op: 'add', path: '/status', value: enabled ? 'active' : 'suspended' },
  ]);
}

/**
 * Switch Zus enrolment on or off for an office.
 *
 * Written as a whole-extension replace rather than a patch to one array index,
 * because the index is not stable and a Location may carry other extensions.
 * @param medplum - Authenticated Medplum client.
 * @param id - Location resource id.
 * @param zusEnabled - The new state.
 */
export async function setLocationZusEnabled(medplum: MedplumClient, id: string, zusEnabled: boolean): Promise<void> {
  const location = await medplum.readResource('Location', id);
  const others = (location.extension ?? []).filter((e) => e.url !== ZUS_ENROLMENT_EXTENSION);
  await medplum.updateResource<Location>({
    ...location,
    extension: [...others, { url: ZUS_ENROLMENT_EXTENSION, valueBoolean: zusEnabled }],
  });
}

/** What one DrChrono directory refresh wrote. */
export interface DirectorySyncSummary {
  readonly practitioners: { readonly wrote: number; readonly disabled: number };
  readonly locations: { readonly wrote: number; readonly disabled: number };
}

/**
 * Re-pull providers and offices from DrChrono.
 *
 * The pull never re-enables anything: the bot reads the current state before
 * writing and carries every toggle forward. Without that, a refresh — or any
 * chart import, which pulls the same two endpoints — would quietly switch a
 * disabled office back on.
 * @param medplum - Authenticated Medplum client.
 * @returns Counts of what was written.
 */
export async function syncDirectoryFromDrChrono(medplum: MedplumClient): Promise<DirectorySyncSummary> {
  let bot;
  try {
    bot = await medplum.searchOne('Bot', { identifier: IMPORT_BOT_IDENTIFIER });
  } catch (err) {
    throw new DirectoryBackendUnavailableError(
      `Could not look up the DrChrono import bot: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!bot?.id) {
    throw new DirectoryBackendUnavailableError(
      `No Bot found with identifier ${IMPORT_BOT_IDENTIFIER}. Run "npm run deploy:bots".`
    );
  }

  const body = (await medplum.executeBot(
    bot.id,
    { action: 'syncDirectory' },
    'application/json'
  )) as Partial<DirectorySyncSummary> & { ok?: boolean; error?: string };

  // The bot reports configuration failures in-band so the message survives
  // instead of becoming a generic 500.
  if (body?.ok === false && body.error) {
    throw new DirectoryBackendUnavailableError(body.error);
  }

  return {
    practitioners: body.practitioners ?? { wrote: 0, disabled: 0 },
    locations: body.locations ?? { wrote: 0, disabled: 0 },
  };
}
