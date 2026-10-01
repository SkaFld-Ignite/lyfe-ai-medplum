// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Read an encounter's pre-visit or post-visit AI summary `Composition` back into
 * something the card can render.
 *
 * The bot writes the Composition (`bots/encounter-summary.ts`); this is the other
 * side of that wire. Pure, so the whole parse is testable without a server.
 *
 * The codes below are **duplicated on purpose**, following the same rule as
 * `patient-ai-summary.ts`: exactly one definition per side of the wire, bots in
 * `bots/shared/encounter-summary.ts` and the app here, values kept identical.
 * `encounter-ai-summary.test.ts` imports both and fails if they drift.
 *
 * The marker-resolution machinery is NOT duplicated. `resolveCitations` and
 * `plainTextFromDiv` are imported from `patient-ai-summary.ts`, because `[n]`
 * markers indexing into `section.entry[]` is one mechanism shared by both
 * features, and a second copy of it is a second thing to get wrong.
 */
import type { Composition, CompositionSection, Encounter } from '@medplum/fhirtypes';
import type { SummaryCitation, SummaryRow } from './patient-ai-summary';
import { plainTextFromDiv, resolveCitations } from './patient-ai-summary';

/** Which of the two summaries. */
export type SummaryKind = 'pre-visit' | 'post-visit';

/**
 * Must equal `ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM` in
 * `bots/shared/encounter-summary.ts`.
 */
export const ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM: Record<SummaryKind, string> = {
  'pre-visit': 'https://lyfe.com/pre-visit-summary',
  'post-visit': 'https://lyfe.com/post-visit-summary',
};

/** Must equal `ENCOUNTER_SUMMARY_SECTION_SYSTEM` in `bots/shared/encounter-summary.ts`. */
export const ENCOUNTER_SUMMARY_SECTION_SYSTEM = 'https://lyfe.com/CodeSystem/encounter-summary-section';

/** Must equal `ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM` in `bots/shared/encounter-summary.ts`. */
export const ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM = 'https://lyfe.com/CodeSystem/encounter-summary-qualifier';

/** Identifier of the bot that generates both summaries. */
export const ENCOUNTER_SUMMARY_BOT_IDENTIFIER = {
  system: 'https://lyfe.health/bots',
  value: 'lyfe-encounter-summary',
};

/** The headline section's code, per kind. */
export const HEADLINE_SECTION: Record<SummaryKind, string> = {
  'pre-visit': 'reason-for-visit',
  'post-visit': 'visit-outcome',
};

/**
 * The block sections, in the order prod's two-column grid laid them out.
 *
 * `relevant-history`, `recent-changes`, `current-medications`, `prep-items` is
 * the reading order of `PreVisitSummaryView`; the post-visit list is the reading
 * order of `PostVisitSummaryView`.
 */
export const BLOCK_SECTIONS: Record<SummaryKind, readonly string[]> = {
  'pre-visit': ['relevant-history', 'recent-changes', 'current-medications', 'prep-items'],
  'post-visit': ['key-findings', 'decisions-made', 'follow-up-plan', 'unresolved-items'],
};

/** Must equal `SECTION_TITLES` in `bots/shared/encounter-summary.ts`. */
export const SECTION_TITLES: Record<string, string> = {
  'reason-for-visit': 'Reason for Visit',
  'relevant-history': 'Relevant History',
  'current-medications': 'Relevant Medications',
  'recent-changes': 'Recent Changes',
  'prep-items': 'Preparation',
  'visit-outcome': 'Visit Outcome',
  'key-findings': 'Key Findings',
  'decisions-made': 'Decisions Made',
  'follow-up-plan': 'Follow-Up Plan',
  'unresolved-items': 'Unresolved',
};

/** Must equal `COMPOSITION_TITLES` in `bots/shared/encounter-summary.ts`. */
export const COMPOSITION_TITLES: Record<SummaryKind, string> = {
  'pre-visit': 'Pre-Visit Summary',
  'post-visit': 'Post-Visit Summary',
};

/** One rendered row, plus the qualifier that tints it. */
export interface EncounterSummaryRow extends SummaryRow {
  /**
   * The row's own code: a condition's status, a medication's relevance, a
   * change's or finding's significance, a prep item's priority. Undefined for the
   * blocks whose rows carry no qualifier.
   */
  qualifier?: string;
}

export interface EncounterSummaryBlock {
  code: string;
  title: string;
  rows: EncounterSummaryRow[];
}

export interface EncounterAiSummary {
  compositionId: string;
  kind: SummaryKind;
  /** `Composition.date`. */
  generatedAt?: string;
  /** `Composition.status === 'preliminary'`. Nothing writes that yet; the card handles it if it appears. */
  stale: boolean;
  /** `reasonForVisit` or `visitOutcome`. */
  headline: SummaryRow;
  /** Only the blocks the model actually filled, in {@link BLOCK_SECTIONS} order. */
  blocks: EncounterSummaryBlock[];
  /** Every cited resource across all sections, deduped, for the Sources footer. */
  sources: SummaryCitation[];
}

/**
 * Which summary an encounter gets.
 *
 * Mirrors `defaultKind` in `bots/encounter-summary.ts`: a finished visit gets the
 * progress-note summary, anything still planned or in progress gets the briefing.
 * Prod compared the appointment date to today; `status` says the same thing more
 * directly and is what the encounter header already shows.
 * @param encounter - The encounter.
 * @returns The kind to show and generate.
 */
export function inferSummaryKind(encounter: Encounter): SummaryKind {
  return encounter.status === 'finished' ? 'post-visit' : 'pre-visit';
}

function codeFromSystem(section: CompositionSection, system: string): string | undefined {
  return section.code?.coding?.find((coding) => coding.system === system)?.code;
}

function toRow(section: CompositionSection): EncounterSummaryRow {
  const headline = section.title ?? '';
  const detail = plainTextFromDiv(section.text?.div);
  return {
    headline,
    // The bot repeats the headline as the narrative when a row has no detail, so
    // that the section is valid FHIR. Showing it twice would just look like a bug.
    detail: detail && detail !== headline ? detail : undefined,
    qualifier: codeFromSystem(section, ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM),
    citations: resolveCitations(section, [headline, detail]),
  };
}

/**
 * Parse a stored encounter summary into the card's view model.
 *
 * Tolerant by design, as on the patient-summary side: a section the bot never
 * wrote comes back absent rather than empty, an unrecognised qualifier comes
 * through as-is and the row simply renders untinted, and a summary whose headline
 * section is missing still renders its blocks. A provider looking at an encounter
 * should not lose the whole card to one malformed section.
 * @param composition - The stored summary.
 * @param kind - Which summary it is, which fixes the section names and their order.
 * @returns The view model.
 */
export function parseEncounterSummary(composition: Composition, kind: SummaryKind): EncounterAiSummary {
  const byCode = new Map<string, CompositionSection>();
  for (const section of composition.section ?? []) {
    const code = codeFromSystem(section, ENCOUNTER_SUMMARY_SECTION_SYSTEM);
    if (code && !byCode.has(code)) {
      byCode.set(code, section);
    }
  }

  const headlineSection = byCode.get(HEADLINE_SECTION[kind]);
  const headlineText = plainTextFromDiv(headlineSection?.text?.div);
  const headline: SummaryRow = {
    headline: headlineText,
    citations: headlineSection ? resolveCitations(headlineSection, [headlineText]) : [],
  };

  const blocks: EncounterSummaryBlock[] = [];
  for (const code of BLOCK_SECTIONS[kind]) {
    const rows = (byCode.get(code)?.section ?? []).map(toRow);
    if (rows.length > 0) {
      blocks.push({ code, title: SECTION_TITLES[code] ?? code, rows });
    }
  }

  // The footer lists every cited resource once. Deduped on the reference rather
  // than the marker, because markers are scoped to their own section: the same
  // Condition can be `[1]` in the headline and `[2]` in a prep item.
  const sources: SummaryCitation[] = [];
  const seen = new Set<string>();
  for (const row of [headline, ...blocks.flatMap((block) => block.rows)]) {
    for (const citation of row.citations) {
      if (citation.reference && !seen.has(citation.reference)) {
        seen.add(citation.reference);
        sources.push(citation);
      }
    }
  }

  return {
    compositionId: composition.id ?? '',
    kind,
    generatedAt: composition.date,
    stale: composition.status === 'preliminary',
    headline,
    blocks,
    sources,
  };
}

/**
 * The search that finds one encounter's summary. Mirrors
 * `encounterSummarySearchQuery` on the bot side.
 * @param kind - Which summary.
 * @param encounterId - The encounter the summary is about.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function encounterSummarySearchQuery(kind: SummaryKind, encounterId: string): string {
  return `identifier=${encodeURIComponent(`${ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM[kind]}|${encounterId}`)}`;
}

// A citation marker, stripped on the way into a clinical note.
const MARKER_PATTERN = /\s*\[\d{1,3}\]/g;

/** How each block's rows read as a note line. */
const NOTE_LINE: Record<string, (row: EncounterSummaryRow) => string> = {
  'key-findings': (row) => (row.qualifier ? `${row.headline} (${row.qualifier})` : row.headline),
  'decisions-made': (row) => (row.detail ? `${row.headline} — ${row.detail}` : row.headline),
  'follow-up-plan': (row) => (row.detail ? `${row.headline} (${row.detail})` : row.headline),
  'unresolved-items': (row) => (row.detail ? `${row.headline} — ${row.detail}` : row.headline),
};

/** The headings prod's `formatPostVisitSummaryForNote` wrote, per block. */
const NOTE_HEADINGS: Record<string, string> = {
  'key-findings': 'Key Findings:',
  'decisions-made': 'Decisions:',
  'follow-up-plan': 'Follow-Up:',
  'unresolved-items': 'Unresolved:',
};

/**
 * Render a post-visit summary as the readable note text "Pull into note" appends.
 *
 * A direct port of prod's `formatPostVisitSummaryForNote`, including its headings
 * and dash conventions, so what lands in the chart is prose rather than raw JSON.
 * Citation markers are stripped: `[2]` means nothing once the text has left the
 * card that could resolve it, and a signed note should not carry a dangling
 * reference to an array it no longer has.
 * @param summary - The parsed post-visit summary.
 * @returns The note text.
 */
export function formatPostVisitSummaryForNote(summary: EncounterAiSummary): string {
  const strip = (text: string): string => text.replace(MARKER_PATTERN, '').trim();
  const lines: string[] = [strip(summary.headline.headline)];

  for (const block of summary.blocks) {
    const line = NOTE_LINE[block.code];
    const heading = NOTE_HEADINGS[block.code];
    if (!line || !heading) {
      continue;
    }
    lines.push('', heading);
    for (const row of block.rows) {
      lines.push(`- ${strip(line(row))}`);
    }
  }

  return lines.join('\n');
}
