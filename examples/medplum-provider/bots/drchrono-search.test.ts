// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test, vi } from 'vitest';
import { searchPatients } from './drchrono-search.ts';

/**
 * What the onboarding search is allowed to say.
 *
 * This is about one distinction and nothing else: "DrChrono answered and had
 * nobody" versus "DrChrono would not answer". They used to be the same reply.
 * Under throttling every field query 429s, each was skipped, and the page said
 * "no matches" about a patient sitting right there — so somebody searching a
 * date of birth concludes the patient is not in the EHR and stops looking.
 *
 * It is not hypothetical: a 33-patient bulk import exhausted this practice's
 * DrChrono quota for about twenty minutes today, which is exactly the window in
 * which a person would be onboarding by hand. And it is the failure CLAUDE.md
 * already records for Algolia — a search that reports empty when it is broken
 * teaches people the data is not there.
 */

/** DrChrono's actual 429 body, which carries the wait hint worth surfacing. */
const THROTTLED_BODY = '{"detail":"Request was throttled. Expected available in 2710.0 seconds."}';

/**
 * A fake DrChrono that answers each field query however the test says.
 * @param byField - Response per queried field.
 * @returns The fetch helper and the paths it was asked for.
 */
function fakeDrChrono(byField: Record<string, { status: number; body: string }>): {
  get: (path: string) => Promise<Response>;
  paths: string[];
} {
  const paths: string[] = [];
  const get = vi.fn(async (path: string) => {
    paths.push(path);
    const field = /\/patients\?([a-z_]+)=/.exec(path)?.[1] ?? '';
    const reply = byField[field] ?? { status: 200, body: '{"results":[]}' };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => JSON.parse(reply.body),
      text: async () => reply.body,
    } as Response;
  });
  return { get, paths };
}

const PATIENT = '{"results":[{"id":12345,"first_name":"Ada","last_name":"Lovelace","chart_id":"AL0001"}]}';

describe('searchPatients', () => {
  test('a throttled search is an error, never an empty result', async () => {
    const { get } = fakeDrChrono({
      last_name: { status: 429, body: THROTTLED_BODY },
      first_name: { status: 429, body: THROTTLED_BODY },
      chart_id: { status: 429, body: THROTTLED_BODY },
    });

    await expect(searchPatients(get, 'lovelace')).rejects.toThrow(/429/);
  });

  test("the error carries DrChrono's own wait hint", async () => {
    // "Expected available in 2710.0 seconds" is the single most useful thing
    // anyone can be told here, so it must survive to the screen.
    const { get } = fakeDrChrono({ last_name: { status: 429, body: THROTTLED_BODY } });

    await expect(searchPatients(get, 'lovelace')).rejects.toThrow(/Expected available in 2710\.0 seconds/);
  });

  test('a partial failure is refused, not passed off as the whole answer', async () => {
    // last_name answered; chart_id did not. What survives is an unknown
    // fraction of the matches, and showing it as complete is the same lie in a
    // quieter form — the searcher cannot tell a short list from a full one.
    const { get } = fakeDrChrono({
      last_name: { status: 200, body: PATIENT },
      chart_id: { status: 429, body: THROTTLED_BODY },
    });

    await expect(searchPatients(get, 'lovelace')).rejects.toThrow(/chart_id/);
  });

  test('a real empty result is still empty, not an error', async () => {
    // The distinction only has value if the ordinary case stays ordinary.
    const { get } = fakeDrChrono({});

    await expect(searchPatients(get, 'nobody')).resolves.toStrictEqual([]);
  });

  test('matches are merged across fields and de-duplicated by patient id', async () => {
    const { get } = fakeDrChrono({
      last_name: { status: 200, body: PATIENT },
      first_name: { status: 200, body: PATIENT },
      chart_id: { status: 200, body: PATIENT },
    });

    const found = await searchPatients(get, 'lovelace');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 12345, firstName: 'Ada', lastName: 'Lovelace' });
  });

  test('a query too short to be meaningful asks DrChrono nothing', async () => {
    const { get, paths } = fakeDrChrono({});

    await expect(searchPatients(get, 'a')).resolves.toStrictEqual([]);
    expect(paths).toStrictEqual([]);
  });
});
