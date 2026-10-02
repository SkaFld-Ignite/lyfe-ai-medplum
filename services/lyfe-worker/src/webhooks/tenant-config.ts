// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tenant inbound configuration, read from FHIR.
 *
 * Which providers a clinic has, what their secrets are and which events they
 * want is **data**, and it already has a home: the one `Basic` resource per
 * (Organization, integration) that `bots/shared/credentials.ts` owns. The
 * webhook fields live in that same record, in the same AES-256-GCM secret
 * bucket as the OAuth credentials, because a clinic that has DrChrono
 * configured and a clinic that has DrChrono webhooks configured are the same
 * clinic and splitting them would mean two things to keep in step.
 *
 * No new resource type, no new profile, no new table. Adding a provider adds no
 * schema at all — `WEBHOOK_CONFIG_FIELDS` and `WEBHOOK_SECRET_FIELDS` are
 * merged into every integration's allow-list, so a provider is webhook-capable
 * the moment it exists.
 *
 * THE REQUESTER, AND WHY IT IS RE-CHECKED
 * ---------------------------------------
 * Everything downstream resolves the clinic it writes into from `requester`,
 * never from an organization id it was handed — that is the IDOR the importers
 * were hardened against, and a webhook does not get to re-open it. But a webhook
 * has no user, so something has to supply a profile.
 *
 * It comes from the clinic's own `webhookRequester` config field, and then it is
 * **re-resolved through that profile's own ProjectMembership and rejected unless
 * it lands on the organization that owns the record**. Config is written by an
 * authenticated clinic admin, so it is not attacker-controlled; but it is
 * admin-of-clinic-A-controlled, and without this check an admin of A could name
 * a practitioner of B and have A's DrChrono events import into B's chart. The
 * check costs one search and makes the stored value a lookup key rather than a
 * grant.
 */
import type { MedplumClient } from '@medplum/core';
import {
  deriveEncryptionKey,
  ENCRYPTION_KEY_SECRET_NAME,
  getCredentialValues,
  readCredentialRecord,
} from '../../../../examples/medplum-provider/bots/shared/credentials.ts';
import type { InboundAdapter } from './contract.ts';

/** Config field naming the profile webhook-driven work runs as. */
export const REQUESTER_FIELD = 'webhookRequester';

/** Config field holding the clinic's event allow-list. */
export const EVENTS_FIELD = 'webhookEvents';

/**
 * Config field holding the provider's own id for this clinic.
 *
 * Optional. When set, a delivery whose {@link InboundAdapter.tenantClaim} says
 * otherwise is refused — see `receive.ts`. Left unset the check does not run,
 * because the signature is the trust boundary and making this mandatory would
 * stop deliveries for every clinic already configured without it.
 */
export const TENANT_ID_FIELD = 'webhookTenantId';

/** Everything the receiver needs to serve one clinic's deliveries. */
export interface TenantWebhookConfig {
  /** The clinic. */
  readonly organizationId: string;
  /** The shared secret this provider authenticates with. */
  readonly secret: string;
  /** The profile downstream work runs as, e.g. `Practitioner/abc`. */
  readonly requester: string;
  /** Provider event names the clinic opted into, or undefined for all. */
  readonly subscribedEvents?: readonly string[];
  /** The provider's own id for this clinic, when one has been recorded. */
  readonly tenantId?: string;
}

/** Why a clinic's configuration could not be used. */
export class WebhookConfigError extends Error {
  /** HTTP status the receiver should answer with. */
  readonly status: number;

  /**
   * @param status - HTTP status to answer with.
   * @param message - Operator-facing reason. Never contains a secret.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WebhookConfigError';
    this.status = status;
  }
}

/**
 * Load one clinic's configuration for one provider.
 *
 * Every failure here is a 5xx rather than a 200, deliberately. The provider
 * retries a 5xx on its own schedule — DrChrono three times over seven hours —
 * which is the window in which somebody can fix a missing setting. A 200 would
 * tell the provider the event was handled and destroy it.
 *
 * A 404 is the exception: an organization that has no record for this provider
 * is not misconfigured, it is not a customer of it, and retrying will not change
 * that.
 * @param props - What to load.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.adapter - The provider.
 * @param props.organizationId - The clinic from the callback URL.
 * @returns The clinic's configuration.
 */
export async function loadTenantConfig(props: {
  medplum: MedplumClient;
  adapter: InboundAdapter;
  organizationId: string;
}): Promise<TenantWebhookConfig> {
  const { medplum, adapter, organizationId } = props;
  const organization = { reference: `Organization/${organizationId}` } as const;

  const material = process.env[ENCRYPTION_KEY_SECRET_NAME];
  if (!material) {
    throw new WebhookConfigError(
      503,
      `${ENCRYPTION_KEY_SECRET_NAME} is not set on the worker, so no clinic's webhook secret can be read`
    );
  }

  const record = await readCredentialRecord({ medplum, organization, integration: adapter.id });
  if (!record) {
    throw new WebhookConfigError(404, `${organization.reference} has no ${adapter.id} integration configured`);
  }

  const values = getCredentialValues({ record, key: deriveEncryptionKey({ material }) });

  if (values.unreadableSecrets.includes(adapter.secretField)) {
    // Distinct from "not set" on purpose, the same way the Integrations page
    // distinguishes them: ciphertext that will not decrypt means the encryption
    // key changed, and an operator told "not configured" will cheerfully
    // overwrite a secret that is still recoverable.
    throw new WebhookConfigError(
      503,
      `${adapter.secretField} for ${organization.reference} will not decrypt; ${ENCRYPTION_KEY_SECRET_NAME} has changed since it was saved`
    );
  }

  const secret = values.secrets[adapter.secretField];
  if (!secret) {
    throw new WebhookConfigError(
      503,
      `${organization.reference} has no ${adapter.secretField} saved for ${adapter.id}; save it before registering the webhook`
    );
  }

  const requester = values.config[REQUESTER_FIELD];
  if (!requester) {
    throw new WebhookConfigError(
      503,
      `${organization.reference} has no ${REQUESTER_FIELD} saved for ${adapter.id}; ` +
        'webhook-driven imports need a profile to run as'
    );
  }

  await assertRequesterBelongsTo({ medplum, requester, organizationId });

  const tenantId = values.config[TENANT_ID_FIELD]?.trim();

  return {
    organizationId,
    secret,
    requester,
    subscribedEvents: parseEvents(values.config[EVENTS_FIELD]),
    ...(tenantId ? { tenantId } : {}),
  };
}

/**
 * Split the clinic's event allow-list.
 * @param raw - The stored comma-separated value, if any.
 * @returns The event names, or undefined for "all of them".
 */
export function parseEvents(raw: string | undefined): readonly string[] | undefined {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  // Unset and empty both mean "everything the adapter can map". A stored empty
  // string must not mean "nothing", or saving the settings form with the box
  // untouched would quietly switch a clinic's inbound sync off.
  return names.length > 0 ? names : undefined;
}

/**
 * Refuse a requester that is not scoped to this clinic. See the note at the top.
 * @param props - What to check.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.requester - The configured profile reference.
 * @param props.organizationId - The clinic that owns the configuration.
 */
async function assertRequesterBelongsTo(props: {
  medplum: MedplumClient;
  requester: string;
  organizationId: string;
}): Promise<void> {
  const { medplum, requester, organizationId } = props;
  const expected = `Organization/${organizationId}`;

  const memberships = await medplum
    .searchResources('ProjectMembership', `profile=${encodeURIComponent(requester)}&_count=50`)
    .catch(() => []);

  const found = new Set<string>();
  for (const membership of memberships) {
    for (const access of membership.access ?? []) {
      for (const parameter of access.parameter ?? []) {
        const reference = parameter.valueReference?.reference;
        if (parameter.name === 'organization' && reference?.startsWith('Organization/')) {
          found.add(reference);
        }
      }
    }
  }

  if (found.size === 0) {
    throw new WebhookConfigError(
      503,
      `${REQUESTER_FIELD} ${requester} is not scoped to an organization; assign the clinic access policy to it`
    );
  }
  // Exactly one, and it has to be this one. A profile scoped to two clinics
  // cannot say which this delivery is for, and `resolveCallerOrganization`
  // downstream would refuse it anyway — refusing here makes the reason legible.
  if (found.size > 1 || !found.has(expected)) {
    throw new WebhookConfigError(
      503,
      `${REQUESTER_FIELD} ${requester} resolves to ${[...found].join(', ')}, not ${expected}`
    );
  }
}
