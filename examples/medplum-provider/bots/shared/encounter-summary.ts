// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-visit and post-visit encounter summaries, as FHIR `Composition`s.
 *
 * Everything here is pure: no MedplumClient, no network, no clock. The bot
 * (`bots/encounter-summary.ts`) does the reads and the `$ai` call; this module
 * turns a model answer into a validated draft and a draft into the Composition.
 *
 * WHY COMPOSITION FOR BOTH
 * ------------------------
 * `ClinicalImpression` is the closer semantic fit for the post-visit summary
 * specifically — it is literally "a clinician's assessment of a patient" — and it
 * was the obvious candidate. It is not used, for two reasons:
 *
 *  1. Two sibling features would then be two resource types, so every reader,
 *     every search and every test would fork on which half of the feature it was
 *     looking at, for no gain on the pre-visit half (a briefing written *before*
 *     the visit is not an impression of it).
 *  2. In this app `ClinicalImpression` is already taken: `useEncounterChart`
 *     conditionally creates exactly one per encounter and `EncounterChart`'s
 *     Textarea edits its `note[0].text` as the provider's chart note. Writing AI
 *     output into that resource would put generated text in the field the
 *     provider signs, which is the one place it must not appear unasked. "Pull
 *     into note" moves it there, on an explicit click, and that is the whole
 *     point of having a separate home for the draft.
 *
 * So: `Composition` for both, `type` telling them apart, `encounter` set, and
 * `section[]` mapping 1:1 onto the fields of lyfe-provider-ui's two Zod schemas.
 *
 * WHAT REPLACED THE JSON BLOB
 * ---------------------------
 * lyfe-provider-ui stored each summary as a JSON blob on
 * `Appointment.aiPreVisitSummary` / `aiPostVisitSummary`, and skipped storing it
 * at all for an encounter with no Prisma row. Here the identifier is the
 * encounter id, so the conditional update in the bot is a true upsert — a second
 * generation replaces the summary rather than stacking another one on the chart —
 * and there is no such thing as an encounter it cannot be stored against.
 *
 * Citations are `section.entry[]` references with `[n]` markers that index into
 * them, exactly as in `ai-summary.ts`; `rewriteCitations` is imported from there
 * rather than reimplemented, so the two features cannot drift on the one piece of
 * mechanism they share.
 */
import type {
  CodeableConcept,
  Coding,
  Composition,
  CompositionSection,
  Device,
  Encounter,
  Organization,
  Patient,
  Reference,
} from '@medplum/fhirtypes';
import type { CitationSource } from './ai-summary.ts';
import { rewriteCitations, stripCodeFence, stripNullBytes, toNarrative } from './ai-summary.ts';
import type { SummaryKind } from './encounter-summary-prompt.ts';

// ---------------------------------------------------------------------------
// Identity and coding
// ---------------------------------------------------------------------------

/**
 * Identifier system per kind. The identifier *value* is the encounter id, which
 * is what makes the conditional update a true upsert. Two systems rather than one
 * system with a composite value, so the search is an exact `system|value` match
 * and an encounter can carry one of each without them colliding.
 */
export const ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM: Record<SummaryKind, string> = {
  'pre-visit': 'https://lyfe.com/pre-visit-summary',
  'post-visit': 'https://lyfe.com/post-visit-summary',
};

/** `Composition.type`, distinguishing the two. The UI matches on this. */
export const ENCOUNTER_SUMMARY_TYPE_SYSTEM = 'https://lyfe.com/CodeSystem/encounter-summary-type';

/** Marks the Composition as this feature's output, for a `category` search. Shared with the patient summary. */
export const ENCOUNTER_SUMMARY_CATEGORY_SYSTEM = 'https://lyfe.com/CodeSystem/composition-category';

/** `section.code`, naming which schema field a section carries. */
export const ENCOUNTER_SUMMARY_SECTION_SYSTEM = 'https://lyfe.com/CodeSystem/encounter-summary-section';

/**
 * The qualifier a row carries on its own `code`: a condition's status, a
 * medication's relevance, a change's or finding's significance, a prep item's
 * priority.
 *
 * One system rather than five. The value sets are disjoint and the *section* code
 * already says which one applies, so a reader needs one lookup instead of a
 * switch — and the row renderer keys its colour off a single `data-` attribute,
 * which is exactly what prod did with its five separate ternaries.
 */
export const ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM = 'https://lyfe.com/CodeSystem/encounter-summary-qualifier';

/** Identifier of the Device credited as `Composition.author`. Shared with the patient summary. */
export const AI_SUMMARY_DEVICE_IDENTIFIER_SYSTEM = 'https://lyfe.com/ai-summary-device';

/**
 * LOINC `11506-3` "Progress note".
 *
 * Carried on the post-visit Composition only, because that is what prod's own
 * system prompt calls it ("a structured progress-note summary"). The pre-visit
 * briefing gets no LOINC: there is no LOINC concept for "the chart review a
 * provider reads on the way into the room", and inventing a near-miss would tell
 * an external reader something untrue. Its Lyfe-local type code is the honest
 * answer until a real one is identified.
 */
export const PROGRESS_NOTE_LOINC = '11506-3';

/** Human titles, used as `section.title` and shown by the UI. */
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

/** Composition titles, as prod's two card headers read. */
export const COMPOSITION_TITLES: Record<SummaryKind, string> = {
  'pre-visit': 'Pre-Visit Summary',
  'post-visit': 'Post-Visit Summary',
};

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

export type ConditionStatus = 'active' | 'chronic' | 'resolving';
export type ChangeSignificance = 'notable' | 'routine';
export type PrepPriority = 'high' | 'medium' | 'low';
export type FindingSignificance = 'critical' | 'abnormal' | 'normal';

/** `relevantToVisit`, as a code. Prod's UI showed only the relevant ones. */
export type MedicationRelevance = 'relevant' | 'not-relevant';

export interface PreVisitDraft {
  reasonForVisit: string;
  relevantHistory: { condition: string; relevance: string; status: ConditionStatus }[];
  currentMedications: { name: string; relevantToVisit: boolean; note: string | null }[];
  recentChanges: { change: string; date: string; significance: ChangeSignificance }[];
  prepItems: { item: string; priority: PrepPriority }[];
}

export interface PostVisitDraft {
  visitOutcome: string;
  keyFindings: { finding: string; significance: FindingSignificance }[];
  decisionsMade: { decision: string; rationale: string }[];
  followUpPlan: { action: string; timeframe: string }[];
  unresolvedItems: { item: string; reason: string }[];
}

/**
 * Row caps.
 *
 * In lyfe-provider-ui these were prose in the Zod field descriptions and in the
 * system prompt, which made them advisory — the schema said "max 5" and nothing
 * enforced it. Here they are enforced, because a prep list of twelve items is a
 * list nobody reads. Values follow the prompts rather than the schema where the
 * two disagreed (the prompt asked for 3-6 prep items; the schema said 4).
 */
export const MAX_ROWS = {
  relevantHistory: 6,
  currentMedications: 10,
  recentChanges: 5,
  prepItems: 6,
  keyFindings: 5,
  decisionsMade: 5,
  followUpPlan: 4,
  unresolvedItems: 3,
} as const;

// ---------------------------------------------------------------------------
// Parsing the model's answer
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? stripNullBytes(value).trim() : '';
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = typeof value === 'string' ? (value.toLowerCase() as T) : undefined;
  return candidate && allowed.includes(candidate) ? candidate : fallback;
}

function asObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new Error('The model did not return JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned JSON that is not an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Map rows, dropping the ones with no headline and stopping at the cap.
 * @param value - The model's array for this field, if it even is one.
 * @param limit - The row cap.
 * @param map - Row mapper; returns undefined to drop the row.
 * @returns The kept rows.
 */
function rows<T>(value: unknown, limit: number, map: (row: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: T[] = [];
  for (const entry of value) {
    const mapped = map((entry ?? {}) as Record<string, unknown>);
    if (mapped !== undefined) {
      kept.push(mapped);
    }
    if (kept.length === limit) {
      break;
    }
  }
  return kept;
}

/**
 * Validate and normalise a pre-visit model answer.
 *
 * Lenient about rows and strict about `reasonForVisit`, on the same reasoning as
 * `parseSummaryDraft`: the headline is the one line a provider reads every time,
 * so a briefing without it is a bug worth surfacing, whereas dropping one
 * malformed prep item still leaves a useful card.
 * @param text - The model's raw text output.
 * @returns The validated draft.
 */
export function parsePreVisitDraft(text: string): PreVisitDraft {
  const object = asObject(text);

  const reasonForVisit = asString(object.reasonForVisit);
  if (!reasonForVisit) {
    throw new Error('The model returned no reasonForVisit');
  }

  return {
    reasonForVisit,
    relevantHistory: rows(object.relevantHistory, MAX_ROWS.relevantHistory, (row) => {
      const condition = asString(row.condition);
      return condition
        ? {
            condition,
            relevance: asString(row.relevance),
            status: asEnum(row.status, ['active', 'chronic', 'resolving'] as const, 'active'),
          }
        : undefined;
    }),
    currentMedications: rows(object.currentMedications, MAX_ROWS.currentMedications, (row) => {
      const name = asString(row.name);
      const note = asString(row.note);
      // Anything other than an explicit `false` counts as relevant: the model
      // omitting the flag is far more common than it meaning "ignore this drug",
      // and a relevant medication hidden from the card is the worse failure.
      return name ? { name, relevantToVisit: row.relevantToVisit !== false, note: note || null } : undefined;
    }),
    recentChanges: rows(object.recentChanges, MAX_ROWS.recentChanges, (row) => {
      const change = asString(row.change);
      return change
        ? {
            change,
            date: asString(row.date),
            significance: asEnum(row.significance, ['notable', 'routine'] as const, 'routine'),
          }
        : undefined;
    }),
    prepItems: rows(object.prepItems, MAX_ROWS.prepItems, (row) => {
      const item = asString(row.item);
      return item ? { item, priority: asEnum(row.priority, ['high', 'medium', 'low'] as const, 'medium') } : undefined;
    }),
  };
}

/**
 * Validate and normalise a post-visit model answer. Strict about `visitOutcome`
 * for the same reason {@link parsePreVisitDraft} is strict about its headline.
 * @param text - The model's raw text output.
 * @returns The validated draft.
 */
export function parsePostVisitDraft(text: string): PostVisitDraft {
  const object = asObject(text);

  const visitOutcome = asString(object.visitOutcome);
  if (!visitOutcome) {
    throw new Error('The model returned no visitOutcome');
  }

  return {
    visitOutcome,
    keyFindings: rows(object.keyFindings, MAX_ROWS.keyFindings, (row) => {
      const finding = asString(row.finding);
      return finding
        ? {
            finding,
            significance: asEnum(row.significance, ['critical', 'abnormal', 'normal'] as const, 'normal'),
          }
        : undefined;
    }),
    decisionsMade: rows(object.decisionsMade, MAX_ROWS.decisionsMade, (row) => {
      const decision = asString(row.decision);
      return decision ? { decision, rationale: asString(row.rationale) } : undefined;
    }),
    followUpPlan: rows(object.followUpPlan, MAX_ROWS.followUpPlan, (row) => {
      const action = asString(row.action);
      return action ? { action, timeframe: asString(row.timeframe) } : undefined;
    }),
    unresolvedItems: rows(object.unresolvedItems, MAX_ROWS.unresolvedItems, (row) => {
      const item = asString(row.item);
      return item ? { item, reason: asString(row.reason) } : undefined;
    }),
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function sectionCode(code: string): CodeableConcept {
  return { coding: [{ system: ENCOUNTER_SUMMARY_SECTION_SYSTEM, code }], text: SECTION_TITLES[code] ?? code };
}

function qualifier(code: string): CodeableConcept {
  return { coding: [{ system: ENCOUNTER_SUMMARY_QUALIFIER_SYSTEM, code }], text: code };
}

/**
 * Build one leaf row section: a headline, an optional supporting line, the
 * qualifier that colours it, and the resources the two strings cite.
 *
 * Mirrors `rowSection` in `ai-summary.ts`, including why the headline is
 * repeated into `text` when there is no detail: `cmp-1` requires text, entries or
 * sub-sections, and `title` does not count.
 * @param props - The row.
 * @param props.headline - The row's one-line label.
 * @param props.detail - The row's supporting line, or empty.
 * @param props.code - The row's qualifier code, when it has one.
 * @param props.citations - The citation index for the whole summary.
 * @returns The sub-section.
 */
function rowSection(props: {
  headline: string;
  detail: string;
  code?: string;
  citations: Map<string, CitationSource>;
}): CompositionSection {
  const { texts, entries } = rewriteCitations([props.headline, props.detail], props.citations);
  const section: CompositionSection = { title: texts[0] };
  if (props.code) {
    section.code = qualifier(props.code);
  }
  section.text = toNarrative(texts[1] || texts[0]);
  if (entries.length > 0) {
    section.entry = entries;
  }
  return section;
}

/**
 * The headline section: a one-paragraph narrative and whatever it cites.
 * @param code - The section code.
 * @param text - The headline prose, with prompt tags still in it.
 * @param citations - The citation index.
 * @returns The section.
 */
function headlineSection(code: string, text: string, citations: Map<string, CitationSource>): CompositionSection {
  const { texts, entries } = rewriteCitations([text], citations);
  return {
    title: SECTION_TITLES[code],
    code: sectionCode(code),
    text: toNarrative(texts[0]),
    ...(entries.length > 0 && { entry: entries }),
  };
}

/**
 * A block section, or nothing when the model returned no rows for it.
 *
 * Empty blocks are omitted rather than included empty, matching `ai-summary.ts`:
 * the card hides a block with no rows, and an empty section would need
 * `emptyReason` to be valid FHIR, which would mean inventing a reason the model
 * never gave.
 * @param code - The section code.
 * @param children - The row sections.
 * @returns The block, or undefined.
 */
function blockSection(code: string, children: CompositionSection[]): CompositionSection | undefined {
  return children.length > 0 ? { title: SECTION_TITLES[code], code: sectionCode(code), section: children } : undefined;
}

function compact(sections: (CompositionSection | undefined)[]): CompositionSection[] {
  return sections.filter((section): section is CompositionSection => section !== undefined);
}

/**
 * Turn a validated pre-visit draft into `Composition.section[]`, one section per
 * schema field and in schema order.
 * @param draft - The validated model answer.
 * @param citations - Tag to source, as built for the prompt.
 * @returns The sections, headline first.
 */
export function buildPreVisitSections(
  draft: PreVisitDraft,
  citations: Map<string, CitationSource>
): CompositionSection[] {
  return compact([
    headlineSection('reason-for-visit', draft.reasonForVisit, citations),
    blockSection(
      'relevant-history',
      draft.relevantHistory.map((row) =>
        rowSection({ headline: row.condition, detail: row.relevance, code: row.status, citations })
      )
    ),
    blockSection(
      'current-medications',
      draft.currentMedications.map((row) =>
        rowSection({
          headline: row.name,
          detail: row.note ?? '',
          code: row.relevantToVisit ? 'relevant' : 'not-relevant',
          citations,
        })
      )
    ),
    blockSection(
      'recent-changes',
      draft.recentChanges.map((row) =>
        rowSection({ headline: row.change, detail: row.date, code: row.significance, citations })
      )
    ),
    blockSection(
      'prep-items',
      draft.prepItems.map((row) => rowSection({ headline: row.item, detail: '', code: row.priority, citations }))
    ),
  ]);
}

/**
 * Turn a validated post-visit draft into `Composition.section[]`, one section per
 * schema field and in schema order.
 *
 * `followUpPlan.timeframe` goes in the row's narrative rather than its qualifier:
 * it is free text the model writes ("12 weeks", "sooner if jaundice"), and free
 * text in a `code` would be a code system with infinite members. The UI renders
 * that one block's detail as a badge, which is what prod did with it.
 * @param draft - The validated model answer.
 * @param citations - Tag to source, as built for the prompt.
 * @returns The sections, headline first.
 */
export function buildPostVisitSections(
  draft: PostVisitDraft,
  citations: Map<string, CitationSource>
): CompositionSection[] {
  return compact([
    headlineSection('visit-outcome', draft.visitOutcome, citations),
    blockSection(
      'key-findings',
      draft.keyFindings.map((row) =>
        rowSection({ headline: row.finding, detail: '', code: row.significance, citations })
      )
    ),
    blockSection(
      'decisions-made',
      draft.decisionsMade.map((row) => rowSection({ headline: row.decision, detail: row.rationale, citations }))
    ),
    blockSection(
      'follow-up-plan',
      draft.followUpPlan.map((row) => rowSection({ headline: row.action, detail: row.timeframe, citations }))
    ),
    blockSection(
      'unresolved-items',
      draft.unresolvedItems.map((row) => rowSection({ headline: row.item, detail: row.reason, citations }))
    ),
  ]);
}

// ---------------------------------------------------------------------------
// The Composition
// ---------------------------------------------------------------------------

function compositionType(kind: SummaryKind): CodeableConcept {
  const coding: Coding[] = [{ system: ENCOUNTER_SUMMARY_TYPE_SYSTEM, code: kind }];
  if (kind === 'post-visit') {
    coding.push({ system: 'http://loinc.org', code: PROGRESS_NOTE_LOINC, display: 'Progress note' });
  }
  return { coding, text: `AI ${kind} summary` };
}

export interface BuildEncounterSummaryProps {
  kind: SummaryKind;
  /** The encounter the summary is about. `encounter.id` is also the identifier value. */
  encounter: Reference<Encounter> & { reference: string };
  /** The patient, as `Composition.subject`. */
  patient: Reference<Patient>;
  /** The Device credited with writing it. */
  author: Reference<Device>;
  draft: PreVisitDraft | PostVisitDraft;
  citations: Map<string, CitationSource>;
  /** ISO instant the summary was generated. */
  generatedAt: string;
  /** The clinic compartment, so clinic users can see it at all. */
  account?: Reference<Organization>;
}

/**
 * Build the Composition.
 *
 * `status` is `final`: a summary that was just generated is fresh by definition.
 * The field is also what a future invalidation path would flip to `preliminary`,
 * the way `patient-ai-summary.ts` does from a Subscription — nothing writes
 * `preliminary` here yet, and the reader treats it as "stale" if it ever appears.
 * @param props - The inputs.
 * @returns The Composition, ready for a conditional update on its identifier.
 */
export function buildEncounterSummaryComposition(props: BuildEncounterSummaryProps): Composition {
  const encounterId = props.encounter.reference.split('/')[1];
  const sections =
    props.kind === 'pre-visit'
      ? buildPreVisitSections(props.draft as PreVisitDraft, props.citations)
      : buildPostVisitSections(props.draft as PostVisitDraft, props.citations);

  return {
    resourceType: 'Composition',
    // Both keys, per the rest of the Lyfe bots: `accounts` is the current field
    // and `account` the deprecated one the compartment search still reads.
    // Without the compartment the write returns 200 and the resource is
    // invisible to every clinic user.
    ...(props.account && { meta: { account: props.account, accounts: [props.account] } }),
    identifier: { system: ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM[props.kind], value: encounterId },
    status: 'final',
    type: compositionType(props.kind),
    category: [
      {
        coding: [{ system: ENCOUNTER_SUMMARY_CATEGORY_SYSTEM, code: `ai-${props.kind}-summary` }],
        text: `AI ${props.kind} summary`,
      },
    ],
    subject: props.patient,
    encounter: props.encounter,
    date: props.generatedAt,
    author: [props.author],
    title: COMPOSITION_TITLES[props.kind],
    section: sections,
  };
}

/**
 * Read one section's narrative back out of a stored Composition, as plain text.
 *
 * Used for the two bits of cross-summary context the prompts want: the patient AI
 * summary's narrative in the pre-visit briefing, and this encounter's stored
 * `reasonForVisit` in the post-visit planned-vs-actual line. Tag-stripping rather
 * than DOM parsing, for the same reason `plainTextFromDiv` on the app side is:
 * the writer is always one escaped `<p>`, so there is no structure to preserve.
 * @param composition - The stored Composition.
 * @param system - The section code system to match on.
 * @param code - The section code.
 * @returns The section's text, or undefined when it has none.
 */
export function sectionText(composition: Composition, system: string, code: string): string | undefined {
  const section = composition.section?.find((candidate) =>
    candidate.code?.coding?.some((coding) => coding.system === system && coding.code === code)
  );
  const text = section?.text?.div
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

/**
 * The search that finds one encounter's summary, for both the bot and the app.
 * @param kind - Which summary.
 * @param encounterId - The encounter the summary is about.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function encounterSummarySearchQuery(kind: SummaryKind, encounterId: string): string {
  return `identifier=${encodeURIComponent(`${ENCOUNTER_SUMMARY_IDENTIFIER_SYSTEM[kind]}|${encounterId}`)}`;
}
