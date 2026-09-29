// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The DrChrono authorization-code grant: how a clinic's tokens come to exist.
 *
 * `bots/shared/drchrono.ts` keeps a live connection alive by spending the
 * refresh token. It cannot create one. This module is the other half — the
 * one-time exchange that turns a user's consent into the first
 * access/refresh pair.
 *
 * Two things here are load-bearing and were both learned the hard way in
 * lyfe-provider-ui.
 *
 * **Scopes.** DrChrono accepts `BASE_SCOPE:[read|write]` where BASE_SCOPE is
 * exactly one of seven values. An unrecognized token does not degrade to "that
 * one permission is missing" — it fails the entire `/o/authorize` request with
 * `invalid_scope`. lyfe-provider-ui shipped `messages`, `tasks`, `settings` and
 * the plural `users` for some time, which is why nobody could connect. A
 * separate incident had `calendar:read` missing, which is worse than an error:
 * appointment endpoints returned an empty list rather than a 403, so the sync
 * looked healthy and produced nothing.
 *
 * **State.** The redirect lands on a page anyone can navigate to, carrying a
 * `code` that this bot will exchange for credentials and store against the
 * caller's clinic. Echoing `state` back without checking it is not CSRF
 * protection — it just proves the attacker can copy a string. The nonce is
 * therefore minted here, stored server-side against the clinic, and required to
 * match on return.
 */
import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** DrChrono's authorization endpoint. */
export const DRCHRONO_AUTHORIZE_URL = 'https://drchrono.com/o/authorize';

/** DrChrono's token endpoint. The trailing slash is required. */
export const DRCHRONO_TOKEN_URL = 'https://drchrono.com/o/token/';

/**
 * The only base scopes DrChrono recognizes.
 *
 * From https://app.drchrono.com/api-docs/#section/Authorization/Initial-authorization.
 * Anything outside this list fails the whole authorize request, so it is worth
 * checking against before the user is redirected rather than after.
 */
export const VALID_DRCHRONO_BASE_SCOPES: readonly string[] = [
  'user',
  'calendar',
  'patients',
  'patients:summary',
  'billing',
  'clinical',
  'labs',
];

/**
 * Scopes requested at authorize time.
 *
 * Mirrors `DRCHRONO_CONFIG.scopes` in lyfe-provider-ui after its `invalid_scope`
 * fix. `calendar:read` in particular must stay: without it DrChrono returns an
 * empty appointment list instead of an authorization error, so a sync silently
 * produces nothing.
 *
 * Deliberately a constant rather than a stored config field. This list is the
 * exact thing that has broken twice; a per-clinic override would make the next
 * breakage tenant-specific and much harder to spot.
 */
export const DRCHRONO_SCOPES: readonly string[] = [
  'patients:read',
  'patients:write',
  'clinical:read',
  'clinical:write',
  'calendar:read',
  'calendar:write',
  'billing:read',
  'billing:write',
  'labs:read',
  'labs:write',
  'user:read',
];

/** How long a minted `state` stays usable. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/** State-bucket field holding the pending nonce. */
export const OAUTH_STATE_FIELD = 'oauthState';

/** State-bucket field holding when the pending nonce was minted. */
export const OAUTH_STATE_CREATED_FIELD = 'oauthStateCreatedAt';

/**
 * Reject a scope list DrChrono would refuse.
 *
 * Called before building the redirect so a bad edit surfaces as a readable
 * error here rather than as `invalid_scope` on DrChrono's error page, which
 * does not say which token it disliked.
 * @param props - The scopes to check.
 * @param props.scopes - Scope tokens, each expected to be `base:read` or `base:write`.
 * @throws Error When a token is not a valid DrChrono scope.
 */
export function assertValidDrChronoScopes(props: { scopes: readonly string[] }): void {
  const invalid = props.scopes.filter((scope) => {
    const separator = scope.lastIndexOf(':');
    if (separator < 1) {
      return true;
    }
    const base = scope.slice(0, separator);
    const access = scope.slice(separator + 1);
    return !VALID_DRCHRONO_BASE_SCOPES.includes(base) || (access !== 'read' && access !== 'write');
  });
  if (invalid.length > 0) {
    throw new Error(
      `Invalid DrChrono scope(s): ${invalid.join(', ')}. ` +
        `DrChrono rejects the whole authorize request when any token is unrecognized. ` +
        `Valid base scopes are ${VALID_DRCHRONO_BASE_SCOPES.join(', ')}, each with :read or :write.`
    );
  }
}

/**
 * Mint a fresh, unguessable `state` nonce.
 * @returns 64 hex characters of cryptographic randomness.
 */
export function createOAuthState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Build the URL the clinic user is sent to in order to grant access.
 * @param props - The inputs for the redirect.
 * @param props.clientId - The DrChrono application's client id.
 * @param props.redirectUri - Must match the URI registered with DrChrono exactly.
 * @param props.state - The nonce minted by {@link createOAuthState}.
 * @param props.authorizeUrl - Override for the authorize endpoint; defaults to DrChrono's.
 * @param props.scopes - Override for the requested scopes; defaults to {@link DRCHRONO_SCOPES}.
 * @returns The absolute URL to redirect the user to.
 */
export function buildAuthorizeUrl(props: {
  clientId: string;
  redirectUri: string;
  state: string;
  authorizeUrl?: string;
  scopes?: readonly string[];
}): string {
  const scopes = props.scopes ?? DRCHRONO_SCOPES;
  assertValidDrChronoScopes({ scopes });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: props.clientId,
    redirect_uri: props.redirectUri,
    scope: scopes.join(' '),
    state: props.state,
  });
  return `${props.authorizeUrl || DRCHRONO_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Compare two nonces without leaking where they first differ.
 *
 * A plain `===` on a secret compared byte by byte is a timing oracle. The length
 * check in front is not one: the length is a fixed 64 for every nonce this
 * module mints, so it reveals nothing an attacker does not already know.
 * @param props - The two values to compare.
 * @param props.supplied - The `state` that came back on the redirect.
 * @param props.expected - The `state` stored when the redirect was issued.
 * @returns True when they are identical.
 */
export function statesMatch(props: { supplied: string; expected: string }): boolean {
  const supplied = Buffer.from(props.supplied, 'utf8');
  const expected = Buffer.from(props.expected, 'utf8');
  if (supplied.length !== expected.length || supplied.length === 0) {
    return false;
  }
  return timingSafeEqual(supplied, expected);
}

/**
 * Check a returned `state` against what was stored, including its age.
 *
 * Throws rather than returning false so every rejection reason reaches the
 * operator verbatim: "no authorization in progress" and "this link is stale"
 * need very different responses, and collapsing them into one boolean is how a
 * misconfigured redirect URI gets misdiagnosed as an attack.
 * @param props - The values to check.
 * @param props.supplied - The `state` query parameter from the redirect.
 * @param props.expected - The stored nonce, if any.
 * @param props.createdAt - ISO timestamp of when the nonce was minted, if any.
 * @param props.now - Current time in ms; injectable for tests.
 * @throws Error When the state is missing, stale or does not match.
 */
export function assertOAuthState(props: {
  supplied: string | undefined;
  expected: string | undefined;
  createdAt: string | undefined;
  now?: number;
}): void {
  if (!props.supplied) {
    throw new Error('The DrChrono redirect carried no state parameter. Start the connection again from Integrations.');
  }
  if (!props.expected) {
    throw new Error(
      'No DrChrono authorization is in progress for this clinic. ' +
        'Start the connection again from Integrations — a state can only be used once.'
    );
  }
  if (!statesMatch({ supplied: props.supplied, expected: props.expected })) {
    throw new Error('The DrChrono redirect state did not match. The link was not the one this clinic started.');
  }
  const mintedAt = props.createdAt ? Date.parse(props.createdAt) : Number.NaN;
  const now = props.now ?? Date.now();
  if (Number.isFinite(mintedAt) && now - mintedAt > OAUTH_STATE_TTL_MS) {
    throw new Error(
      `This DrChrono authorization link expired after ${Math.round(OAUTH_STATE_TTL_MS / 60000)} minutes. ` +
        'Start the connection again from Integrations.'
    );
  }
}

/** The pair DrChrono issues in exchange for an authorization code. */
export interface DrChronoTokenPair {
  /** Bearer token for API calls. Expires in roughly 48 hours. */
  readonly accessToken: string;
  /** Token used to mint the next pair. DrChrono rotates this on every use. */
  readonly refreshToken: string;
  /** Lifetime of the access token in seconds, when DrChrono reports one. */
  readonly expiresIn?: number;
}

/**
 * Trade an authorization code for the clinic's first token pair.
 *
 * `redirect_uri` is sent again here and must be byte-identical to the one used
 * at authorize time; DrChrono rejects the exchange otherwise, with an error that
 * reads like a bad code rather than a mismatched URI.
 * @param props - The exchange inputs.
 * @param props.code - The `code` query parameter from the redirect.
 * @param props.clientId - The DrChrono application's client id.
 * @param props.clientSecret - The DrChrono application's client secret.
 * @param props.redirectUri - The same URI used to build the authorize URL.
 * @param props.tokenUrl - Override for the token endpoint; defaults to DrChrono's.
 * @returns The issued access and refresh tokens.
 */
export async function exchangeAuthorizationCode(props: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<DrChronoTokenPair> {
  const res = await fetch(props.tokenUrl || DRCHRONO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: props.code,
      client_id: props.clientId,
      client_secret: props.clientSecret,
      redirect_uri: props.redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    // The body is not logged or surfaced: on some failures DrChrono echoes the
    // submitted code back, and an authorization code is a credential until it
    // is spent. The status plus the two things that are actually usually wrong
    // is more useful than a leaked payload anyway.
    throw new Error(
      `DrChrono rejected the authorization code exchange with ${res.status}. ` +
        'Check that the redirect URI matches the one registered with DrChrono, and that the code has not already been used.'
    );
  }

  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new Error('DrChrono returned no access_token for this authorization code.');
  }
  if (!body.refresh_token) {
    // Storing an access token with no refresh token buys ~48 hours and then a
    // silent outage, so refuse it outright rather than record a connection that
    // is already doomed.
    throw new Error(
      'DrChrono returned no refresh_token for this authorization code. ' +
        'Without it the connection would stop working in about 48 hours, so it has not been saved.'
    );
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
}
