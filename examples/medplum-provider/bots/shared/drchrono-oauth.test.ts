// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The two things in the DrChrono grant that fail silently, pinned.
 *
 * Neither of these is caught by types, and neither announces itself at runtime:
 * a wrong scope list fails the authorize request with `invalid_scope` and no
 * indication of which token was wrong, and a state check that is subtly wrong
 * still lets the happy path through. Both have cost real debugging time in
 * lyfe-provider-ui already, which is the argument for testing them here rather
 * than finding out from a clinic that cannot connect.
 */
import { describe, expect, test } from 'vitest';
import {
  DRCHRONO_AUTHORIZE_URL,
  DRCHRONO_SCOPES,
  OAUTH_STATE_TTL_MS,
  assertOAuthState,
  assertValidDrChronoScopes,
  buildAuthorizeUrl,
  createOAuthState,
  statesMatch,
} from './drchrono-oauth.ts';

describe('DrChrono scopes', () => {
  test('the shipped list is one DrChrono will accept', () => {
    expect(() => assertValidDrChronoScopes({ scopes: DRCHRONO_SCOPES })).not.toThrow();
  });

  test('calendar:read is present', () => {
    // Without it DrChrono returns an empty appointment list rather than a 403,
    // so the sync looks healthy and produces nothing.
    expect(DRCHRONO_SCOPES).toContain('calendar:read');
  });

  test.each(['messages:read', 'tasks:write', 'settings:read', 'users:read'])(
    'rejects %s, which is not a DrChrono scope',
    (scope) => {
      expect(() => assertValidDrChronoScopes({ scopes: [scope] })).toThrow(/Invalid DrChrono scope/);
    }
  );

  test('rejects a base scope with no access level', () => {
    expect(() => assertValidDrChronoScopes({ scopes: ['patients'] })).toThrow(/Invalid DrChrono scope/);
  });

  test('accepts patients:summary:read, whose base itself contains a colon', () => {
    expect(() => assertValidDrChronoScopes({ scopes: ['patients:summary:read'] })).not.toThrow();
  });
});

describe('state nonce', () => {
  test('is 64 hex characters and never repeats', () => {
    const first = createOAuthState();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toEqual(createOAuthState());
  });

  test('matches itself and nothing else', () => {
    const state = createOAuthState();
    expect(statesMatch({ supplied: state, expected: state })).toBe(true);
    expect(statesMatch({ supplied: state, expected: createOAuthState() })).toBe(false);
    expect(statesMatch({ supplied: state, expected: state.slice(0, 10) })).toBe(false);
  });

  test('two empty strings are not a match', () => {
    // Otherwise a cleared nonce would validate against a redirect that omitted it.
    expect(statesMatch({ supplied: '', expected: '' })).toBe(false);
  });
});

describe('assertOAuthState', () => {
  const now = Date.now();
  const state = createOAuthState();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

  test('accepts a fresh, matching state', () => {
    expect(() => assertOAuthState({ supplied: state, expected: state, createdAt: iso(0), now })).not.toThrow();
  });

  test('rejects a redirect with no state at all', () => {
    expect(() => assertOAuthState({ supplied: undefined, expected: state, createdAt: iso(0), now })).toThrow(
      /no state parameter/
    );
  });

  test('rejects a state that was already consumed', () => {
    expect(() => assertOAuthState({ supplied: state, expected: undefined, createdAt: undefined, now })).toThrow(
      /No DrChrono authorization is in progress/
    );
  });

  test('rejects a forged state', () => {
    expect(() => assertOAuthState({ supplied: createOAuthState(), expected: state, createdAt: iso(0), now })).toThrow(
      /did not match/
    );
  });

  test('rejects a state older than the TTL', () => {
    expect(() =>
      assertOAuthState({ supplied: state, expected: state, createdAt: iso(-OAUTH_STATE_TTL_MS - 1000), now })
    ).toThrow(/expired/);
  });

  test('accepts one just inside the TTL', () => {
    expect(() =>
      assertOAuthState({ supplied: state, expected: state, createdAt: iso(-OAUTH_STATE_TTL_MS + 5000), now })
    ).not.toThrow();
  });
});

describe('buildAuthorizeUrl', () => {
  const redirectUri = 'https://app.example.com/integrations/drchrono/callback';

  test('carries every parameter DrChrono requires', () => {
    const state = createOAuthState();
    const url = new URL(buildAuthorizeUrl({ clientId: 'client-123', redirectUri, state }));

    expect(`${url.origin}${url.pathname}`).toBe(DRCHRONO_AUTHORIZE_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('scope')).toBe(DRCHRONO_SCOPES.join(' '));
  });

  test('refuses to redirect a user with an invalid scope list', () => {
    // Better here than on DrChrono's error page, which does not name the token.
    expect(() =>
      buildAuthorizeUrl({ clientId: 'c', redirectUri, state: createOAuthState(), scopes: ['messages:read'] })
    ).toThrow(/Invalid DrChrono scope/);
  });
});
