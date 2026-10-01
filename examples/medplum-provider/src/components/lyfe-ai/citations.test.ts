// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test, vi } from 'vitest';
import {
  citationElementId,
  citedSources,
  dispatchSwitchTab,
  findCitationMatches,
  hasDocCitations,
  onSwitchTab,
  TAB_CITATIONS,
  TAB_NAV_EVENT,
} from './citations';

describe('findCitationMatches', () => {
  test('returns nothing for prose with no citations', () => {
    expect(findCitationMatches('Metformin 500mg BID, well tolerated.')).toEqual([]);
  });

  test('reads a document citation and the resource position it points at', () => {
    const matches = findCitationMatches('AST 78 U/L [doc:S2]');

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: 'doc', label: 'S2', resourceIndex: 1 });
    // The offsets have to cut out the whole token, brackets included.
    expect('AST 78 U/L [doc:S2]'.slice(matches[0].index, matches[0].index + matches[0].length)).toBe('[doc:S2]');
  });

  test('reads a chart section citation and maps it to this app tab id', () => {
    const [match] = findCitationMatches('on metformin [meds]');

    expect(match).toMatchObject({ kind: 'tab', key: 'meds', label: 'Meds', tab: 'meds' });
  });

  test('sorts every citation by position, whichever kind it is', () => {
    const text = 'Start [vitals] middle [doc:S1] then [doc:S3] and [labs] end';

    expect(findCitationMatches(text).map((m) => (m.kind === 'doc' ? m.label : m.key))).toEqual([
      'vitals',
      'S1',
      'S3',
      'labs',
    ]);
  });

  test('is not confused by a repeated scan of the same string', () => {
    // The patterns are global regexes held at module scope; a leaked `lastIndex` would make the
    // second call miss the match.
    expect(findCitationMatches('[doc:S1] [meds]')).toHaveLength(2);
    expect(findCitationMatches('[doc:S1] [meds]')).toHaveLength(2);
  });

  test('ignores labels that are not part of the protocol', () => {
    expect(findCitationMatches('see [appendix] and [doc:X1] and [DOC:S1]')).toEqual([]);
  });

  test('maps encounters onto this app tab id, which differs from the production one', () => {
    expect(TAB_CITATIONS.encounters.tab).toBe('encounter');
  });
});

describe('hasDocCitations', () => {
  test.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['no citations here', false],
    ['only a section [vitals]', false],
    ['a source [doc:S1]', true],
  ])('%j -> %s', (text, expected) => {
    expect(hasDocCitations(text)).toBe(expected);
  });
});

describe('citedSources', () => {
  const resources = ['Observation/a', 'Condition/b', 'MedicationRequest/c'];

  test('pairs each cited label with its resource, in first-mention order', () => {
    expect(citedSources('Second [doc:S2] then first [doc:S1]', resources)).toEqual([
      { label: 'S2', reference: 'Condition/b' },
      { label: 'S1', reference: 'Observation/a' },
    ]);
  });

  test('de-duplicates a label cited more than once', () => {
    expect(citedSources('[doc:S1] and again [doc:S1]', resources)).toEqual([
      { label: 'S1', reference: 'Observation/a' },
    ]);
  });

  test('drops a citation with no resource behind it', () => {
    // The bot can cite a source that never came back; that must not render an empty card.
    expect(citedSources('[doc:S9]', resources)).toEqual([]);
  });

  test('returns nothing without text or without resources', () => {
    expect(citedSources(undefined, resources)).toEqual([]);
    expect(citedSources('[doc:S1]', undefined)).toEqual([]);
    expect(citedSources('[doc:S1]', [])).toEqual([]);
  });
});

test('citationElementId is stable, so a pill and its card agree on the id', () => {
  expect(citationElementId('S3')).toBe('lyfe-ai-citation-S3');
});

describe('switch tab event', () => {
  test('a dispatch reaches a subscriber with the requested tab', () => {
    const handler = vi.fn();
    const off = onSwitchTab(handler);

    dispatchSwitchTab('vitals');

    expect(handler).toHaveBeenCalledWith('vitals');
    off();
    dispatchSwitchTab('labs');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('an event with no tab in its detail is ignored', () => {
    const handler = vi.fn();
    const off = onSwitchTab(handler);

    window.dispatchEvent(new CustomEvent(TAB_NAV_EVENT, { detail: {} }));
    window.dispatchEvent(new CustomEvent(TAB_NAV_EVENT));

    expect(handler).not.toHaveBeenCalled();
    off();
  });
});
