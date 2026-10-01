// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Organization, Reference } from '@medplum/fhirtypes';
import { getCredentialValues, readCredentialRecord, writeCredentialRecord } from './credentials.ts';

/**
 * An authenticated DrChrono client for one clinic, with token refresh.
 *
 * DrChrono access tokens expire in roughly 48 hours, so a stored token is not a
 * durable credential. The refresh exchange is what makes the integration keep
 * working, and it has one property that dictates the whole design: **DrChrono
 * rotates the refresh token on every use**. The response carries a new
 * `refresh_token` and the old one stops working immediately. Lose the rotated
 * value — by failing to persist it, or by two runs refreshing at once — and the
 * clinic's connection is bricked until a human redoes the OAuth grant.
 *
 * So:
 * - the rotated pair is written back to the credential record before the retried
 *   request is issued, never after, so a crash mid-retry cannot lose it;
 * - a refresh happens at most once per client instance, so a genuinely revoked
 *   token surfaces as a 401 rather than spending refresh tokens in a loop.
 *
 * This is the same contract lyfe-provider-ui implements with its
 * `onTokenRefresh` callback persisting to the credential row; here the store is
 * the per-Organization credential record.
 */

const TOKEN_URL = 'https://drchrono.com/o/token/';

/**
 * A write to DrChrono: a method other than GET, and a JSON body.
 *
 * Retrying a write after a token refresh is safe only because a 401 means the
 * request was rejected before DrChrono looked at the body — nothing was created.
 * Any other failure is returned to the caller unretried.
 */
export interface DrChronoRequest {
  method: 'POST' | 'PATCH' | 'PUT';
  /** Serialised as JSON with the matching `Content-Type`. */
  body: unknown;
}

export interface DrChronoClient {
  /** Issue an authenticated request, refreshing once on a 401. GET unless `request` says otherwise. */
  readonly fetch: (path: string, request?: DrChronoRequest) => Promise<Response>;
  /** True when this client had to refresh, i.e. the stored pair was rotated. */
  readonly didRefresh: () => boolean;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Build a DrChrono client bound to one clinic's stored credentials.
 * @param props - Component inputs.
 * @param props.medplum - Client used to read and write the credential record.
 * @param props.organization - The clinic whose credentials to use.
 * @param props.key - AES key for decrypting and re-encrypting the stored pair.
 * @returns A client that refreshes and persists rotated tokens transparently.
 */
export async function createDrChronoClient(props: {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  key: Buffer;
}): Promise<DrChronoClient> {
  const { medplum, organization, key } = props;

  const record = await readCredentialRecord({ medplum, organization, integration: 'drchrono' });
  if (!record) {
    throw new Error('DrChrono is not configured for this organization');
  }

  const values = getCredentialValues({ record, key });
  if (values.unreadableSecrets.length > 0) {
    throw new Error(
      `DrChrono credentials cannot be decrypted (${values.unreadableSecrets.join(', ')}). ` +
        'The encryption key has changed — re-enter them in Integrations.'
    );
  }

  const apiUrl = values.config.apiUrl || 'https://app.drchrono.com/api';
  let accessToken = values.secrets.accessToken;
  let refreshed = false;

  /**
   * Spend the refresh token and persist the rotated pair.
   * @returns The new access token.
   */
  async function refresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = values.secrets;
    if (!refreshToken) {
      throw new Error('DrChrono access token expired and no refresh token is stored. Reconnect in Integrations.');
    }
    if (!clientId || !clientSecret) {
      throw new Error('DrChrono client id and secret are required to refresh the access token.');
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!res.ok) {
      // Never log the body — it carries live tokens on success and can echo the
      // refresh token on failure.
      throw new Error(`DrChrono token refresh failed with ${res.status}. The grant may have been revoked.`);
    }

    const body = (await res.json()) as TokenResponse;
    if (!body.access_token) {
      throw new Error('DrChrono token refresh returned no access_token.');
    }

    // Persist BEFORE retrying. DrChrono has already invalidated the old refresh
    // token at this point, so anything that loses the new one loses the grant.
    await writeCredentialRecord({
      medplum,
      organization,
      integration: 'drchrono',
      secrets: {
        accessToken: body.access_token,
        // Absent means unchanged in the store, which is wrong here: if DrChrono
        // did not return one we must keep the existing value explicitly rather
        // than let a later read find a stale pair.
        refreshToken: body.refresh_token ?? refreshToken,
      },
      state: {
        lastTokenRefreshAt: new Date().toISOString(),
        ...(body.expires_in
          ? { accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString() }
          : {}),
      },
      key,
    });

    values.secrets.refreshToken = body.refresh_token ?? refreshToken;
    accessToken = body.access_token;
    refreshed = true;
    return body.access_token;
  }

  const call = async (path: string, token: string, request?: DrChronoRequest): Promise<Response> =>
    fetch(path.startsWith('http') ? path : `${apiUrl}${path}`, {
      method: request?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(request && { 'Content-Type': 'application/json' }),
      },
      ...(request && { body: JSON.stringify(request.body) }),
    });

  return {
    fetch: async (path: string, request?: DrChronoRequest): Promise<Response> => {
      if (!accessToken) {
        accessToken = await refresh();
      }
      const first = await call(path, accessToken, request);
      if (first.status !== 401 || refreshed) {
        return first;
      }
      return call(path, await refresh(), request);
    },
    didRefresh: () => refreshed,
  };
}
