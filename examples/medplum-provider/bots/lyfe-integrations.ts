// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tenant EHR credential management.
 *
 * Actions, as posted by the Integrations settings screen:
 *   getStatus        connection state for every integration, never a secret
 *   saveCredentials  store DrChrono/ZUS credentials for the caller's own clinic
 *   testConnection   prove the stored credentials actually authenticate upstream
 *   authorizeUrl     begin the DrChrono OAuth grant: mint a state, return the consent URL
 *   exchangeCode     finish it: verify the state, trade the code for the first token pair
 *
 * Every action answers with the same envelope:
 *   { ok, message?, integrations: [{ id, status, message?, lastCheckedAt?,
 *                                    config, configuredSecrets }] }
 * `configuredSecrets` is a list of NAMES. No path in this file puts a decrypted
 * secret into a response.
 *
 * THE ORGANIZATION IS NEVER TAKEN FROM THE INPUT
 * ----------------------------------------------
 * Every action resolves the clinic from `event.requester` -- the profile on the
 * caller's own ProjectMembership, set by the server, not by the client -- and
 * reads the `organization` access parameter off that membership. A caller who
 * sends an `organizationId` is rejected outright rather than ignored, so a UI
 * that believes it can choose a tenant fails loudly in development instead of
 * appearing to work.
 *
 * Accepting a client-supplied organization here would be a straight IDOR: any
 * authenticated clinic user could write credentials into, or read connection
 * state out of, a competitor's tenant.
 *
 * AND AMBIGUITY IS AN ERROR, NOT A COIN FLIP
 * ------------------------------------------
 * A membership carrying two different organizations, or a profile with two
 * memberships in different organizations, is refused. The Lyfe DrChrono factory
 * (`createDrChronoServiceForUser`) learned this the hard way: it ordered by
 * `updatedAt` and took the first row, so a user in two clinics silently got
 * whichever clinic's credentials had been saved most recently. That is not a bug
 * this design can have, because there is no "pick one" branch to have it in.
 *
 * This bot runs with its own ProjectMembership, which is what lets it touch
 * `Basic` at all: "Lyfe Clinic Access Policy" is an allow-list and does not list
 * `Basic`, so no clinic user can read a credential record by any route.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Basic, Organization, Reference } from '@medplum/fhirtypes';
import type { Buffer } from 'node:buffer';
import type { IntegrationKey } from './shared/credentials';
import {
  ENCRYPTION_KEY_SECRET_NAME,
  INTEGRATION_KEYS,
  deriveEncryptionKey,
  getCredentialValues,
  parseIntegrationKey,
  readCredentialRecord,
  writeCredentialRecord,
} from './shared/credentials';
import {
  OAUTH_STATE_CREATED_FIELD,
  OAUTH_STATE_FIELD,
  assertOAuthState,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeAuthorizationCode,
} from './shared/drchrono-oauth.ts';
import { resolveCallerOrganization } from './shared/tenant.ts';

/** Fallback DrChrono API base, matching lyfe-provider-ui's DRCHRONO_API. */
const DRCHRONO_API_URL = 'https://app.drchrono.com/api';

/** Fallback ZUS API base. */
const ZUS_API_URL = 'https://api.zusapi.com/fhir';

/** Fallback ZUS token endpoint. */
const ZUS_AUTH_URL = 'https://auth.zusapi.com/oauth/token';

/** What the settings screen renders per integration row. */
interface IntegrationView {
  /** `drchrono` or `zus`. */
  id: IntegrationKey;
  /** Traffic light for the row. */
  status: 'connected' | 'not-connected' | 'error';
  /** One line of explanation for the row. */
  message?: string;
  /** ISO timestamp of the last `testConnection`. */
  lastCheckedAt?: string;
  /** Non-secret configuration, echoed back verbatim. */
  config: Record<string, string>;
  /** Names of the secrets on file. Never values. */
  configuredSecrets: string[];
}

/** The envelope every action returns. */
interface BotResponse {
  /** False when the action itself failed. */
  ok: boolean;
  /** Explanation of the action's outcome. */
  message?: string;
  /** One row per integration, always all of them. */
  integrations: IntegrationView[];
  /** Set only by `authorizeUrl`: where to send the user to grant access. */
  authorizeUrl?: string;
}

interface Input {
  action?: string;
  integration?: string;
  config?: Record<string, string>;
  secrets?: Record<string, string>;
  clear?: string[];
  /** `authorization_code` from the OAuth redirect, for `exchangeCode`. */
  code?: string;
  /** The `state` echoed by the OAuth redirect, for `exchangeCode`. */
  state?: string;
}

/** The per-call tenant context, resolved once in `dispatch`. */
interface TenantContext {
  /** Bot-scoped Medplum client. */
  medplum: MedplumClient;
  /** The caller's organization. */
  organization: Reference<Organization>;
  /** The AES key from project secrets. */
  key: Buffer;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client, running as the bot's membership.
 * @param event - Carries the action, the requester, and the project secrets.
 * @returns The action's result. Never contains a secret value.
 */
export async function handler(medplum: MedplumClient, event: BotEvent<Input>): Promise<BotResponse> {
  try {
    return await dispatch(medplum, event);
  } catch (err) {
    // A refusal is an ordinary outcome here -- an unscoped user, an ambiguous
    // membership, an unknown field -- and the settings screen has to be able to
    // say why. Surface it as a message rather than an opaque 400.
    return { ok: false, message: err instanceof Error ? err.message : String(err), integrations: [] };
  }
}

/**
 * Validate the request, resolve the tenant, then run the action.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - The bot event.
 * @returns The action's result.
 */
async function dispatch(medplum: MedplumClient, event: BotEvent<Input>): Promise<BotResponse> {
  const input = (event.input ?? {}) as Input & { organizationId?: unknown; organization?: unknown };

  // Fail loudly rather than silently ignoring it: a caller that sends this
  // believes it is choosing the tenant, and quietly doing something else is how
  // an IDOR survives code review.
  if (input.organizationId !== undefined || input.organization !== undefined) {
    throw new Error("organizationId is not accepted: the organization comes from the caller's ProjectMembership");
  }

  const key = deriveEncryptionKey({ material: event.secrets[ENCRYPTION_KEY_SECRET_NAME]?.valueString ?? '' });
  const organization = await resolveCallerOrganization({ medplum, requester: event.requester });
  const context: TenantContext = { medplum, organization, key };

  switch (input.action) {
    // The short spellings are accepted too, so a curl one-liner and the
    // settings screen drive exactly the same code.
    case 'getStatus':
    case 'status':
      return { ok: true, integrations: await viewAll(context) };

    case 'saveCredentials':
    case 'save': {
      const integration = parseIntegrationKey({ value: input.integration });
      await writeCredentialRecord({
        medplum: context.medplum,
        organization: context.organization,
        key: context.key,
        integration,
        config: input.config,
        secrets: input.secrets,
        clear: input.clear,
      });
      return { ok: true, message: `Saved ${integration} credentials`, integrations: await viewAll(context) };
    }

    case 'testConnection':
    case 'test': {
      const integration = parseIntegrationKey({ value: input.integration });
      const result = await runConnectionTest({ context, integration });
      return { ok: result.ok, message: result.detail, integrations: await viewAll(context) };
    }

    case 'authorizeUrl':
    case 'authorize': {
      const integration = parseIntegrationKey({ value: input.integration ?? 'drchrono' });
      assertOAuthCapable({ integration });
      const url = await startDrChronoAuthorization({ context });
      return {
        ok: true,
        message: 'Open this URL to grant DrChrono access to this clinic.',
        authorizeUrl: url,
        integrations: await viewAll(context),
      };
    }

    case 'exchangeCode':
    case 'exchange': {
      const integration = parseIntegrationKey({ value: input.integration ?? 'drchrono' });
      assertOAuthCapable({ integration });
      const message = await completeDrChronoAuthorization({ context, code: input.code, state: input.state });
      return { ok: true, message, integrations: await viewAll(context) };
    }

    default:
      throw new Error(
        `Unknown action ${JSON.stringify(input.action)}. ` +
          'Expected getStatus, saveCredentials, testConnection, authorizeUrl or exchangeCode.'
      );
  }
}

/**
 * Build the settings-screen row for every integration.
 * @param context - The tenant context.
 * @returns One row per integration, in a stable order.
 */
async function viewAll(context: TenantContext): Promise<IntegrationView[]> {
  const views: IntegrationView[] = [];
  for (const integration of INTEGRATION_KEYS) {
    const record = await readCredentialRecord({
      medplum: context.medplum,
      organization: context.organization,
      integration,
    });
    views.push(toView({ record, integration, key: context.key }));
  }
  return views;
}

/**
 * Describe one credential record without revealing any secret.
 * @param props - What to describe.
 * @param props.record - The stored record, if any.
 * @param props.integration - Which integration this row is for.
 * @param props.key - The AES key, used only to tell readable from unreadable.
 * @returns The row.
 */
function toView(props: { record: Basic | undefined; integration: IntegrationKey; key: Buffer }): IntegrationView {
  if (!props.record) {
    return { id: props.integration, status: 'not-connected', config: {}, configuredSecrets: [] };
  }

  const values = getCredentialValues({ record: props.record, key: props.key });
  const configuredSecrets = [...Object.keys(values.secrets), ...values.unreadableSecrets].sort((a, b) =>
    a.localeCompare(b)
  );
  const state = values.state;
  const lastCheckedAt = state.lastTestedAt;

  if (values.unreadableSecrets.length > 0) {
    // Deliberately distinct from "not connected". Ciphertext that will not
    // decrypt means the key changed, not that the clinic never connected -- and
    // an operator told the latter will cheerfully overwrite recoverable data.
    return {
      id: props.integration,
      status: 'error',
      message:
        `Stored secret(s) ${values.unreadableSecrets.join(', ')} could not be decrypted. ` +
        `${ENCRYPTION_KEY_SECRET_NAME} has changed since they were saved; re-enter them.`,
      lastCheckedAt,
      config: values.config,
      configuredSecrets,
    };
  }

  if (state.lastTestResult === 'ok') {
    return {
      id: props.integration,
      status: 'connected',
      message: state.lastTestDetail,
      lastCheckedAt,
      config: values.config,
      configuredSecrets,
    };
  }

  return {
    id: props.integration,
    status: state.lastTestResult === 'failed' ? 'error' : 'not-connected',
    message: state.lastTestDetail ?? 'Credentials saved, not yet tested',
    lastCheckedAt,
    config: values.config,
    configuredSecrets,
  };
}

/** Outcome of an upstream authentication attempt. */
interface TestResult {
  /** True when the upstream system accepted the stored credentials. */
  ok: boolean;
  /** Short machine-ish reason, e.g. `http-401` or `missing-credentials`. */
  reason: string;
  /** Human-readable detail. Never contains a secret. */
  detail: string;
}

/**
 * Authenticate against the upstream system with the stored credentials.
 *
 * The outcome is written back onto the record as state, so `getStatus` can
 * answer "is this clinic connected?" without calling DrChrono or ZUS again.
 * @param props - The test inputs.
 * @param props.context - The tenant context.
 * @param props.integration - Which integration to test.
 * @returns The outcome.
 */
async function runConnectionTest(props: { context: TenantContext; integration: IntegrationKey }): Promise<TestResult> {
  const { context, integration } = props;
  const record = await readCredentialRecord({
    medplum: context.medplum,
    organization: context.organization,
    integration,
  });

  if (!record) {
    return { ok: false, reason: 'not-configured', detail: `No ${integration} credentials saved for this clinic` };
  }

  const values = getCredentialValues({ record, key: context.key });
  let result: TestResult;
  if (values.unreadableSecrets.length > 0) {
    result = {
      ok: false,
      reason: 'undecryptable-secret',
      detail: `Stored secret(s) ${values.unreadableSecrets.join(', ')} could not be decrypted`,
    };
  } else if (integration === 'drchrono') {
    result = await testDrChrono({ config: values.config, secrets: values.secrets });
  } else {
    result = await testZus({ config: values.config, secrets: values.secrets });
  }

  await writeCredentialRecord({
    medplum: context.medplum,
    organization: context.organization,
    key: context.key,
    integration,
    state: {
      lastTestedAt: new Date().toISOString(),
      lastTestResult: result.ok ? 'ok' : 'failed',
      lastTestDetail: result.detail,
    },
  });

  return result;
}

/**
 * Call DrChrono with the stored token.
 *
 * `/users/current` is the cheapest authenticated read DrChrono offers and has no
 * side effects, which matters because an operator getting a connection working
 * will press Test repeatedly.
 * @param props - The decrypted credential set.
 * @param props.config - Non-secret configuration.
 * @param props.secrets - Decrypted secrets.
 * @returns The outcome.
 */
async function testDrChrono(props: {
  config: Record<string, string>;
  secrets: Record<string, string>;
}): Promise<TestResult> {
  const apiUrl = (props.config.apiUrl ?? DRCHRONO_API_URL).replace(/\/$/, '');
  const accessToken = props.secrets.accessToken;
  if (!accessToken) {
    return {
      ok: false,
      reason: 'missing-credentials',
      detail: props.secrets.refreshToken
        ? 'A DrChrono refreshToken is stored but no accessToken: complete the OAuth exchange first'
        : 'No DrChrono accessToken stored',
    };
  }

  const res = await fetch(`${apiUrl}/users/current`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.ok) {
    const body = (await res.json()) as { id?: number; username?: string; doctor?: number };
    return {
      ok: true,
      reason: 'ok',
      detail: `Authenticated as DrChrono user ${body.username ?? body.id ?? 'unknown'} (doctor ${body.doctor ?? 'n/a'})`,
    };
  }

  // Deliberately no automatic refresh_token exchange here. DrChrono rotates the
  // refresh token on every use, so a "test" that silently spent it would
  // invalidate the copy the operator is still holding in their setup notes, and
  // turn a diagnostic into a destructive action. Refreshing belongs on the sync
  // path, which persists the new pair.
  return {
    ok: false,
    reason: `http-${res.status}`,
    detail: `DrChrono /users/current returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
  };
}

/**
 * Exchange the stored ZUS client credentials for a token.
 * @param props - The decrypted credential set.
 * @param props.config - Non-secret configuration.
 * @param props.secrets - Decrypted secrets.
 * @returns The outcome.
 */
async function testZus(props: {
  config: Record<string, string>;
  secrets: Record<string, string>;
}): Promise<TestResult> {
  const apiUrl = (props.config.apiUrl ?? ZUS_API_URL).replace(/\/$/, '');

  if (props.config.authMode === 'access_token') {
    const accessToken = props.secrets.accessToken;
    if (!accessToken) {
      return { ok: false, reason: 'missing-credentials', detail: 'authMode is access_token but no accessToken stored' };
    }
    const res = await fetch(`${apiUrl}/Patient?_count=1`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return res.ok
      ? { ok: true, reason: 'ok', detail: 'ZUS accepted the stored access token' }
      : {
          ok: false,
          reason: `http-${res.status}`,
          detail: `ZUS returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
        };
  }

  const clientId = props.secrets.clientId;
  const clientSecret = props.secrets.clientSecret;
  if (!clientId || !clientSecret) {
    return { ok: false, reason: 'missing-credentials', detail: 'ZUS clientId and clientSecret are both required' };
  }

  // lyfe-provider-ui stores authUrl inconsistently: sometimes the bare host,
  // sometimes with /oauth/token already appended. Accept either rather than
  // producing .../oauth/token/oauth/token.
  const base = (props.config.authUrl ?? ZUS_AUTH_URL).replace(/\/$/, '');
  const tokenUrl = base.endsWith('/oauth/token') ? base : `${base}/oauth/token`;

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      // The OAuth audience is the API base without the FHIR path.
      audience: apiUrl.replace(/\/fhir$/, ''),
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    return {
      ok: false,
      reason: `http-${res.status}`,
      detail: `ZUS token endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    return { ok: false, reason: 'no-token', detail: 'ZUS token endpoint returned 200 with no access_token' };
  }
  return { ok: true, reason: 'ok', detail: `ZUS issued a token valid for ${body.expires_in ?? 'unknown'}s` };
}

// ── DrChrono authorization-code grant ────────────────────────────────────────

/**
 * Refuse an OAuth action for an integration that has no authorization-code flow.
 *
 * ZUS authenticates with `client_credentials`: there is no user to send
 * anywhere and no code to exchange. Saying so beats building a consent URL
 * against an endpoint that does not exist.
 * @param props - The integration being acted on.
 * @param props.integration - The parsed integration key.
 * @throws Error When the integration has no authorization-code grant.
 */
function assertOAuthCapable(props: { integration: IntegrationKey }): void {
  if (props.integration !== 'drchrono') {
    throw new Error(
      `${props.integration} does not use an authorization-code grant. ` +
        'Save its client id and secret instead, then run testConnection.'
    );
  }
}

/**
 * Read DrChrono's OAuth settings for the caller's clinic.
 *
 * Every missing piece gets its own message. "Not configured" covering four
 * different causes is what turns a two-minute fix into a support thread.
 * @param props - The lookup inputs.
 * @param props.context - The tenant context.
 * @returns The client credentials, redirect URI, endpoint overrides and stored state.
 */
async function readDrChronoOAuthSettings(props: { context: TenantContext }): Promise<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl?: string;
  tokenUrl?: string;
  state: Record<string, string>;
}> {
  const record = await readCredentialRecord({
    medplum: props.context.medplum,
    organization: props.context.organization,
    integration: 'drchrono',
  });
  const values = getCredentialValues({ record, key: props.context.key });

  if (values.unreadableSecrets.length > 0) {
    throw new Error(
      `Stored DrChrono secret(s) ${values.unreadableSecrets.join(', ')} cannot be decrypted. ` +
        'The encryption key has changed — re-enter the client id and secret before connecting.'
    );
  }

  const clientId = values.secrets.clientId;
  const clientSecret = values.secrets.clientSecret;
  const redirectUri = values.config.redirectUri;

  if (!clientId || !clientSecret) {
    throw new Error('Save the DrChrono client id and secret before connecting.');
  }
  if (!redirectUri) {
    throw new Error(
      'Set the DrChrono redirect URI before connecting. It must match the one registered on the ' +
        'DrChrono application exactly, e.g. https://<your-app-host>/integrations/drchrono/callback'
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    authUrl: values.config.authUrl || undefined,
    tokenUrl: values.config.tokenUrl || undefined,
    state: values.state,
  };
}

/**
 * Begin the grant: mint a state nonce, store it, and build the consent URL.
 *
 * The nonce is stored against the clinic rather than handed to the browser to
 * give back, because a value the client both supplies and validates proves
 * nothing. Minting a new one supersedes any previous pending authorization,
 * which is the behaviour you want when someone abandons the flow and retries.
 * @param props - The call inputs.
 * @param props.context - The tenant context.
 * @returns The absolute DrChrono URL to send the user to.
 */
async function startDrChronoAuthorization(props: { context: TenantContext }): Promise<string> {
  const settings = await readDrChronoOAuthSettings({ context: props.context });
  const state = createOAuthState();

  await writeCredentialRecord({
    medplum: props.context.medplum,
    organization: props.context.organization,
    integration: 'drchrono',
    state: { [OAUTH_STATE_FIELD]: state, [OAUTH_STATE_CREATED_FIELD]: new Date().toISOString() },
    key: props.context.key,
  });

  return buildAuthorizeUrl({
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
    state,
    authorizeUrl: settings.authUrl,
  });
}

/**
 * Finish the grant: verify the state, spend the code, store the token pair.
 *
 * The nonce is consumed in its own write BEFORE the code is exchanged. Doing it
 * afterwards leaves a window in which two callbacks — a double-clicked link, a
 * replayed URL — both pass validation, and the second one's write would land on
 * top of the first with a code DrChrono has already invalidated. The cost is
 * that a failed exchange requires restarting from Connect, which is the right
 * trade for a credential-granting endpoint.
 * @param props - The call inputs.
 * @param props.context - The tenant context.
 * @param props.code - The `code` query parameter from the redirect.
 * @param props.state - The `state` query parameter from the redirect.
 * @returns A message describing what was stored.
 */
async function completeDrChronoAuthorization(props: {
  context: TenantContext;
  code: string | undefined;
  state: string | undefined;
}): Promise<string> {
  const code = typeof props.code === 'string' ? props.code.trim() : '';
  if (!code) {
    throw new Error('The DrChrono redirect carried no authorization code.');
  }

  const settings = await readDrChronoOAuthSettings({ context: props.context });
  assertOAuthState({
    supplied: props.state,
    expected: settings.state[OAUTH_STATE_FIELD],
    createdAt: settings.state[OAUTH_STATE_CREATED_FIELD],
  });

  await writeCredentialRecord({
    medplum: props.context.medplum,
    organization: props.context.organization,
    integration: 'drchrono',
    clearState: [OAUTH_STATE_FIELD, OAUTH_STATE_CREATED_FIELD],
    key: props.context.key,
  });

  const pair = await exchangeAuthorizationCode({
    code,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    redirectUri: settings.redirectUri,
    tokenUrl: settings.tokenUrl,
  });

  await writeCredentialRecord({
    medplum: props.context.medplum,
    organization: props.context.organization,
    integration: 'drchrono',
    secrets: { accessToken: pair.accessToken, refreshToken: pair.refreshToken },
    state: {
      lastAuthorizedAt: new Date().toISOString(),
      ...(pair.expiresIn ? { accessTokenExpiresAt: new Date(Date.now() + pair.expiresIn * 1000).toISOString() } : {}),
    },
    key: props.context.key,
  });

  return 'DrChrono connected. Access and refresh tokens are stored for this clinic.';
}
