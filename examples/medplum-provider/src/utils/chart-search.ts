// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The app's side of the natural-language chart search.
 *
 * The bot (`bots/chart-search.ts`) runs the structured FHIR legs; this module
 * holds what the app needs to render the answer, plus the one leg the bot cannot
 * run — document text, which lives in a pgvector index only the worker can
 * reach.
 *
 * The types and labels below are **duplicated on purpose**, following the same
 * rule as `patient-ai-summary.ts`: exactly one definition per side of the wire,
 * values kept identical, with `chart-search.test.ts` importing both and failing
 * if they drift. The app is a browser bundle and the bot is a `vmcontext`
 * script; importing across that line would pull bot code into the bundle.
 */
import type { DocumentSearchHit } from '../services/document-search';

/** Must equal `SearchKind` in `bots/shared/chart-search.ts`. */
export type SearchKind =
  'condition' | 'medication' | 'allergy' | 'lab' | 'vital' | 'encounter' | 'procedure' | 'immunization' | 'document';

/** Must equal `SEARCH_KINDS` in `bots/shared/chart-search.ts`. */
export const SEARCH_KINDS: readonly SearchKind[] = [
  'condition',
  'medication',
  'allergy',
  'lab',
  'vital',
  'encounter',
  'procedure',
  'immunization',
  'document',
];

/** Must equal `SEARCH_KIND_LABELS` in `bots/shared/chart-search.ts`. */
export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  condition: 'Conditions',
  medication: 'Medications',
  allergy: 'Allergies',
  lab: 'Labs',
  vital: 'Vitals',
  encounter: 'Encounters',
  procedure: 'Procedures',
  immunization: 'Immunizations',
  document: 'Documents',
};

/** Must equal `ChartSearchHit` in `bots/shared/chart-search.ts`. */
export interface ChartSearchHit {
  reference: string;
  resourceType: string;
  kind: SearchKind;
  title: string;
  detail?: string;
  date?: string;
}

/** Identifier of the bot that runs the structured legs. */
export const CHART_SEARCH_BOT_IDENTIFIER = {
  system: 'https://lyfe.health/bots',
  value: 'lyfe-chart-search',
};

/** What the bot returns. */
export interface ChartSearchBotResult {
  ok?: boolean;
  interpretation?: string;
  terms?: string[];
  kinds?: SearchKind[];
  hits?: ChartSearchHit[];
  error?: string;
}

/** Longest snippet shown under a document row. */
const SNIPPET_CHARS = 280;

/**
 * Turn the worker's chunk hits into rows, best chunk per document.
 *
 * The index's grain is a chunk, so a long document that mentions a term three
 * times comes back three times. Collapsing to the closest chunk per document is
 * a display decision and is stated as one: the row links to the document, so
 * showing it three times would be three links to the same place. `distance` is
 * cosine distance, lower being closer, and the worker already returns the hits
 * in that order — so first-seen is best-seen and no re-sort is needed.
 * @param hits - The worker's hits, best first.
 * @returns One row per document.
 */
export function toDocumentSearchHits(hits: DocumentSearchHit[]): ChartSearchHit[] {
  const seen = new Set<string>();
  const rows: ChartSearchHit[] = [];
  for (const hit of hits) {
    if (!hit.documentId || seen.has(hit.documentId)) {
      continue;
    }
    seen.add(hit.documentId);
    const snippet = hit.snippet?.replace(/\s+/g, ' ').trim();
    rows.push({
      reference: `DocumentReference/${hit.documentId}`,
      resourceType: 'DocumentReference',
      kind: 'document',
      title: hit.title?.trim() || 'Untitled document',
      ...(snippet && { detail: snippet.slice(0, SNIPPET_CHARS) }),
      ...(hit.documentDate && { date: hit.documentDate }),
    });
  }
  return rows;
}

/**
 * Group rows by kind, in the order {@link SEARCH_KINDS} lists them.
 *
 * Only kinds that were actually searched appear, and a searched kind with no
 * matches appears as an empty group — which is the point. "Nothing in
 * medications" and "medications were not searched" are different answers to a
 * clinical question, and prod's search could say neither.
 * @param props - The rows and what was searched.
 * @param props.hits - Every matched row.
 * @param props.kinds - The kinds the search covered.
 * @returns One group per searched kind, in display order.
 */
export function groupHitsByKind(props: {
  hits: ChartSearchHit[];
  kinds: SearchKind[];
}): { kind: SearchKind; hits: ChartSearchHit[] }[] {
  return SEARCH_KINDS.filter((kind) => props.kinds.includes(kind)).map((kind) => ({
    kind,
    hits: props.hits.filter((hit) => hit.kind === kind),
  }));
}
