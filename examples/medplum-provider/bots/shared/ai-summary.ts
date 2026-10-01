// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The AI patient summary, as a FHIR `Composition`.
 *
 * Everything in here is pure: no MedplumClient, no network, no clock. The bot
 * (`bots/patient-ai-summary.ts`) does the reads and the `$ai` call; this module
 * turns a chart into a prompt, a model answer into a validated draft, and a
 * draft into the Composition. That split is what makes the interesting parts
 * testable without a server or a model.
 *
 * WHY COMPOSITION, AND WHAT REPLACED THE `[C1]` TAGS
 * -------------------------------------------------
 * lyfe-provider-ui stored the summary as a JSON blob on `Patient.aiSummary`,
 * with a side table of citations keyed by string tags — `[C1]`, `[M3]`, `[D1]`.
 * The model wrote those tags into its prose and the UI matched them back by
 * string. Nothing guaranteed a tag resolved: `[C9]` in the narrative with only
 * eight conditions in the index rendered as literal `[C9]` text, and a citation
 * pointed at a Prisma row id that meant nothing outside that database.
 *
 * Here, a citation is a real `Reference`. Each section carries the resources it
 * cites in its own `section.entry[]`, and the prose carries `[1]`-style markers
 * that are **indices into that same section's `entry` array**. A marker cannot
 * dangle: it is an offset into a list the section is required to carry, and
 * `Reference.display` carries the label, so the UI needs no second lookup.
 *
 * Sections nest rather than encoding rows in HTML. An alert is a sub-section of
 * the alerts section: `title` is the message, `code` is the severity, `text.div`
 * is the recommended action, `entry` is what it cites. That uses Composition's
 * own recursion instead of inventing a row format, and it means a generic FHIR
 * viewer renders the whole summary with no knowledge of Lyfe.
 *
 * Staleness is `Composition.status`: `final` is fresh, `preliminary` is stale.
 * No invented field, and `_lastUpdated` still tells you when it was marked.
 */
import type {
  CodeableConcept,
  Coding,
  Composition,
  CompositionSection,
  Device,
  Narrative,
  Organization,
  Patient,
  Reference,
} from '@medplum/fhirtypes';

// ---------------------------------------------------------------------------
// Identity and coding
// ---------------------------------------------------------------------------

/**
 * Identifier system for the one AI summary per patient. The identifier *value*
 * is the patient id, which is what makes the conditional update in the bot a
 * true upsert: a second generation replaces the summary rather than adding a
 * second Composition to the chart.
 */
export const AI_SUMMARY_IDENTIFIER_SYSTEM = 'https://lyfe.com/ai-summary';

/**
 * LOINC `60591-5` "Patient summary Document" — the code the International
 * Patient Summary uses for exactly this kind of document. Picked over a
 * Lyfe-local code so an external reader knows what the Composition is without
 * knowing us.
 */
export const PATIENT_SUMMARY_LOINC = '60591-5';

/** LOINC `10164-2` "History of present illness Narrative" — the C-CDA HPI section code. */
export const HPI_NARRATIVE_LOINC = '10164-2';

/**
 * Codes for the five blocks. These have no faithful LOINC equivalent (LOINC has
 * no "what to talk about at the next visit" section), so they are Lyfe-local and
 * the UI matches on them. The narrative section additionally carries the real
 * LOINC above.
 */
export const AI_SUMMARY_SECTION_SYSTEM = 'https://lyfe.com/CodeSystem/ai-summary-section';

/** Marks the Composition as this feature's output, for a `category` search. */
export const AI_SUMMARY_CATEGORY_SYSTEM = 'https://lyfe.com/CodeSystem/composition-category';

/** Alert severity, on the alert sub-section's `code`. */
export const AI_SUMMARY_SEVERITY_SYSTEM = 'https://lyfe.com/CodeSystem/ai-summary-severity';

/** Risk level, on the risk sub-section's `code`. */
export const AI_SUMMARY_RISK_LEVEL_SYSTEM = 'https://lyfe.com/CodeSystem/ai-summary-risk-level';

/** Identifier of the Device credited as `Composition.author`. */
export const AI_SUMMARY_DEVICE_IDENTIFIER_SYSTEM = 'https://lyfe.com/ai-summary-device';

export type SummarySectionCode = 'narrative' | 'alerts' | 'risks' | 'focus-areas' | 'care-gaps';

/** Human titles, used as `section.title` and shown by the UI. */
export const SECTION_TITLES: Record<SummarySectionCode, string> = {
  narrative: 'Narrative',
  alerts: 'Alerts',
  risks: 'Risk Factors',
  'focus-areas': 'Next Visit Focus',
  'care-gaps': 'Care Gaps',
};

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type RiskLevel = 'high' | 'moderate' | 'low';

export interface SummaryAlert {
  severity: AlertSeverity;
  message: string;
  action: string;
}

export interface SummaryRisk {
  factor: string;
  level: RiskLevel;
  basis: string;
}

export interface SummaryFocusArea {
  topic: string;
  reason: string;
}

export interface SummaryCareGap {
  gap: string;
  recommendation: string;
}

/** A validated model answer, before it becomes FHIR. */
export interface SummaryDraft {
  narrative: string;
  alerts: SummaryAlert[];
  risks: SummaryRisk[];
  focusAreas: SummaryFocusArea[];
  careGaps: SummaryCareGap[];
}

/**
 * Caps carried over from lyfe-provider-ui's Zod schema, where they were prose in
 * the field descriptions and therefore advisory. Here they are enforced: a model
 * that returns twelve alerts gets four, because a card with twelve alerts is a
 * card nobody reads.
 */
export const MAX_ALERTS = 4;
export const MAX_RISKS = 5;
export const MAX_FOCUS_AREAS = 3;
export const MAX_CARE_GAPS = 3;

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * What a prompt tag letter means. The letters are the ones lyfe-provider-ui
 * used, kept so the system prompt reads the same: C condition, M medication,
 * A allergy, L lab, V vital, E encounter, D document.
 */
export type CitationKind = 'condition' | 'medication' | 'allergy' | 'lab' | 'vital' | 'encounter' | 'document';

export const CITATION_TAG_KINDS: Record<string, CitationKind> = {
  C: 'condition',
  M: 'medication',
  A: 'allergy',
  L: 'lab',
  V: 'vital',
  E: 'encounter',
  D: 'document',
};

/** One citable record: the tag the model is told to use, and what it really is. */
export interface CitationSource {
  /** Prompt tag without brackets, e.g. `C1`. */
  tag: string;
  kind: CitationKind;
  /** The real resource, with `display` set so the UI needs no second read. */
  reference: Reference;
}

// A tag the model may have written. Deliberately not anchored — tags sit mid-sentence.
const CITATION_TAG_PATTERN = /\[([A-Z])(\d{1,3})\]/g;

// The stand-in `rewriteCitations` leaves where an unresolvable tag was, so the
// tag and the space before it can be removed in one pass afterwards. NUL is safe
// to use for this because every string reaching here has been through
// `stripNullBytes`, so it cannot collide with real content.
const DROPPED_TAG_MARK = '\u0000';
// eslint-disable-next-line no-control-regex
const DROPPED_TAG_CLEANUP = / ?\u0000/g;

/**
 * Rewrite prompt tags into entry indices.
 *
 * Takes the strings of one leaf section and the citation index, and returns the
 * same strings with every `[C1]` replaced by `[n]`, where `n` is a 1-based
 * offset into the returned `entries` array. The numbering is shared across all
 * the strings passed in, because they belong to one section and therefore to one
 * `entry[]`.
 *
 * A tag the index does not know is **deleted**, along with the space in front of
 * it. That is the whole point of the exercise: in lyfe-provider-ui a tag the
 * citation table could not resolve was left in the prose and rendered to the
 * provider as literal `[C9]`. A marker here is an array offset, so an
 * unresolvable one cannot be allowed to survive.
 * @param texts - The strings of a single section, in the order they are read.
 * @param citations - Tag (without brackets) to source, as built for the prompt.
 * @returns The rewritten strings and the entries their markers index into.
 */
export function rewriteCitations(
  texts: string[],
  citations: Map<string, CitationSource>
): { texts: string[]; entries: Reference[] } {
  const entries: Reference[] = [];
  const ordinals = new Map<string, number>();

  const rewritten = texts.map((text) =>
    text
      .replace(CITATION_TAG_PATTERN, (match, letter: string, digits: string) => {
        const tag = `${letter}${digits}`;
        const source = citations.get(tag);
        if (!source) {
          return DROPPED_TAG_MARK;
        }
        let ordinal = ordinals.get(tag);
        if (ordinal === undefined) {
          entries.push(source.reference);
          ordinal = entries.length;
          ordinals.set(tag, ordinal);
        }
        return `[${ordinal}]`;
      })
      // Drop the placeholder left by an unresolvable tag, and the space that
      // preceded it, so the sentence does not end up double-spaced.
      .replace(DROPPED_TAG_CLEANUP, '')
      .replace(/\s+([.,;:])/g, '$1')
      .trim()
  );

  return { texts: rewritten, entries };
}

// ---------------------------------------------------------------------------
// Parsing the model's answer
// ---------------------------------------------------------------------------

/**
 * Strip a fenced code block, if the model wrapped its JSON in one.
 * @param text - Raw model output.
 * @returns The text with any surrounding code fence removed.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Strip NUL bytes.
 *
 * Carried over from lyfe-provider-ui, where extracted document text (OCR, PDF,
 * binary decode) held 0x00 and broke both the Postgres write and the gateway
 * call. The document seam here will feed the same text in, and `\u0000` is also
 * the placeholder {@link rewriteCitations} uses internally, so stripping it on
 * the way in keeps that private.
 * @param text - Text that may contain NUL.
 * @returns The text without NUL bytes.
 */
export function stripNullBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000/g, '');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? stripNullBytes(value).trim() : '';
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = typeof value === 'string' ? (value.toLowerCase() as T) : undefined;
  return candidate && allowed.includes(candidate) ? candidate : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Validate and normalise a model answer.
 *
 * Deliberately lenient about rows and strict about the narrative. A malformed
 * alert is dropped; a missing narrative throws. The reasoning: the narrative is
 * the one part a provider reads every time, so a summary without it is a bug
 * worth surfacing, whereas discarding one of four alerts still leaves a useful
 * card and beats showing nothing because the model mistyped a severity.
 * @param text - The model's raw text output.
 * @returns The validated draft.
 */
export function parseSummaryDraft(text: string): SummaryDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new Error('The model did not return JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned JSON that is not an object');
  }
  const object = parsed as Record<string, unknown>;

  const narrative = asString(object.narrative);
  if (!narrative) {
    throw new Error('The model returned no narrative');
  }

  const alerts: SummaryAlert[] = [];
  for (const row of asArray(object.alerts)) {
    const value = (row ?? {}) as Record<string, unknown>;
    const message = asString(value.message);
    if (!message) {
      continue;
    }
    alerts.push({
      severity: asEnum(value.severity, ['critical', 'warning', 'info'] as const, 'info'),
      message,
      action: asString(value.action),
    });
    if (alerts.length === MAX_ALERTS) {
      break;
    }
  }

  const risks: SummaryRisk[] = [];
  for (const row of asArray(object.risks)) {
    const value = (row ?? {}) as Record<string, unknown>;
    const factor = asString(value.factor);
    if (!factor) {
      continue;
    }
    risks.push({
      factor,
      level: asEnum(value.level, ['high', 'moderate', 'low'] as const, 'low'),
      basis: asString(value.basis),
    });
    if (risks.length === MAX_RISKS) {
      break;
    }
  }

  const focusAreas: SummaryFocusArea[] = [];
  for (const row of asArray(object.focusAreas)) {
    const value = (row ?? {}) as Record<string, unknown>;
    const topic = asString(value.topic);
    if (!topic) {
      continue;
    }
    focusAreas.push({ topic, reason: asString(value.reason) });
    if (focusAreas.length === MAX_FOCUS_AREAS) {
      break;
    }
  }

  const careGaps: SummaryCareGap[] = [];
  for (const row of asArray(object.careGaps)) {
    const value = (row ?? {}) as Record<string, unknown>;
    const gap = asString(value.gap);
    if (!gap) {
      continue;
    }
    careGaps.push({ gap, recommendation: asString(value.recommendation) });
    if (careGaps.length === MAX_CARE_GAPS) {
      break;
    }
  }

  return { narrative, alerts, risks, focusAreas, careGaps };
}

// ---------------------------------------------------------------------------
// Narrative XHTML
// ---------------------------------------------------------------------------

/**
 * Escape text for an XHTML narrative. `Narrative.div` is parsed as XML, so an
 * unescaped `&` in a drug name is not a cosmetic problem — it makes the whole
 * resource invalid.
 * @param text - Plain text.
 * @returns The text, safe to place in XHTML.
 */
export function escapeXhtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Wrap plain text as a one-paragraph FHIR narrative.
 * @param text - Plain text, citation markers already rewritten.
 * @returns A generated `Narrative`.
 */
export function toNarrative(text: string): Narrative {
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeXhtml(text)}</p></div>`,
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function sectionCode(code: SummarySectionCode, loinc?: string): CodeableConcept {
  const coding: Coding[] = [{ system: AI_SUMMARY_SECTION_SYSTEM, code }];
  if (loinc) {
    coding.push({ system: 'http://loinc.org', code: loinc });
  }
  return { coding, text: SECTION_TITLES[code] };
}

/**
 * Build one leaf sub-section: a headline, an optional detail paragraph, and the
 * resources the two of them cite.
 * @param props - The row.
 * @param props.headline - The row's one-line label, e.g. an alert message.
 * @param props.detail - The row's supporting line, e.g. the recommended action.
 * @param props.code - Severity or level coding, when the row has one.
 * @param props.citations - The citation index for the whole summary.
 * @returns The sub-section.
 */
function rowSection(props: {
  headline: string;
  detail: string;
  code?: CodeableConcept;
  citations: Map<string, CitationSource>;
}): CompositionSection {
  const { texts, entries } = rewriteCitations([props.headline, props.detail], props.citations);
  const section: CompositionSection = { title: texts[0] };
  if (props.code) {
    section.code = props.code;
  }
  // `cmp-1` requires text, entries or sub-sections. The headline alone lives in
  // `title`, which does not count, so a row with no detail and no citation gets
  // its headline as the narrative too rather than being an invalid section.
  section.text = toNarrative(texts[1] || texts[0]);
  if (entries.length > 0) {
    section.entry = entries;
  }
  return section;
}

/**
 * Turn a validated draft into `Composition.section[]`.
 *
 * Empty blocks are omitted rather than included empty: the card hides a block
 * with no rows, and an empty section would need `emptyReason` to be valid FHIR,
 * which would be inventing a reason the model never gave.
 * @param draft - The validated model answer.
 * @param citations - Tag to source, as built for the prompt.
 * @returns The sections, narrative first.
 */
export function buildSummarySections(
  draft: SummaryDraft,
  citations: Map<string, CitationSource>
): CompositionSection[] {
  const sections: CompositionSection[] = [];

  const narrative = rewriteCitations([draft.narrative], citations);
  sections.push({
    title: SECTION_TITLES.narrative,
    code: sectionCode('narrative', HPI_NARRATIVE_LOINC),
    text: toNarrative(narrative.texts[0]),
    ...(narrative.entries.length > 0 && { entry: narrative.entries }),
  });

  if (draft.alerts.length > 0) {
    sections.push({
      title: SECTION_TITLES.alerts,
      code: sectionCode('alerts'),
      section: draft.alerts.map((alert) =>
        rowSection({
          headline: alert.message,
          detail: alert.action,
          code: { coding: [{ system: AI_SUMMARY_SEVERITY_SYSTEM, code: alert.severity }], text: alert.severity },
          citations,
        })
      ),
    });
  }

  if (draft.risks.length > 0) {
    sections.push({
      title: SECTION_TITLES.risks,
      code: sectionCode('risks'),
      section: draft.risks.map((risk) =>
        rowSection({
          headline: risk.factor,
          detail: risk.basis,
          code: { coding: [{ system: AI_SUMMARY_RISK_LEVEL_SYSTEM, code: risk.level }], text: risk.level },
          citations,
        })
      ),
    });
  }

  if (draft.focusAreas.length > 0) {
    sections.push({
      title: SECTION_TITLES['focus-areas'],
      code: sectionCode('focus-areas'),
      section: draft.focusAreas.map((area) => rowSection({ headline: area.topic, detail: area.reason, citations })),
    });
  }

  if (draft.careGaps.length > 0) {
    sections.push({
      title: SECTION_TITLES['care-gaps'],
      code: sectionCode('care-gaps'),
      section: draft.careGaps.map((gap) => rowSection({ headline: gap.gap, detail: gap.recommendation, citations })),
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// The Composition
// ---------------------------------------------------------------------------

export interface BuildCompositionProps {
  /** The patient the summary is about. `patient.id` is also the identifier value. */
  patient: Reference<Patient> & { reference: string };
  /** The Device credited with writing it. */
  author: Reference<Device>;
  draft: SummaryDraft;
  citations: Map<string, CitationSource>;
  /** ISO instant the summary was generated. */
  generatedAt: string;
  /** The clinic compartment, so clinic users can see it at all. */
  account?: Reference<Organization>;
}

/**
 * Build the Composition.
 *
 * `status` is `final`: a summary that was just generated is fresh by
 * definition. The bot's invalidate path flips an existing one to `preliminary`.
 * @param props - The inputs.
 * @returns The Composition, ready for a conditional update on its identifier.
 */
export function buildSummaryComposition(props: BuildCompositionProps): Composition {
  const patientId = props.patient.reference.split('/')[1];
  return {
    resourceType: 'Composition',
    // Both keys, per the rest of the Lyfe bots: `accounts` is the current field
    // and `account` the deprecated one the compartment search still reads.
    // Without the compartment the write returns 200 and the resource is
    // invisible to every clinic user.
    ...(props.account && { meta: { account: props.account, accounts: [props.account] } }),
    identifier: { system: AI_SUMMARY_IDENTIFIER_SYSTEM, value: patientId },
    status: 'final',
    type: {
      coding: [{ system: 'http://loinc.org', code: PATIENT_SUMMARY_LOINC, display: 'Patient summary Document' }],
      text: 'AI patient summary',
    },
    category: [
      {
        coding: [{ system: AI_SUMMARY_CATEGORY_SYSTEM, code: 'ai-patient-summary' }],
        text: 'AI patient summary',
      },
    ],
    subject: props.patient,
    date: props.generatedAt,
    author: [props.author],
    title: 'AI Patient Summary',
    section: buildSummarySections(props.draft, props.citations),
  };
}

/**
 * The search that finds a patient's summary, for both the bot and the app.
 * @param patientId - The patient the summary is about.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function summarySearchQuery(patientId: string): string {
  return `identifier=${encodeURIComponent(`${AI_SUMMARY_IDENTIFIER_SYSTEM}|${patientId}`)}`;
}
