// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Exactly-once handling of a redelivered event.
 *
 * Every provider worth integrating redelivers. DrChrono sends a failed hook
 * again at +1h, +3h and +7h, and an operator can resend any delivery by hand
 * from the console forever. So "the same event arriving twice" is the normal
 * case, not an edge case, and it has to be a no-op.
 *
 * The key is the **provider's own delivery id**, which is the only thing that
 * distinguishes "sent again" from "happened again". A content hash cannot: a
 * redelivery is byte-identical to the original, and two genuine edits a minute
 * apart may also be. lyfe-provider-ui hashed the Zus payload and did not dedup
 * DrChrono at all.
 *
 * The store is a `Basic` resource claimed by **conditional create** — FHIR's
 * `If-None-Exist`, which Medplum evaluates atomically on the server. That is the
 * dedup primitive this platform already uses everywhere else: every resource the
 * importers write lands through a conditional `PUT` keyed on a business
 * identifier (`shared/batch.ts`). This is the same idea applied to a delivery
 * instead of a chart row, which is why it needs no new data type.
 *
 * WHY A NONCE
 * -----------
 * `createResourceIfNoneExist` returns the winning resource either way and does
 * not say whether it was the one that created it. Two concurrent deliveries of
 * the same id would both get a resource back and both conclude they were first.
 * So the claim carries a nonce: whoever's nonce comes back won, and everyone
 * else is a duplicate. That turns the conditional create into a
 * compare-and-swap, which is what exactly-once actually needs.
 */
import type { MedplumClient } from '@medplum/core';
import type { Basic } from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';

/** Identifier system for a claimed delivery. */
export const DELIVERY_SYSTEM = 'https://lyfe.health/webhook-delivery';

/** Extension holding the claim nonce. See the note at the top. */
export const CLAIM_NONCE_EXTENSION = `${DELIVERY_SYSTEM}/claim`;

/** The outcome of trying to claim a delivery. */
export interface DeliveryClaim {
  /** True when this process is the one that must do the work. */
  readonly won: boolean;
  /** The claim resource's id, so a failed run can release it. */
  readonly id: string;
}

/**
 * Compose the identifier value for one delivery.
 *
 * Namespaced by provider because delivery ids are only unique within a provider,
 * and by organization because two clinics on the same provider are two
 * independent streams — a collision across them would be a cross-tenant drop,
 * which is worse than a duplicate import.
 * @param props - What identifies the delivery.
 * @param props.provider - The adapter id.
 * @param props.organizationId - The clinic.
 * @param props.deliveryId - The provider's own delivery id.
 * @returns The identifier value.
 */
export function deliveryKey(props: { provider: string; organizationId: string; deliveryId: string }): string {
  return `${props.provider}:${props.organizationId}:${props.deliveryId}`;
}

/**
 * Claim a delivery, or discover that someone already has.
 * @param props - What to claim.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.provider - The adapter id.
 * @param props.organizationId - The clinic.
 * @param props.deliveryId - The provider's own delivery id.
 * @param props.eventName - The provider's event name, recorded for operators.
 * @returns Whether this caller won the claim.
 */
export async function claimDelivery(props: {
  medplum: MedplumClient;
  provider: string;
  organizationId: string;
  deliveryId: string;
  eventName: string;
}): Promise<DeliveryClaim> {
  const value = deliveryKey(props);
  const nonce = randomUUID();
  const organization = { reference: `Organization/${props.organizationId}` };

  const claim: Basic = {
    resourceType: 'Basic',
    // Compartmented to the clinic, like every other tenant-scoped resource here.
    meta: { account: organization, accounts: [organization] },
    identifier: [{ system: DELIVERY_SYSTEM, value }],
    code: { coding: [{ system: DELIVERY_SYSTEM, code: props.provider }], text: props.eventName },
    subject: organization,
    // `Basic.created` is a FHIR `date`, not a `dateTime` — a full timestamp
    // fails validation under this project's strictMode.
    created: new Date().toISOString().slice(0, 10),
    extension: [{ url: CLAIM_NONCE_EXTENSION, valueString: nonce }],
  };

  const winner = await props.medplum.createResourceIfNoneExist(
    claim,
    `identifier=${encodeURIComponent(DELIVERY_SYSTEM)}|${encodeURIComponent(value)}`
  );

  const storedNonce = winner.extension?.find((ext) => ext.url === CLAIM_NONCE_EXTENSION)?.valueString;
  return { won: storedNonce === nonce, id: winner.id };
}

/**
 * Give a claim back after the work it guarded failed to start.
 *
 * Without this a delivery that is claimed and then fails to reach the queue is
 * lost forever: the provider redelivers, the claim is already held, and the
 * redelivery is dropped as a duplicate of work that never happened. Releasing
 * turns that into exactly what the retry is for.
 *
 * Failure to release is swallowed. By the time this runs the caller is already
 * answering 5xx so the provider will retry; a throw here would replace that with
 * a different 5xx and bury the real reason.
 * @param props - What to release.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.id - The claim resource id.
 */
export async function releaseDelivery(props: { medplum: MedplumClient; id: string }): Promise<void> {
  await props.medplum.deleteResource('Basic', props.id).catch(() => undefined);
}
