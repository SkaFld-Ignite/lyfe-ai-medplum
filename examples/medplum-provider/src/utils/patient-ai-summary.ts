// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Read the AI patient summary `Composition` back into something the card can render.
 *
 * The bot writes the Composition (`bots/patient-ai-summary.ts`); this is the other
 * side of that wire. Pure, so the whole parse is testable without a server.
 *
 * The codes below are **duplicated on purpose**, following the same rule as
 * `LYFE_SOURCE_TAG_SYSTEM` in `data-source.ts`: exactly one definition per side
 * of the wire, bots in `bots/shared/ai-summary.ts` and the app here, values kept
 * identical. `patient-ai-summary.test.ts` imports both and fails if they drift,
 * which is the part the source-tag convention was missing when a one-word
 * difference silently emptied three screens.
 */
import type { Composition, CompositionSection, Reference } from '@medplum/fhirtypes';

/** Must equal `AI_SUMMARY_IDENTIFIER_SYSTEM` in `bots/shared/ai-summary.ts`. */
export const AI_SUMMARY_IDENTIFIER_SYSTEM = 'https://lyfe.com/ai-summary';

/** Must equal `AI_SUMMARY_SECTION_SYSTEM` in `bots/shared/ai-summary.ts`. */
export const AI_SUMMARY_SECTION_SYSTEM = 'https://lyfe.com/CodeSystem/ai-summary-section';

/** Must equal `AI_SUMMARY_SEVERITY_SYSTEM` in `bots/shared/ai-summary.ts`. */
export const AI_SUMMARY_SEVERITY_SYSTEM = 'https://lyfe.com/CodeSystem/ai-summary-severity';

/** Must equal `AI_SUMMARY_RISK_LEVEL_SYSTEM` in `bots/shared/ai-summary.ts`. */
export const AI_SUMMARY_RISK_LEVEL_SYSTEM = 'https://lyfe.com/CodeSystem/ai-summary-risk-level';

/** Identifier of the bot that generates and invalidates the summary. */
export const AI_SUMMARY_BOT_IDENTIFIER = {
  system: 'https://lyfe.health/bots',
  value: 'lyfe-patient-ai-summary',
};

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type RiskLevel = 'high' | 'moderate' | 'low';

/**
 * How a cited resource is tinted. Derived from the referenced resource type, not
 * from anything stored — the type is in the reference, so there is nothing to
 * keep in step.
 */
export type CitationKind = 'condition' | 'medication' | 'allergy' | 'lab' | 'vital' | 'encounter' | 'document';

const CITATION_KINDS: Record<string, CitationKind> = {
  Condition: 'condition',
  MedicationRequest: 'medication',
  MedicationStatement: 'medication',
  AllergyIntolerance: 'allergy',
  Observation: 'lab',
  Encounter: 'encounter',
  DocumentReference: 'document',
};

export interface SummaryCitation {
  /** The marker as it appears in the text: `[2]` is index 2. */
  index: number;
  /** `Condition/abc`. Empty when the stored reference was malformed. */
  reference: string;
  resourceType: string;
  /** From `Reference.display`, which the bot always sets. */
  label: string;
  kind: CitationKind;
}

/** One rendered line: a headline, its supporting line, and what the two cite. */
export interface SummaryRow {
  /** Carries `[n]` markers that index into {@link citations}. */
  headline: string;
  detail?: string;
  citations: SummaryCitation[];
}

export interface AlertRow extends SummaryRow {
  severity: AlertSeverity;
}

export interface RiskRow extends SummaryRow {
  level: RiskLevel;
}

export interface PatientAiSummary {
  compositionId: string;
  /** `Composition.date`. */
  generatedAt?: string;
  /**
   * `Composition.status === 'preliminary'`. The chart changed after the summary
   * was written, so what is on screen is the last good one.
   */
  stale: boolean;
  narrative: SummaryRow;
  alerts: AlertRow[];
  risks: RiskRow[];
  focusAreas: SummaryRow[];
  careGaps: SummaryRow[];
  /** Every cited resource across all sections, deduped, for the Sources footer. */
  sources: SummaryCitation[];
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/**
 * Pull the plain text out of a `Narrative.div`.
 *
 * Tag-stripping rather than DOM parsing, deliberately. The bot writes a single
 * escaped `<p>`, so there is no structure to preserve, and the result is rendered
 * as a React text node — never as HTML — so model output cannot become markup in
 * the provider's browser no matter what it contains.
 * @param div - The `Narrative.div` XHTML.
 * @returns The text content.
 */
export function plainTextFromDiv(div: string | undefined): string {
  if (!div) {
    return '';
  }
  return div
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => XML_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** The marker the bot writes in place of a prompt tag: an index into the section's `entry`. */
const MARKER_PATTERN = /\[(\d{1,3})\]/g;

function citationFrom(entry: Reference | undefined, index: number): SummaryCitation {
  const reference = entry?.reference ?? '';
  const resourceType = reference.split('/')[0] ?? '';
  return {
    index,
    reference,
    resourceType,
    label: entry?.display ?? reference ?? `Source ${index}`,
    kind: CITATION_KINDS[resourceType] ?? 'document',
  };
}

/**
 * Resolve the `[n]` markers in a section's text against its own `entry[]`.
 *
 * A marker is an offset into a list the section carries, so resolving it cannot
 * depend on a side table — which is the whole reason the stored form stopped
 * being lyfe-provider-ui's `[C1]` tags. A marker past the end of `entry` is
 * dropped from the citation list; the text keeps it, and the UI renders it as
 * plain text rather than a chip.
 * @param section - The section whose text and entries to read.
 * @param texts - The strings of that section, in reading order.
 * @returns The citations referenced by those strings, in marker order.
 */
export function resolveCitations(section: CompositionSection, texts: (string | undefined)[]): SummaryCitation[] {
  const entries = section.entry ?? [];
  const seen = new Set<number>();
  const citations: SummaryCitation[] = [];
  for (const text of texts) {
    for (const match of (text ?? '').matchAll(MARKER_PATTERN)) {
      const index = Number(match[1]);
      if (index < 1 || index > entries.length || seen.has(index)) {
        continue;
      }
      seen.add(index);
      citations.push(citationFrom(entries[index - 1], index));
    }
  }
  return citations.sort((a, b) => a.index - b.index);
}

function sectionCodeOf(section: CompositionSection): string | undefined {
  return section.code?.coding?.find((coding) => coding.system === AI_SUMMARY_SECTION_SYSTEM)?.code;
}

function codeFromSystem(section: CompositionSection, system: string): string | undefined {
  return section.code?.coding?.find((coding) => coding.system === system)?.code;
}

// A leaf sub-section — one alert, risk, focus area or care gap — as a renderable row.
function toRow(section: CompositionSection): SummaryRow {
  const headline = section.title ?? '';
  const detail = plainTextFromDiv(section.text?.div);
  return {
    headline,
    // The bot repeats the headline as the narrative when a row has no detail, so
    // that the section is valid FHIR. Showing it twice would just look like a bug.
    detail: detail && detail !== headline ? detail : undefined,
    citations: resolveCitations(section, [headline, detail]),
  };
}

function isSeverity(value: string | undefined): value is AlertSeverity {
  return value === 'critical' || value === 'warning' || value === 'info';
}

function isRiskLevel(value: string | undefined): value is RiskLevel {
  return value === 'high' || value === 'moderate' || value === 'low';
}

/**
 * Parse the stored Composition into the card's view model.
 *
 * Tolerant by design: a section the bot never wrote comes back as an empty
 * array, an unrecognised severity falls back to `info`, and a summary whose
 * narrative section is missing still renders its alerts. A provider looking at a
 * chart should not lose the whole card to one malformed section.
 * @param composition - The stored summary.
 * @returns The view model.
 */
export function parseAiSummaryComposition(composition: Composition): PatientAiSummary {
  const sections = composition.section ?? [];
  const byCode = new Map<string, CompositionSection>();
  for (const section of sections) {
    const code = sectionCodeOf(section);
    if (code && !byCode.has(code)) {
      byCode.set(code, section);
    }
  }

  const narrativeSection = byCode.get('narrative');
  const narrativeText = plainTextFromDiv(narrativeSection?.text?.div);
  const narrative: SummaryRow = {
    headline: narrativeText,
    citations: narrativeSection ? resolveCitations(narrativeSection, [narrativeText]) : [],
  };

  const rowsOf = (code: string): { section: CompositionSection; row: SummaryRow }[] =>
    (byCode.get(code)?.section ?? []).map((section) => ({ section, row: toRow(section) }));

  const alerts: AlertRow[] = rowsOf('alerts').map(({ section, row }) => {
    const severity = codeFromSystem(section, AI_SUMMARY_SEVERITY_SYSTEM);
    return { ...row, severity: isSeverity(severity) ? severity : 'info' };
  });

  const risks: RiskRow[] = rowsOf('risks').map(({ section, row }) => {
    const level = codeFromSystem(section, AI_SUMMARY_RISK_LEVEL_SYSTEM);
    return { ...row, level: isRiskLevel(level) ? level : 'low' };
  });

  const focusAreas = rowsOf('focus-areas').map(({ row }) => row);
  const careGaps = rowsOf('care-gaps').map(({ row }) => row);

  // The footer lists every cited resource once. Deduped on the reference rather
  // than the marker, because markers are scoped to their own section: the same
  // Condition can be `[1]` in the narrative and `[2]` in an alert.
  const sources: SummaryCitation[] = [];
  const seen = new Set<string>();
  for (const row of [narrative, ...alerts, ...risks, ...focusAreas, ...careGaps]) {
    for (const citation of row.citations) {
      if (citation.reference && !seen.has(citation.reference)) {
        seen.add(citation.reference);
        sources.push(citation);
      }
    }
  }

  return {
    compositionId: composition.id ?? '',
    generatedAt: composition.date,
    stale: composition.status === 'preliminary',
    narrative,
    alerts,
    risks,
    focusAreas,
    careGaps,
    sources,
  };
}

/**
 * The search that finds a patient's summary. Mirrors `summarySearchQuery` on the bot side.
 * @param patientId - The patient the summary is about.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function aiSummarySearchQuery(patientId: string): string {
  return `identifier=${encodeURIComponent(`${AI_SUMMARY_IDENTIFIER_SYSTEM}|${patientId}`)}`;
}
