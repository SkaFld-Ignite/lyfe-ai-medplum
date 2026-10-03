// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Basic } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { CONFIG_PREFIX } from '../../../../examples/medplum-provider/bots/shared/credentials.ts';
import {
  DEFAULT_LOOKAHEAD_DAYS,
  DEFAULT_MAX_PATIENTS,
  discoveryWindow,
  isDiscoveryEnabled,
  MAX_LOOKAHEAD_DAYS,
  readDiscoveryConfig,
} from './config.ts';

/**
 * The settings a clinic actually sets, and what happens when it sets nothing.
 *
 * Two properties carry almost all the weight here and both are about the cost
 * of being wrong. **Off unless it says `true`** is the difference between
 * deploying this and deploying an unattended job that starts creating patient
 * records in somebody's chart. **A blank phrase falls back to the default
 * rather than to "no filter"** is the difference between importing the new
 * patients and importing the entire schedule.
 */

/**
 * A credential record carrying these config fields.
 * @param config - Field name to stored value.
 * @returns The record.
 */
function record(config: Record<string, string>): Basic {
  return {
    resourceType: 'Basic',
    extension: Object.entries(config).map(([name, valueString]) => ({ url: `${CONFIG_PREFIX}${name}`, valueString })),
  } as Basic;
}

describe('discovery is off unless a clinic says otherwise', () => {
  test('only an explicit true switches it on', () => {
    expect(isDiscoveryEnabled('true')).toBe(true);
    expect(isDiscoveryEnabled('TRUE')).toBe(true);
    expect(isDiscoveryEnabled(' true ')).toBe(true);
  });

  test('everything else, including the absence of the field, is off', () => {
    // A clinic that has DrChrono configured has a credential record. If the
    // existence of that record were enough, this would start importing for
    // every clinic on the server the day it deployed.
    for (const raw of [undefined, '', 'false', 'yes', '1', 'on', 'enabled']) {
      expect(isDiscoveryEnabled(raw)).toBe(false);
    }
  });

  test('a record with nothing on it is off', () => {
    expect(readDiscoveryConfig({ organizationId: 'org-1', record: record({}) }).enabled).toBe(false);
    expect(readDiscoveryConfig({ organizationId: 'org-1', record: undefined }).enabled).toBe(false);
  });
});

describe('the defaults', () => {
  test('a clinic that sets only the switch gets the cautious ones', () => {
    const config = readDiscoveryConfig({ organizationId: 'org-1', record: record({ discoveryEnabled: 'true' }) });

    expect(config).toMatchObject({
      enabled: true,
      lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
      maxPatients: DEFAULT_MAX_PATIENTS,
    });
    // No reason filter unless a clinic asks for one. Every patient with an
    // upcoming active appointment is onboarded, because the chart has to be
    // there when they are in the room and the Reason column is whatever the
    // booking staff happened to type.
    expect(config.reasonPhrase).toBeUndefined();
  });

  test('a blank phrase is no filter, not an empty one', () => {
    // Blank and absent must mean the same thing, or saving the settings with
    // the box untouched would quietly change which patients get onboarded.
    const config = readDiscoveryConfig({
      organizationId: 'org-1',
      record: record({ discoveryEnabled: 'true', discoveryReason: '   ' }),
    });

    expect(config.reasonPhrase).toBeUndefined();
  });

  test('a clinic that wants to narrow it still can', () => {
    const config = readDiscoveryConfig({
      organizationId: 'org-1',
      record: record({ discoveryEnabled: 'true', discoveryReason: '  New Patient  ' }),
    });

    expect(config.reasonPhrase).toBe('New Patient');
  });

  test('a nonsense number is the default rather than a stopped clinic', () => {
    const config = readDiscoveryConfig({
      organizationId: 'org-1',
      record: record({ discoveryEnabled: 'true', discoveryLookaheadDays: 'soon' }),
    });

    expect(config.lookaheadDays).toBe(DEFAULT_LOOKAHEAD_DAYS);
  });

  test('a fat-fingered window is clamped rather than scanning ten months', () => {
    const config = readDiscoveryConfig({
      organizationId: 'org-1',
      record: record({ discoveryEnabled: 'true', discoveryLookaheadDays: '300' }),
    });

    expect(config.lookaheadDays).toBe(MAX_LOOKAHEAD_DAYS);
  });
});

describe('the profile the run acts as', () => {
  test('falls back to the one already named for unattended inbound work', () => {
    const config = readDiscoveryConfig({
      organizationId: 'org-1',
      record: record({ discoveryEnabled: 'true', webhookRequester: 'Practitioner/doc-1' }),
    });

    expect(config.requester).toBe('Practitioner/doc-1');
  });

  test('is its own setting when a clinic wants a different one', () => {
    const config = readDiscoveryConfig({
      organizationId: 'org-1',
      record: record({
        discoveryEnabled: 'true',
        webhookRequester: 'Practitioner/doc-1',
        discoveryRequester: 'Practitioner/doc-2',
      }),
    });

    expect(config.requester).toBe('Practitioner/doc-2');
  });
});

describe('the window is the clinic day', () => {
  test('a run just after midnight UTC is still the previous day in California', () => {
    // The failure this prevents: a pass firing at 05:00 Pacific is 12:00 or
    // 13:00 UTC, but a pass firing at 00:30 UTC is the evening before — and a
    // UTC "today" would scan tomorrow's calendar and silently skip the day it
    // was meant to cover.
    const window = discoveryWindow({
      now: new Date('2026-10-06T00:30:00Z'),
      timeZone: 'America/Los_Angeles',
      lookaheadDays: 0,
    });

    expect(window).toStrictEqual({ start: '2026-10-05', end: '2026-10-05' });
  });

  test('the lookahead reaches forward from the clinic day, inclusive', () => {
    const window = discoveryWindow({
      now: new Date('2026-10-05T13:00:00Z'),
      timeZone: 'America/Los_Angeles',
      lookaheadDays: 2,
    });

    expect(window).toStrictEqual({ start: '2026-10-05', end: '2026-10-07' });
  });

  test('a window spanning the end of a month does not wrap', () => {
    const window = discoveryWindow({
      now: new Date('2026-10-31T13:00:00Z'),
      timeZone: 'America/Los_Angeles',
      lookaheadDays: 2,
    });

    expect(window).toStrictEqual({ start: '2026-10-31', end: '2026-11-02' });
  });

  test('a typo in the zone name does not take the clinic offline', () => {
    const window = discoveryWindow({
      now: new Date('2026-10-05T13:00:00Z'),
      timeZone: 'Not/AZone',
      lookaheadDays: 0,
    });

    expect(window.start).toBe('2026-10-05');
  });
});
