// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inline citation protocol the assistant writes into its prose, carried over
 * unchanged from the production Lyfe chat so the same bot output renders the same
 * way in both apps:
 *
 * - `[doc:S1]`, `[doc:S2]` … — a source card. `Sn` is the 1-based position in the
 *   message's `resources` list, so `[doc:S2]` is `resources[1]`. Clicking the pill
 *   scrolls its card into view, flashes it, and opens the resource.
 * - `[meds]`, `[vitals]`, `[labs]` … — a section of the patient chart. Clicking the
 *   pill dispatches {@link TAB_NAV_EVENT}; the assistant's host navigates the chart
 *   to that section.
 *
 * Nothing here touches FHIR or React, so the matching rules can be tested on their own.
 */

/** Matches one `[doc:Sn]` reference. Stateful (`g`) — always iterate with `matchAll`. */
const DOC_CITE_RE = /\[doc:(S\d+)\]/g;

export interface TabCitationTarget {
  /** Text shown on the pill. */
  label: string;
  /** `id` of the patient page tab in `PatientPageTabs`. */
  tab: string;
}

/**
 * The structured-tool citations and the chart section each one jumps to. The keys are
 * the labels the bot emits; the `tab` values are this app's patient page tab ids, which
 * differ from the production app's section ids (`encounters` → `encounter`, for example).
 */
export const TAB_CITATIONS: Record<string, TabCitationTarget> = {
  meds: { label: 'Meds', tab: 'meds' },
  conditions: { label: 'Conditions', tab: 'conditions' },
  allergies: { label: 'Allergies', tab: 'allergies' },
  vitals: { label: 'Vitals', tab: 'vitals' },
  labs: { label: 'Labs', tab: 'labs' },
  encounters: { label: 'Encounters', tab: 'encounter' },
  demographics: { label: 'Demographics', tab: 'demographics' },
  immunizations: { label: 'Immunizations', tab: 'immunizations' },
};

const TAB_CITE_RE = new RegExp(`\\[(${Object.keys(TAB_CITATIONS).join('|')})\\]`, 'g');

/** Window event that asks the host to switch the patient chart to a section. */
export const TAB_NAV_EVENT = 'lyfe:ai-switch-tab';

export interface DocCitationMatch {
  kind: 'doc';
  /** Offset of the whole `[doc:Sn]` token in the source string. */
  index: number;
  /** Length of the whole token, so it can be cut out. */
  length: number;
  /** The `Sn` label. */
  label: string;
  /** 0-based index into the message's `resources` list. */
  resourceIndex: number;
}

export interface TabCitationMatch {
  kind: 'tab';
  index: number;
  length: number;
  /** The bare key the bot wrote, e.g. `meds`. */
  key: string;
  label: string;
  tab: string;
}

export type CitationMatch = DocCitationMatch | TabCitationMatch;

/**
 * Finds every citation token in a string, in the order it appears.
 * @param text - Assistant prose, which may contain no citations at all.
 * @returns The matches, sorted by position. Overlaps are impossible — the two
 *   patterns cannot match the same span.
 */
export function findCitationMatches(text: string): CitationMatch[] {
  const matches: CitationMatch[] = [];

  for (const m of text.matchAll(DOC_CITE_RE)) {
    const label = m[1];
    matches.push({
      kind: 'doc',
      index: m.index ?? 0,
      length: m[0].length,
      label,
      resourceIndex: Number(label.slice(1)) - 1,
    });
  }

  for (const m of text.matchAll(TAB_CITE_RE)) {
    const key = m[1];
    const target = TAB_CITATIONS[key];
    matches.push({
      kind: 'tab',
      index: m.index ?? 0,
      length: m[0].length,
      key,
      label: target.label,
      tab: target.tab,
    });
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Whether a message cites any source cards, i.e. whether a sources strip is worth rendering.
 * @param text - Assistant prose, or nothing.
 * @returns True when at least one `[doc:Sn]` token is present.
 */
export function hasDocCitations(text: string | null | undefined): boolean {
  return !!text && findCitationMatches(text).some((m) => m.kind === 'doc');
}

/**
 * The `Sn` labels a message cites, de-duplicated and in first-mention order. A label is
 * only returned when the message actually carries a resource at that position — the bot
 * can cite `[doc:S9]` for a source that never came back.
 * @param text - Assistant prose, or nothing.
 * @param resources - The message's resource references.
 * @returns One entry per citable source, with the reference it points at.
 */
export function citedSources(
  text: string | null | undefined,
  resources: string[] | undefined
): { label: string; reference: string }[] {
  if (!text || !resources?.length) {
    return [];
  }
  const seen = new Set<string>();
  const result: { label: string; reference: string }[] = [];
  for (const match of findCitationMatches(text)) {
    if (match.kind !== 'doc' || seen.has(match.label)) {
      continue;
    }
    const reference = resources[match.resourceIndex];
    if (reference) {
      seen.add(match.label);
      result.push({ label: match.label, reference });
    }
  }
  return result;
}

/**
 * DOM id of a source card, so a pill can find the card it points at.
 * @param label - The `Sn` label.
 * @returns The element id.
 */
export function citationElementId(label: string): string {
  return `lyfe-ai-citation-${label}`;
}

/**
 * Asks the host to switch the patient chart to a section.
 * @param tab - A patient page tab id.
 */
export function dispatchSwitchTab(tab: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(TAB_NAV_EVENT, { detail: { tab } }));
}

/**
 * Subscribes to section-switch requests.
 * @param handler - Called with the requested patient page tab id.
 * @returns An unsubscribe function.
 */
export function onSwitchTab(handler: (tab: string) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const listener = (e: Event): void => {
    const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
    if (tab) {
      handler(tab);
    }
  };
  window.addEventListener(TAB_NAV_EVENT, listener);
  return () => window.removeEventListener(TAB_NAV_EVENT, listener);
}
