// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Coverage, Organization, Reference } from '@medplum/fhirtypes';
import { upsertBatch, withMedplum429Retry } from './batch.ts';

/**
 * Turn the payer *names* on imported Coverage into real `Organization`
 * resources, and point the Coverage at them.
 *
 * Zus sends a payer with a real name and a reference to *its own*
 * Organization — `{ display: "Cal Optima Health Plan", reference:
 * "Organization/8383a420-…" }` — and the importer mirrors that reference
 * verbatim. The id means nothing here, so the reference dangles: reading it
 * returns 404.
 *
 * That is why the chart says "Unknown Payor" for sixteen payers it clearly
 * knows the names of. `Coverage.payor` is typed as a reference, so every
 * client resolves it rather than reading `display` — Medplum's own
 * `CoverageItem` calls `useResource(payor)` and takes `.name` off whatever
 * comes back. A dangling reference resolves to nothing and falls through to
 * the placeholder.
 *
 * A missing reference and an unresolvable one therefore look identical to a
 * reader, and both are repaired the same way: mint the `Organization` the
 * payer name implies and point the Coverage at that. A reference that already
 * resolves inside this project is left alone.
 *
 * The display text is kept alongside the new reference, so a reader that
 * never resolves it still sees the payer's name.
 */

/** Identifier system for payers we mint from a name. */
export const PAYER_IDENTIFIER_SYSTEM = 'https://lyfe.com/payer';

/**
 * Normalise a payer name into a stable identifier value.
 *
 * Case and punctuation vary between networks for the same payer — "OPTUM -
 * CALOPTIMA (MEDICAID)" and "Optum - CalOptima (Medicaid)" are one payer — so
 * the identifier is derived from a folded form. The `Organization.name` keeps
 * whichever spelling arrived first, since inventing a canonical spelling for a
 * payer is not this importer's job.
 * @param name - Payer name as the source system spelled it.
 * @returns A lowercase, punctuation-free key.
 */
export function payerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Ensure an Organization exists for every payer named on these Coverages, and
 * rewrite each `payor` to reference it.
 *
 * Coverages whose payor already carries a reference are left alone, so this is
 * safe to run repeatedly and safe to run over a mixed set.
 * @param props - The linking inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The clinic, stamped on any Organization created.
 * @param props.coverages - The Coverages to link.
 * @returns How many payers were upserted and how many Coverages were rewritten.
 */
export async function linkCoveragePayors(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  coverages: Coverage[];
}): Promise<{ payers: number; linked: number }> {
  // 1. Which referenced Organizations actually exist here? Anything Zus sent
  //    points at an id in *their* project, so most of these resolve to
  //    nothing — but a reference we minted on a previous run does resolve and
  //    must not be rewritten.
  const referencedIds = new Set<string>();
  for (const coverage of props.coverages) {
    for (const payor of coverage.payor ?? []) {
      const id = payor.reference?.startsWith('Organization/')
        ? payor.reference.slice('Organization/'.length)
        : undefined;
      if (id) {
        referencedIds.add(id);
      }
    }
  }
  const resolvable = new Set<string>();
  if (referencedIds.size > 0) {
    const found = await props.medplum.searchResources('Organization', {
      _id: [...referencedIds].join(','),
      _count: String(referencedIds.size),
    });
    for (const org of found) {
      if (org.id) {
        resolvable.add(org.id);
      }
    }
  }

  /**
   * Whether this payor still needs an Organization of ours.
   * @param payor - One `Coverage.payor` entry.
   * @param payor.reference - Its current reference, if any.
   * @returns True when the reference is absent or does not resolve here.
   */
  const needsLink = (payor: { reference?: string }): boolean => {
    if (!payor.reference) {
      return true;
    }
    const id = payor.reference.startsWith('Organization/') ? payor.reference.slice('Organization/'.length) : undefined;
    return !id || !resolvable.has(id);
  };

  // 2. Every distinct payer name that still needs one.
  const names = new Map<string, string>();
  for (const coverage of props.coverages) {
    for (const payor of coverage.payor ?? []) {
      const display = payor.display?.trim();
      if (display && needsLink(payor)) {
        names.set(payerKey(display), display);
      }
    }
  }
  if (names.size === 0) {
    return { payers: 0, linked: 0 };
  }

  // 3. Upsert one Organization per payer, keyed by the folded name so the same
  //    payer arriving from two networks converges on one resource.
  const entries = [...names.entries()].map(([key, display]) => ({
    resourceType: 'Organization' as const,
    resource: {
      resourceType: 'Organization' as const,
      meta: { account: props.organization, accounts: [props.organization] },
      identifier: [{ system: PAYER_IDENTIFIER_SYSTEM, value: key }],
      active: true,
      // `pay` marks this as a payer rather than a provider organisation, which
      // is what lets a reader tell the two apart in one project.
      type: [
        {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'pay', display: 'Payer' },
          ],
        },
      ],
      name: display,
    },
    system: PAYER_IDENTIFIER_SYSTEM,
    value: key,
  }));

  const written = await upsertBatch(props.medplum, entries, { label: 'payers' });
  const byKey = new Map<string, string>();
  entries.forEach((entry, i) => {
    const id = written.ids[i];
    if (id) {
      byKey.set(entry.value, id);
    }
  });

  // 4. Point each Coverage at its payer, keeping the display text so a reader
  //    that does not resolve the reference still sees a name.
  let linked = 0;
  for (const coverage of props.coverages) {
    if (!coverage.id) {
      continue;
    }
    let changed = false;
    const payor = (coverage.payor ?? []).map((p) => {
      const display = p.display?.trim();
      if (!display || !needsLink(p)) {
        return p;
      }
      const id = byKey.get(payerKey(display));
      if (!id) {
        return p;
      }
      changed = true;
      return { ...p, reference: `Organization/${id}`, display };
    });
    if (!changed) {
      continue;
    }
    try {
      await withMedplum429Retry(
        () =>
          props.medplum.patchResource('Coverage', coverage.id as string, [{ op: 'add', path: '/payor', value: payor }]),
        `link payor on Coverage/${coverage.id}`
      );
      linked++;
    } catch {
      // A payer that cannot be linked leaves the Coverage exactly as it was.
      // Losing the link is a display problem; failing the import over it would
      // be worse.
    }
  }

  return { payers: written.wrote, linked };
}

/**
 * Link the payers on every Coverage a patient holds.
 *
 * Reads the Coverages back rather than taking them as an argument, so this can
 * run as a tidy-up step after an import without the caller threading the
 * written resources through.
 * @param props - The lookup inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The clinic.
 * @param props.patientId - Medplum patient id.
 * @returns How many payers were upserted and how many Coverages were rewritten.
 */
export async function linkPatientCoveragePayors(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  patientId: string;
}): Promise<{ payers: number; linked: number }> {
  const coverages = await props.medplum.searchResources('Coverage', {
    patient: `Patient/${props.patientId}`,
    _count: '200',
  });
  return linkCoveragePayors({ medplum: props.medplum, organization: props.organization, coverages: [...coverages] });
}
