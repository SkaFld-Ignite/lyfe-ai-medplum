// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tenant EHR credential storage for bots.
 *
 * WHERE CREDENTIALS LIVE
 * ----------------------
 * One `Basic` resource per (Organization, integration) pair:
 *
 *   identifier  https://lyfe.health/integration | "drchrono" | "zus"
 *   subject     Organization/<id>          (the lookup key)
 *   meta.account Organization/<id>         (the compartment)
 *   extension   .../config/<name>  plaintext, non-secret configuration
 *               .../secret/<name>  AES-256-GCM ciphertext
 *               .../state/<name>   bot-written connection state
 *
 * `Basic` is deliberately absent from "Lyfe Clinic Access Policy". Medplum
 * access policies are allow-lists, so a clinic user cannot read these records at
 * all, whatever compartment they are in — only a bot running with its own
 * project membership can. The compartment is defence in depth, not the fence.
 *
 * WHY THE (ORG, INTEGRATION) PAIR IS UNIQUE, AND WHY A SECOND ROW IS FATAL
 * -----------------------------------------------------------------------
 * The Lyfe Prisma implementation this replaces looked credentials up with
 * `orderBy: { updatedAt: 'desc' }` and took `[0]`. When the filter was not tight
 * enough, that silently handed one tenant another tenant's credentials — the
 * row that happened to be saved last. Nothing failed; the wrong clinic's data
 * simply came back. Every lookup here therefore reads ALL matches and throws on
 * more than one. Never add an `orderBy` and a `[0]` to this file.
 */
import type { MedplumClient } from '@medplum/core';
import type { Basic, Extension, Organization, Reference } from '@medplum/fhirtypes';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Identifier and extension namespace for every credential record. */
export const INTEGRATION_SYSTEM = 'https://lyfe.health/integration';

/** Extension url prefix for non-secret configuration, stored in the clear. */
export const CONFIG_PREFIX = `${INTEGRATION_SYSTEM}/config/`;

/** Extension url prefix for encrypted secrets. */
export const SECRET_PREFIX = `${INTEGRATION_SYSTEM}/secret/`;

/** Extension url prefix for bot-written connection state. */
export const STATE_PREFIX = `${INTEGRATION_SYSTEM}/state/`;

/** Project secret holding the AES key. */
export const ENCRYPTION_KEY_SECRET_NAME = 'LYFE_CREDENTIAL_ENCRYPTION_KEY';

/**
 * Field allow-lists, one per integration.
 *
 * These are allow-lists for the same reason the access policy is: a name that is
 * not listed is rejected rather than stored. That keeps a typo ("clientsecret")
 * from being silently written as a plaintext config field and then read back as
 * "not configured", and it keeps a secret from ever landing in the `config`
 * bucket, where it would be returned by `status` in the clear.
 */
export interface IntegrationSchema {
  /** Non-secret field names, stored as plaintext. */
  readonly config: readonly string[];
  /** Secret field names, stored encrypted. */
  readonly secrets: readonly string[];
}

/**
 * Field names mirror `OrganizationDrChronoMetadata` and `OrganizationZusMetadata`
 * in lyfe-provider-ui, minus the `drchrono`/`zus` prefix that the identifier
 * already carries, and minus the plaintext `*ClientSecret` fields that exist
 * there only as a migration fallback.
 */
const DECLARED_SCHEMAS = {
  drchrono: {
    config: ['apiUrl', 'authUrl', 'tokenUrl', 'redirectUri', 'defaultDoctorId', 'environment', 'scopes'],
    // `clientId` is not really a secret, but the Integrations UI posts it in the
    // `secrets` bag alongside the client secret, and a field must live in
    // exactly one bucket. Encrypting it costs nothing; classifying it as config
    // would make every save from the UI fail validation.
    secrets: ['clientId', 'clientSecret', 'accessToken', 'refreshToken'],
  },
  zus: {
    config: [
      'apiUrl',
      'authUrl',
      'builderId',
      'builderName',
      'packageId',
      'practitionerNpi',
      'practitionerRole',
      'practiceName',
      'environment',
      'authMode',
    ],
    secrets: ['clientId', 'clientSecret', 'accessToken'],
  },
} as const satisfies Record<string, IntegrationSchema>;

/**
 * Configuration every integration gets, whether or not it declares it.
 *
 * An inbound webhook is not a DrChrono feature, it is an integration feature, so
 * the fields that drive one are merged into every schema rather than copied into
 * each. A provider added to {@link DECLARED_SCHEMAS} is webhook-capable the
 * moment it exists, with no second list to remember — which is precisely the
 * edit-in-four-places that the inbound rewrite exists to remove.
 *
 * `webhookRequester` names the profile that webhook-driven work runs as, e.g.
 * `Practitioner/abc`. It is a lookup key, not a grant: the receiver re-resolves
 * that profile's own ProjectMembership and refuses the delivery unless the
 * profile is scoped to the same organization that owns this record. So a clinic
 * admin writing another clinic's practitioner here buys nothing.
 *
 * `webhookEvents` is an optional comma-separated allow-list of provider event
 * names. Empty means "every event this provider's adapter can map", which is the
 * right default when the provider's own console already decides what it sends.
 *
 * `webhookTenantId` is the provider's own id for this clinic — DrChrono's
 * `practice_group_id`, for instance. Optional, and when set the receiver refuses
 * a delivery whose payload claims a different tenant. That is the only check
 * that catches a callback URL *and* secret copied from another clinic, which
 * otherwise verifies perfectly and imports the wrong practice's patients.
 */
export const WEBHOOK_CONFIG_FIELDS = ['webhookRequester', 'webhookEvents', 'webhookTenantId'] as const;

/** Secret fields every integration gets. See {@link WEBHOOK_CONFIG_FIELDS}. */
export const WEBHOOK_SECRET_FIELDS = ['webhookSecret'] as const;

/**
 * The scheduled new-patient discovery pass, per clinic.
 *
 * Here rather than in a new resource for the same reason the webhook fields
 * are: a clinic that has DrChrono configured and a clinic that has DrChrono
 * discovery configured are the same clinic, and splitting them would mean two
 * records to keep in step and a second thing to delete when a practice leaves.
 * Nothing here is clinical, nothing here is secret, and none of it needs a
 * profile, a data type or a migration.
 *
 * Every field is optional and every default is the cautious one. Specifically
 * `discoveryEnabled` is **off unless the stored value says otherwise**: a
 * scheduled job that starts importing real patients the moment it deploys is
 * not a feature, and "the record exists" must never be read as consent.
 *
 * - `discoveryEnabled` — `true` to run the pass for this clinic. Anything else,
 *   including absent, means no.
 * - `discoveryLookaheadDays` — how far past today the window reaches, in days.
 *   `0` is today only.
 * - `discoveryReason` — the free-text phrase an appointment's Reason must
 *   contain. Blank means every appointment, so a clinic enabling discovery
 *   without setting this imports its whole schedule; the pass therefore refuses
 *   to run without it. See `onboarding-discovery.ts`.
 * - `discoveryRequester` — the profile the unattended run acts as, e.g.
 *   `Practitioner/abc`. A lookup key and not a grant, re-resolved against this
 *   clinic exactly as `webhookRequester` is; falls back to `webhookRequester`
 *   when unset, since a clinic that has already named a profile for unattended
 *   inbound work has answered this question.
 * - `discoveryMaxPatients` — the most patients one pass may queue. A ceiling,
 *   not a target: it bounds what an unattended run can do to a practice's
 *   DrChrono quota on the day somebody opens a six-month window by mistake.
 * - `discoveryTimeZone` — the IANA zone "today" is read in. A clinic in
 *   Anaheim does not get tomorrow's schedule because the worker is on UTC.
 */
export const DISCOVERY_CONFIG_FIELDS = [
  'discoveryEnabled',
  'discoveryLookaheadDays',
  'discoveryReason',
  'discoveryRequester',
  'discoveryMaxPatients',
  'discoveryTimeZone',
] as const;

/** Field allow-lists per integration, with the universal fields folded in. */
export const INTEGRATION_SCHEMAS: Record<string, IntegrationSchema> = Object.fromEntries(
  Object.entries(DECLARED_SCHEMAS).map(([key, schema]) => [
    key,
    {
      config: [...schema.config, ...WEBHOOK_CONFIG_FIELDS, ...DISCOVERY_CONFIG_FIELDS],
      secrets: [...schema.secrets, ...WEBHOOK_SECRET_FIELDS],
    },
  ])
);

/** The integrations this module knows how to store. */
export type IntegrationKey = keyof typeof DECLARED_SCHEMAS;

/**
 * Every integration key, for input validation.
 *
 * Derived from {@link DECLARED_SCHEMAS} rather than written out a second time.
 * The two drifting apart would mean an integration that can be saved but never
 * listed, or listed but never saved.
 */
export const INTEGRATION_KEYS: readonly IntegrationKey[] = Object.keys(DECLARED_SCHEMAS) as IntegrationKey[];

/** A decrypted credential set, ready to authenticate with. */
export interface CredentialValues {
  /** Plaintext configuration, keyed by field name. */
  readonly config: Record<string, string>;
  /** Decrypted secrets, keyed by field name. */
  readonly secrets: Record<string, string>;
  /** Bot-written state, such as the last connection test result. */
  readonly state: Record<string, string>;
  /** Secret field names whose ciphertext could not be decrypted. */
  readonly unreadableSecrets: string[];
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_SALT = 'lyfe-medplum-credential-salt-v1';
const HEX_KEY_LENGTH = KEY_LENGTH * 2;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Memoized scrypt output, keyed on the material it was derived from.
 *
 * `scryptSync` costs tens of milliseconds and the key is needed on every
 * encrypt and decrypt, so a single `save` of four secrets would otherwise pay
 * the KDF four times. Deriving the same key from the same input always yields
 * the same bytes, so caching is safe; keying the cache on the source material
 * means a rotated key still re-derives rather than serving the previous one.
 *
 * A VM-context bot is evaluated fresh per execution, so this cache lives for one
 * bot run. That is the point at which it pays for itself.
 */
let derivedKeyCache: { cacheKey: string; derived: Buffer } | null = null;

/**
 * Turn the project secret into 32 key bytes.
 * @param props - Holds the raw secret value.
 * @param props.material - The `LYFE_CREDENTIAL_ENCRYPTION_KEY` project secret.
 * @returns The 32-byte AES key.
 */
export function deriveEncryptionKey(props: { material: string }): Buffer {
  const material = props.material;
  if (!material) {
    throw new Error(`${ENCRYPTION_KEY_SECRET_NAME} is not set in project secrets`);
  }

  // 64 hex characters is exactly 32 bytes of entropy, which is what
  // scripts/seed-credential-key.ts writes. Use it directly.
  if (material.length === HEX_KEY_LENGTH && /^[0-9a-fA-F]+$/.test(material)) {
    return Buffer.from(material, 'hex');
  }

  if (material.length < KEY_LENGTH) {
    throw new Error(
      `${ENCRYPTION_KEY_SECRET_NAME} is shorter than ${KEY_LENGTH} characters. ` +
        'Generate a real key with scripts/seed-credential-key.ts.'
    );
  }

  const cacheKey = `${KEY_SALT}:${material}`;
  if (derivedKeyCache?.cacheKey === cacheKey) {
    return derivedKeyCache.derived;
  }
  const derived = scryptSync(material, KEY_SALT, KEY_LENGTH);
  derivedKeyCache = { cacheKey, derived };
  return derived;
}

/**
 * Encrypt one secret.
 * @param props - The plaintext and the key to use.
 * @param props.plaintext - The value to protect.
 * @param props.key - The 32-byte AES key.
 * @returns `iv:tag:ciphertext`, all hex.
 */
export function encryptSecret(props: { plaintext: string; key: Buffer }): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, props.key, iv);
  const encrypted = cipher.update(props.plaintext, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

/**
 * Decrypt one secret.
 * @param props - The ciphertext and the key to use.
 * @param props.ciphertext - An `iv:tag:ciphertext` string from {@link encryptSecret}.
 * @param props.key - The 32-byte AES key.
 * @returns The plaintext.
 */
export function decryptSecret(props: { ciphertext: string; key: Buffer }): string {
  const parts = props.ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }
  const decipher = createDecipheriv(ALGORITHM, props.key, Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  return decipher.update(parts[2], 'hex', 'utf8') + decipher.final('utf8');
}

/**
 * Validate an integration key supplied by a caller.
 * @param props - Holds the unvalidated value.
 * @param props.value - The candidate integration key.
 * @returns The value, narrowed.
 */
export function parseIntegrationKey(props: { value: unknown }): IntegrationKey {
  const value = props.value;
  if (typeof value === 'string' && (INTEGRATION_KEYS as readonly string[]).includes(value)) {
    return value as IntegrationKey;
  }
  throw new Error(`Unknown integration ${JSON.stringify(value)}. Expected one of: ${INTEGRATION_KEYS.join(', ')}`);
}

/**
 * Read every extension under one prefix into a flat record.
 * @param props - The record and the prefix to collect.
 * @param props.record - The credential record, if one exists.
 * @param props.prefix - One of the `*_PREFIX` constants.
 * @returns Field name to value.
 */
function collect(props: { record: Basic | undefined; prefix: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ext of props.record?.extension ?? []) {
    if (ext.url?.startsWith(props.prefix) && typeof ext.valueString === 'string') {
      out[ext.url.slice(props.prefix.length)] = ext.valueString;
    }
  }
  return out;
}

/**
 * Find the single credential record for an organization and integration.
 *
 * Reads every match and refuses to choose between two, rather than taking the
 * most recently updated one. See the note at the top of this file.
 * @param props - Identifies the record.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The owning organization.
 * @param props.integration - Which integration to read.
 * @returns The record, or undefined when the organization has never saved one.
 */
export async function readCredentialRecord(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  /**
   * Which integration to read.
   *
   * Deliberately a plain string rather than {@link IntegrationKey}. The inbound
   * webhook receiver resolves a provider from its own adapter registry, and must
   * be able to read that provider's record without this module having to know
   * the registry exists. Widening a *read* is safe: the value only ever reaches
   * a search query and an error message. A *write* stays narrow, because it
   * validates field names against a schema that has to exist.
   */
  integration: string;
}): Promise<Basic | undefined> {
  const matches = await props.medplum.searchResources(
    'Basic',
    `identifier=${encodeURIComponent(INTEGRATION_SYSTEM)}|${props.integration}` +
      `&subject=${encodeURIComponent(props.organization.reference as string)}&_count=10`
  );

  if (matches.length > 1) {
    throw new Error(
      `${matches.length} ${props.integration} credential records exist for ${props.organization.reference} ` +
        `(${matches.map((m) => m.id).join(', ')}). Refusing to guess which one is current — ` +
        'delete the duplicates before using this integration.'
    );
  }
  return matches[0];
}

/**
 * Decrypt a credential record.
 *
 * A secret that will not decrypt is reported in `unreadableSecrets` rather than
 * being dropped. lyfe-provider-ui's Zus config falls back to a plaintext copy in
 * that situation, because it was migrating live tenants off plaintext and a hard
 * cutover would have taken a clinic offline with no undo. Here there is no
 * plaintext copy to fall back to and never was, so the honest outcome is a
 * distinguishable error: "the key is wrong" must not look like "not configured",
 * or an operator will cheerfully overwrite good ciphertext.
 * @param props - The record and the key.
 * @param props.record - The credential record, if one exists.
 * @param props.key - The 32-byte AES key.
 * @returns Config, decrypted secrets, and any secret that failed to decrypt.
 */
export function getCredentialValues(props: { record: Basic | undefined; key: Buffer }): CredentialValues {
  const config = collect({ record: props.record, prefix: CONFIG_PREFIX });
  const secrets: Record<string, string> = {};
  const unreadableSecrets: string[] = [];

  for (const [name, ciphertext] of Object.entries(collect({ record: props.record, prefix: SECRET_PREFIX }))) {
    try {
      secrets[name] = decryptSecret({ ciphertext, key: props.key });
    } catch {
      unreadableSecrets.push(name);
    }
  }

  return { config, secrets, state: collect({ record: props.record, prefix: STATE_PREFIX }), unreadableSecrets };
}

/**
 * The plaintext configuration on a credential record, without the key.
 *
 * {@link getCredentialValues} is the usual way in and needs the AES key,
 * because it decrypts. A caller that only wants to know whether a clinic has
 * switched a feature on should not have to hold the key to find out — and the
 * scheduled discovery pass enumerates every clinic before it knows which ones
 * it will act for, so making that read require decryption would mean
 * decrypting four tenants' OAuth tokens to answer a yes/no question about one.
 * @param record - The credential record, if one exists.
 * @returns Plaintext config fields, keyed by name.
 */
export function getConfigValues(record: Basic | undefined): Record<string, string> {
  return collect({ record, prefix: CONFIG_PREFIX });
}

/**
 * Reject a field name that the integration does not declare.
 * @param props - The name to check.
 * @param props.integration - Which integration is being written.
 * @param props.name - The submitted field name.
 * @param props.kind - Which bucket it was submitted in.
 */
function assertKnownField(props: { integration: IntegrationKey; name: string; kind: 'config' | 'secrets' }): void {
  const schema = INTEGRATION_SCHEMAS[props.integration];
  if (schema[props.kind].includes(props.name)) {
    return;
  }
  const otherKind = props.kind === 'config' ? 'secrets' : 'config';
  if (schema[otherKind].includes(props.name)) {
    throw new Error(`${props.integration}.${props.name} must be supplied as "${otherKind}", not "${props.kind}"`);
  }
  throw new Error(
    `Unknown ${props.integration} ${props.kind} field "${props.name}". ` +
      `Allowed: ${schema[props.kind].join(', ') || '(none)'}`
  );
}

/**
 * Create or update the credential record for an organization.
 *
 * Merges: a field that is not supplied — or supplied empty — keeps its stored
 * value, so a caller can rotate one secret without re-sending the rest, and a
 * settings form with blanked-out password boxes cannot destroy a working
 * connection. Removal is explicit, through `clear`.
 * @param props - What to write.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.organization - The owning organization, derived from the caller.
 * @param props.integration - Which integration to write.
 * @param props.config - Non-secret fields to merge in.
 * @param props.secrets - Secret fields to encrypt and merge in.
 * @param props.state - Bot-written state to merge in.
 * @param props.clear - Field names to remove outright, config or secret.
 * @param props.clearState - State field names to remove outright.
 * @param props.key - The 32-byte AES key.
 * @returns The saved record.
 */
export async function writeCredentialRecord(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  integration: IntegrationKey;
  config?: Record<string, string>;
  secrets?: Record<string, string>;
  state?: Record<string, string>;
  clear?: string[];
  clearState?: string[];
  key: Buffer;
}): Promise<Basic> {
  const existing = await readCredentialRecord({
    medplum: props.medplum,
    organization: props.organization,
    integration: props.integration,
  });

  const merged = new Map<string, string>();
  for (const ext of existing?.extension ?? []) {
    if (ext.url && typeof ext.valueString === 'string') {
      merged.set(ext.url, ext.valueString);
    }
  }

  const apply = (
    prefix: string,
    values: Record<string, string> | undefined,
    transform?: (v: string) => string
  ): void => {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!FIELD_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid field name "${name}": expected letters and digits only`);
      }
      if (prefix !== STATE_PREFIX) {
        assertKnownField({
          integration: props.integration,
          name,
          kind: prefix === SECRET_PREFIX ? 'secrets' : 'config',
        });
      }
      if (typeof value !== 'string') {
        throw new Error(`Field "${name}" must be a string`);
      }
      // An empty value means "leave it alone", NOT "clear it". The settings form
      // renders a stored secret as an empty password box, so treating empty as a
      // delete would silently wipe a working DrChrono connection the moment
      // someone saved a change to the practice name. Clearing is explicit, via
      // `clear`.
      if (value === '') {
        continue;
      }
      merged.set(`${prefix}${name}`, transform ? transform(value) : value);
    }
  };

  apply(CONFIG_PREFIX, props.config);
  apply(SECRET_PREFIX, props.secrets, (value) => encryptSecret({ plaintext: value, key: props.key }));
  apply(STATE_PREFIX, props.state);

  for (const name of props.clear ?? []) {
    merged.delete(`${CONFIG_PREFIX}${name}`);
    merged.delete(`${SECRET_PREFIX}${name}`);
  }

  // Separate from `clear` on purpose. State is bot-written bookkeeping, not
  // something a caller names, and the OAuth nonce has to be consumable in the
  // same write that stores the tokens — a single-use value that survives its
  // own redemption is not single-use.
  for (const name of props.clearState ?? []) {
    merged.delete(`${STATE_PREFIX}${name}`);
  }

  const extension: Extension[] = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, valueString]) => ({ url, valueString }));

  const body: Basic = {
    ...existing,
    resourceType: 'Basic',
    meta: {
      ...existing?.meta,
      // Deprecated in favour of meta.accounts, but still the field Medplum
      // normalises from, and the one the surrounding Lyfe tooling reads.
      account: props.organization,
      accounts: [props.organization],
    },
    identifier: [{ system: INTEGRATION_SYSTEM, value: props.integration }],
    code: {
      coding: [{ system: INTEGRATION_SYSTEM, code: props.integration }],
      text: `${props.integration} credentials`,
    },
    subject: props.organization,
    // Basic.created is a FHIR `date`, not a `dateTime` — a full timestamp fails
    // validation under this project's strictMode.
    created: existing?.created ?? new Date().toISOString().slice(0, 10),
    extension,
  };

  return existing
    ? props.medplum.updateResource<Basic>({ ...body, id: existing.id })
    : props.medplum.createResource<Basic>(body);
}
