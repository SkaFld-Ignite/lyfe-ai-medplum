// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Condition, MedicationStatement, Observation, Patient, Resource } from '@medplum/fhirtypes';
import type { IntegrationKey } from './credentials.ts';
import { guardProviderCall } from './provider-rate-limit.ts';
import { LYFE_SOURCE_TAG_SYSTEM } from './source.ts';

/**
 * The integration key Zus brakes are filed under.
 *
 * Typed as {@link IntegrationKey} rather than as a bare string so the brake, the
 * credential record and the inbound webhook adapter are provably the same word.
 * Three places each spelling `'zus'` independently is how one of them ends up
 * spelling it `'Zus'` and silently keeping its own brake.
 */
export const ZUS_PROVIDER: IntegrationKey = 'zus';

/**
 * Reciprocity: pushing our own data back to Zus.
 *
 * Zus is a network, not a database we read from. Carequality and CommonWell
 * are reciprocal by contract — an organisation that queries for records is
 * expected to contribute its own — so pulling a patient's history without
 * publishing what we know is a one-sided use of the network. lyfe-provider-ui
 * implemented this as `reciprocity-push-service.ts` and it has to survive the
 * move, or the migrated platform quietly becomes a worse network citizen than
 * the one it replaces.
 *
 * What is published mirrors what Lyfe published: problems, medication history
 * and vital signs. Encounters are pushed by the DrChrono importer separately.
 *
 * ### Two things this gets from Medplum that the Prisma version had to hand-roll
 *
 * **Echo prevention is a search filter, not an `if`.** Pushing Zus-sourced
 * data back to Zus would echo their own records at them, so Lyfe read every
 * row and skipped `source === "ZUS"` in application code. Here every resource
 * carries its origin in `meta.tag`, so `_tag=…|drchrono` asks the server for
 * exactly the publishable set and the Zus-sourced rows never leave the
 * database. The check cannot be forgotten at a new call site because there is
 * no check.
 *
 * **Idempotency is the resource's own id.** Lyfe minted
 * `https://lyfeco.ai/prisma/{Type}|{id}` to key its conditional creates. The
 * Medplum resource id is already a stable, globally unique key, so the same
 * guarantee costs nothing: `https://lyfe.com/medplum/{Type}|{id}` sent as
 * `If-None-Exist`. Re-running a push never duplicates.
 */

/** Identifier system that keys our conditional creates in Zus. */
export const RECIPROCITY_IDENTIFIER_SYSTEM = 'https://lyfe.com/medplum';

/** Resources we publish, and the cap applied to each so a backfill stays polite. */
const PUSH_LIMITS = {
  Condition: 200,
  MedicationStatement: 200,
  Observation: 300,
} as const;

/** What one reciprocity run did. */
export interface ReciprocityReport {
  /** Per resource type: how many were eligible, published, and rejected. */
  readonly byType: Record<string, { eligible: number; pushed: number; failed: number }>;
  /** First few failures, for the Task's output. */
  readonly errors: string[];
  readonly total: number;
}

/** The subset of the Zus connection this module needs. */
export interface ZusPushConnection {
  readonly fhirUrl: string;
  readonly token: string;
  /** The clinic, so a push obeys the same per-clinic brake the pulls do. */
  readonly organizationId: string;
}

/**
 * Build the identifier that makes a push idempotent.
 * @param resource - The resource being published.
 * @returns A `system|value` token, or undefined when the resource has no id.
 */
function idempotencyToken(resource: Resource): string | undefined {
  return resource.id ? `${RECIPROCITY_IDENTIFIER_SYSTEM}/${resource.resourceType}|${resource.id}` : undefined;
}

/**
 * Strip a resource down to something Zus will accept, re-anchored to their
 * patient.
 *
 * Our references point at Medplum ids, which mean nothing to Zus. `subject`
 * is rewritten to their patient — by reference *and* by universal id, which
 * is how their own API examples do it — and every other reference is dropped
 * rather than sent dangling. `meta` goes too: our tags and compartments are
 * internal bookkeeping and have no business on their server.
 * @param props - The rewrite inputs.
 * @param props.resource - The resource to publish.
 * @param props.zusPatientId - Builder-scoped Zus patient id.
 * @param props.upid - Zus universal patient id.
 * @returns A resource safe to POST to Zus.
 */
function forZus(props: { resource: Resource; zusPatientId: string; upid: string }): Record<string, unknown> {
  // `id` and `meta` are deliberately discarded: our resource id means nothing
  // on their server, and our tags and compartments are internal bookkeeping.
  const { id: _id, meta: _meta, ...rest } = props.resource as unknown as Record<string, unknown>;
  const subject = {
    reference: `Patient/${props.zusPatientId}`,
    identifier: { system: 'https://zusapi.com/fhir/identifier/universal-id', value: props.upid },
  };

  const body: Record<string, unknown> = { ...rest, subject };
  // Only `subject` survives; `encounter`, `performer`, `recorder` and friends
  // all point at Medplum ids that would dangle on their side.
  for (const key of ['encounter', 'performer', 'recorder', 'asserter', 'informationSource', 'context', 'patient']) {
    delete body[key];
  }

  const token = idempotencyToken(props.resource);
  if (token) {
    const [system, value] = token.split('|');
    body.identifier = [{ system, value }];
  }
  return body;
}

/**
 * Publish one resource to Zus.
 * @param props - The request inputs.
 * @param props.zus - Authenticated Zus connection.
 * @param props.resource - The resource to publish.
 * @param props.zusPatientId - Builder-scoped Zus patient id.
 * @param props.upid - Zus universal patient id.
 * @returns Whether Zus accepted it, and the message when it did not.
 */
async function pushOne(props: {
  zus: ZusPushConnection;
  resource: Resource;
  zusPatientId: string;
  upid: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = idempotencyToken(props.resource);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${props.zus.token}`,
    'Content-Type': 'application/fhir+json',
    Accept: 'application/fhir+json',
    // Zus's conditional create. Without it a retry duplicates the record on
    // their side, where we cannot clean it up.
    ...(token ? { 'If-None-Exist': `identifier=${token}` } : {}),
  };

  // Deliberately no `Zus-Account`. That header asks Zus to act AS the named
  // builder, which a write is not entitled to do: sending our own builder id
  // came back `403 "User is not authorized to impersonate builder …"` on every
  // resource. Zus's own reads take it and their writes do not, which is what
  // lyfe-provider-ui does too — its `makeAuthenticatedRequest` sends only the
  // bearer token on a POST.

  // Guarded for the same reason the pulls are, and with more to gain: a push
  // runs one POST per eligible resource, so a throttled clinic used to take a
  // 429 on every one of them and count each as a soft failure. The resource was
  // dropped, the report said "failed", and nothing said why. With the brake on,
  // the first refusal stops the rest and the run is suspended until the window
  // Zus named — and these writes carry `If-None-Exist`, so resuming them is
  // idempotent rather than a second copy.
  const res = await guardProviderCall({
    provider: ZUS_PROVIDER,
    organizationId: props.zus.organizationId,
    label: `POST ${props.resource.resourceType}`,
    call: async () =>
      fetch(`${props.zus.fhirUrl}/${props.resource.resourceType}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(forZus({ resource: props.resource, zusPatientId: props.zusPatientId, upid: props.upid })),
      }),
  });

  if (res.ok) {
    return { ok: true };
  }
  const detail = (await res.text()).slice(0, 200);
  return { ok: false, error: `${props.resource.resourceType} ${res.status}: ${detail}` };
}

/**
 * Publish this patient's locally-authored record back to Zus.
 *
 * Only resources tagged as DrChrono-sourced are eligible — see the note at the
 * top of this file on why that is a search filter rather than a check.
 * @param props - The push inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.zus - Authenticated Zus connection.
 * @param props.patient - The Medplum patient whose record to publish.
 * @param props.zusPatientId - Builder-scoped Zus patient id.
 * @param props.upid - Zus universal patient id.
 * @param props.log - Where to write progress.
 * @returns What was published.
 */
export async function pushReciprocity(props: {
  medplum: MedplumClient;
  zus: ZusPushConnection;
  patient: Patient;
  zusPatientId: string;
  upid: string;
  log: (message: string) => void;
}): Promise<ReciprocityReport> {
  const patientRef = `Patient/${props.patient.id}`;
  const drchronoTag = `${LYFE_SOURCE_TAG_SYSTEM}|drchrono`;
  const byType: Record<string, { eligible: number; pushed: number; failed: number }> = {};
  const errors: string[] = [];
  let total = 0;

  const sets: { resourceType: 'Condition' | 'MedicationStatement' | 'Observation'; query: Record<string, string> }[] = [
    { resourceType: 'Condition', query: { patient: patientRef } },
    { resourceType: 'MedicationStatement', query: { subject: patientRef } },
    // Vital signs only. Publishing every lab and every imported panel would be
    // a far larger claim about our data than reciprocity asks for.
    { resourceType: 'Observation', query: { subject: patientRef, category: 'vital-signs' } },
  ];

  for (const set of sets) {
    const limit = PUSH_LIMITS[set.resourceType];
    const found = (await props.medplum.searchResources(set.resourceType, {
      ...set.query,
      _tag: drchronoTag,
      _count: String(limit),
    })) as unknown as (Condition | MedicationStatement | Observation)[];

    const stats = { eligible: found.length, pushed: 0, failed: 0 };
    byType[set.resourceType] = stats;
    if (found.length === 0) {
      continue;
    }
    props.log(`reciprocity: ${found.length} ${set.resourceType} to publish`);

    for (const resource of found) {
      const result = await pushOne({
        zus: props.zus,
        resource,
        zusPatientId: props.zusPatientId,
        upid: props.upid,
      });
      if (result.ok) {
        stats.pushed++;
        total++;
      } else {
        stats.failed++;
        // One rejection must not cost the rest of the batch: the point of
        // reciprocity is to contribute what we can, not all-or-nothing.
        if (errors.length < 5) {
          errors.push(result.error);
        }
      }
    }
    props.log(`reciprocity: ${set.resourceType} published ${stats.pushed}/${stats.eligible}`);
  }

  return { byType, errors, total };
}
