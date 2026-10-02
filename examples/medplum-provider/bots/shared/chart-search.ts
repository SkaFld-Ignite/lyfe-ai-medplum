// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Natural-language search over one patient's chart: the prompt, the validator
 * and the FHIR queries.
 *
 * Pure — no MedplumClient, no network, no clock. The bot
 * (`bots/chart-search.ts`) makes the `$ai` call and runs the searches; this
 * module turns a question into a search plan and a matched resource into a row,
 * which is the part worth testing without a server or a model.
 *
 * WHAT WAS PORTED, AND WHAT WAS DELETED
 * -------------------------------------
 * lyfe-provider-ui had two overlapping services,
 * `lib/services/unified-search-service.ts` and `lib/services/ai-search-service.ts`.
 * Exactly one idea from them is worth keeping: **synonym expansion**. Asking the
 * model to turn "HTN" into "hypertension" and "high blood pressure" before
 * searching is genuinely the difference between finding a condition and not.
 * That is `expandedTerms` here.
 *
 * Everything else from those files is deliberately gone:
 *
 * - Their **document and procedure legs ran on hardcoded mock arrays**
 *   (`mockDocumentSearch`, `mockProcedureSearch`) and showed fictional records
 *   to real clinicians. Document search here is the real pgvector index via
 *   `/api/rag/search`, run from the browser because only the worker can reach
 *   it; procedure search is a real `Procedure?code:text=` query. Nothing in this
 *   module can return a row that did not come out of a query.
 * - Their **`confidence: number`** field is not carried across. There is no way
 *   to compute it, prod's sibling features filled the same field with a
 *   hardcoded `0.75` and an `85.0`, and a made-up number next to a clinical
 *   search result is worse than no number. `interpretation` — a sentence saying
 *   what was searched for — tells the clinician the same thing honestly, and is
 *   checkable against the results on screen.
 * - Their **date extraction** is gone too. "Recent" meant "last 30 days" in one
 *   prompt and nothing in the other, and a model-invented date window silently
 *   hides records. Results are sorted newest-first instead, which is the same
 *   intent with nothing invented.
 *
 * WHY `:text` AND NOT A LOCAL FILTER
 * ----------------------------------
 * Each query below is a real FHIR search with the terms pushed to the server as
 * `code:text=term1,term2`. Medplum implements `:text` as a case-insensitive
 * infix match over the token's text column — which it builds from `coding.display`
 * and `CodeableConcept.text` — and comma-separated values are OR'd
 * (`buildTokenColumnsWhereConditionTextAndContains`). So "diabetes" matches
 * "Type 2 diabetes mellitus" without this module reading a single resource it
 * then throws away, and the synonyms cost one query rather than one per synonym.
 */
import type { CodeableConcept, Observation, Resource } from '@medplum/fhirtypes';

// NUL is stripped on purpose: extracted document text carries it, Postgres will
// not store it in a `text` column, and `JSON.stringify` would forward it to the
// model and into a search query.
// eslint-disable-next-line no-control-regex
const NUL_PATTERN = /\u0000/g;

/** The record types a question can be routed to. */
export type SearchKind =
  'condition' | 'medication' | 'allergy' | 'lab' | 'vital' | 'encounter' | 'procedure' | 'immunization' | 'document';

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

/** A validated search plan. Note the absence of a confidence score. */
export interface SearchIntent {
  kinds: SearchKind[];
  /** Terms taken from the question itself. */
  terms: string[];
  /** Synonyms, abbreviation expansions and brand/generic alternates. */
  expandedTerms: string[];
  /** One sentence saying what is being searched for. Absent when the model gave none. */
  interpretation?: string;
}

/** One matched record. */
export interface ChartSearchHit {
  /** `Condition/abc`, so the UI can link straight to the resource. */
  reference: string;
  resourceType: string;
  kind: SearchKind;
  /** The record's clinical display text. */
  title: string;
  /** Status, value or content type — whatever the type's one useful second line is. */
  detail?: string;
  /** ISO date or instant, for sorting and display. */
  date?: string;
}

/**
 * Caps. Every one of these is a bound on something that reaches a query or a
 * screen, not a style preference.
 */
export const MAX_TERMS = 12;
/** Per kind. Nine kinds at 20 is already more rows than anyone reads. */
export const MAX_HITS_PER_KIND = 20;
export const MAX_INTERPRETATION_CHARS = 300;
export const MAX_QUERY_CHARS = 400;

/**
 * The system prompt.
 *
 * `$ai` has no structured-output parameter, so the JSON contract is stated here
 * and enforced by {@link parseSearchIntent} rather than by the model. The last
 * two rules are the important ones: the model is choosing what to look for, and
 * is explicitly told not to answer the question or produce findings, because its
 * answer is never shown — only the records the searches return are.
 */
export const CHART_SEARCH_SYSTEM_PROMPT = `You are a clinical chart search assistant. You turn a clinician's question into a search plan over one patient's FHIR chart.

Reply with ONLY a JSON object. No prose, no explanation, no code fence.

{
  "kinds": ["condition"],
  "terms": ["hypertension"],
  "expandedTerms": ["high blood pressure", "HTN", "elevated blood pressure"],
  "interpretation": "Conditions recorded as hypertension"
}

"kinds" must be drawn from exactly this list, and must name only the record types that could answer the question. Pick as few as possible:
  condition, medication, allergy, lab, vital, encounter, procedure, immunization, document

"terms" are the clinical words from the question, written as they would appear in a medical record.
"expandedTerms" are synonyms, abbreviation expansions, and brand/generic drug alternates for those words.

Rules:
- Terms are matched against the DISPLAY TEXT of coded records. Write clinical terms, never questions or sentences.
- Expand abbreviations in both directions: "HTN" -> "hypertension", "high blood pressure". "T2DM" -> "diabetes mellitus", "type 2 diabetes". "MI" -> "myocardial infarction", "heart attack". "CKD" -> "chronic kidney disease", "renal failure".
- Give brand and generic drug names for each other: "Coumadin" -> "warfarin"; "metoprolol" -> "Lopressor", "Toprol".
- Never include the patient's name, a date, a date range, or a relative word such as "recent", "last" or "current". Results are returned newest first, so time is handled for you.
- If the question names no clinical concept at all, return empty "terms" and empty "expandedTerms".
- Do NOT answer the clinical question. Do NOT state findings, risks or conclusions. You are only choosing what to look for.`;

/**
 * Build the user message for one question.
 * @param query - The clinician's question, already length-capped by the caller.
 * @returns The user message.
 */
export function buildSearchPrompt(query: string): string {
  return `Patient chart question: ${query}`;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && (SEARCH_KINDS as readonly string[]).includes(value);
}

/**
 * Normalise a list of model-supplied terms.
 *
 * Deduped case-insensitively because the model routinely echoes a term into
 * `expandedTerms` as well, and a duplicate in a comma-separated `:text` value is
 * a redundant regex branch in the SQL.
 * @param value - Whatever the model put there.
 * @param taken - Lowercased terms already accepted, mutated as terms are taken.
 * @returns The accepted terms, in order.
 */
function normaliseTerms(value: unknown, taken: Set<string>): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    // Checked before taking, not after: `taken` is shared across the two calls,
    // so a post-check lets the second list take one term past the cap.
    if (taken.size >= MAX_TERMS) {
      break;
    }
    if (typeof entry !== 'string') {
      continue;
    }
    // Commas are the OR delimiter in a `:text` value, so a term containing one
    // would silently become two half-terms in the query.
    const term = entry.replace(NUL_PATTERN, ' ').replace(/,/g, ' ').trim().slice(0, 80);
    const key = term.toLowerCase();
    if (!term || taken.has(key)) {
      continue;
    }
    taken.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Validate and normalise the model's search plan.
 *
 * Lenient about the parts a bad value only narrows — an unknown `kind` is
 * dropped, a missing `interpretation` is simply absent — and strict about the
 * shape, because a plan that is not an object means the model did not follow the
 * contract and guessing at its intent would be inventing one.
 * @param text - The model's raw output.
 * @returns The validated plan.
 */
export function parseSearchIntent(text: string): SearchIntent {
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

  const kinds: SearchKind[] = [];
  for (const entry of Array.isArray(object.kinds) ? object.kinds : []) {
    if (isSearchKind(entry) && !kinds.includes(entry)) {
      kinds.push(entry);
    }
  }

  const taken = new Set<string>();
  const terms = normaliseTerms(object.terms, taken);
  const expandedTerms = normaliseTerms(object.expandedTerms, taken);

  const interpretation =
    typeof object.interpretation === 'string'
      ? object.interpretation.replace(NUL_PATTERN, '').trim().slice(0, MAX_INTERPRETATION_CHARS) || undefined
      : undefined;

  return {
    // No kinds chosen means the model did not narrow, not that nothing should be
    // searched. Searching everything is the honest reading and is still bounded.
    kinds: kinds.length > 0 ? kinds : [...SEARCH_KINDS],
    terms,
    expandedTerms,
    interpretation,
  };
}

/** One FHIR search to run. */
export interface ChartSearchQuery {
  kind: SearchKind;
  resourceType:
    | 'Condition'
    | 'MedicationRequest'
    | 'AllergyIntolerance'
    | 'Observation'
    | 'Encounter'
    | 'Procedure'
    | 'Immunization';
  /** Query string parameters, ready for `medplum.searchResources`. */
  params: Record<string, string>;
}

/**
 * How each kind is searched.
 *
 * `patientParam` differs by type and getting it wrong is a silent empty result
 * rather than an error: `AllergyIntolerance` and `Immunization` take `patient`,
 * the rest take `subject`. `textParam` is the token search parameter whose
 * display text the terms are matched against — verified present in
 * `packages/definitions` for every type here.
 *
 * `document` is absent on purpose. Document *text* search is the pgvector index,
 * which only `services/lyfe-worker` can reach, so the browser runs that leg
 * against `/api/rag/search` and this bot never tries to.
 */
const KIND_SEARCH: Record<
  Exclude<SearchKind, 'document'>,
  {
    resourceType: ChartSearchQuery['resourceType'];
    patientParam: 'subject' | 'patient';
    textParam: string;
    extra?: Record<string, string>;
    sort: string;
  }
> = {
  condition: { resourceType: 'Condition', patientParam: 'subject', textParam: 'code', sort: '-recorded-date' },
  medication: { resourceType: 'MedicationRequest', patientParam: 'subject', textParam: 'code', sort: '-authoredon' },
  allergy: { resourceType: 'AllergyIntolerance', patientParam: 'patient', textParam: 'code', sort: '-date' },
  lab: {
    resourceType: 'Observation',
    patientParam: 'subject',
    textParam: 'code',
    extra: { category: 'laboratory' },
    sort: '-date',
  },
  vital: {
    resourceType: 'Observation',
    patientParam: 'subject',
    textParam: 'code',
    extra: { category: 'vital-signs' },
    sort: '-date',
  },
  encounter: { resourceType: 'Encounter', patientParam: 'subject', textParam: 'type', sort: '-date' },
  procedure: { resourceType: 'Procedure', patientParam: 'subject', textParam: 'code', sort: '-date' },
  immunization: { resourceType: 'Immunization', patientParam: 'patient', textParam: 'vaccine-code', sort: '-date' },
};

/**
 * Turn a validated plan into the FHIR searches to run.
 *
 * Returns nothing when the plan has no terms. That is the honest outcome: with
 * no clinical concept to match there is no search to run, and listing the whole
 * chart would be a different feature pretending to be an answer.
 * @param props - The plan and the patient.
 * @param props.patientId - The chart to search.
 * @param props.intent - The validated plan.
 * @returns The searches, one per requested kind.
 */
export function buildChartSearchQueries(props: { patientId: string; intent: SearchIntent }): ChartSearchQuery[] {
  const terms = [...props.intent.terms, ...props.intent.expandedTerms];
  if (terms.length === 0) {
    return [];
  }
  const value = terms.join(',');

  const queries: ChartSearchQuery[] = [];
  for (const kind of props.intent.kinds) {
    if (kind === 'document') {
      continue;
    }
    const spec = KIND_SEARCH[kind];
    queries.push({
      kind,
      resourceType: spec.resourceType,
      params: {
        [spec.patientParam]: `Patient/${props.patientId}`,
        [`${spec.textParam}:text`]: value,
        ...spec.extra,
        _sort: spec.sort,
        _count: String(MAX_HITS_PER_KIND),
      },
    });
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Turning a matched resource into a row
// ---------------------------------------------------------------------------

function conceptLabel(concept: CodeableConcept | undefined): string {
  return concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? concept?.coding?.[0]?.code ?? '';
}

function observationValue(observation: Observation): string | undefined {
  const quantity = observation.valueQuantity;
  if (quantity?.value !== undefined) {
    return `${quantity.value}${quantity.unit ? ` ${quantity.unit}` : ''}`;
  }
  if (observation.valueString) {
    return observation.valueString;
  }
  if (observation.valueCodeableConcept) {
    return conceptLabel(observation.valueCodeableConcept) || undefined;
  }
  if (observation.valueBoolean !== undefined) {
    return observation.valueBoolean ? 'Yes' : 'No';
  }
  return undefined;
}

/**
 * Summarise a matched resource as one row.
 *
 * Per type rather than through `getDisplayString`, because the useful title of a
 * matched record is its clinical concept — the condition, the drug, the analyte —
 * and the useful second line differs: a status for a condition, a value for an
 * observation, a content type for a document.
 *
 * A resource with no readable title is returned with its reference as the title
 * rather than dropped. It matched a real query; hiding it would be the one
 * dishonest thing this function could do.
 * @param resource - The matched resource.
 * @param kind - Which leg of the search returned it.
 * @returns The row.
 */
export function toChartSearchHit(resource: Resource, kind: SearchKind): ChartSearchHit {
  const reference = `${resource.resourceType}/${resource.id ?? ''}`;
  let title = '';
  let detail: string | undefined;
  let date: string | undefined;

  switch (resource.resourceType) {
    case 'Condition': {
      const condition = resource;
      title = conceptLabel(condition.code);
      detail = conceptLabel(condition.clinicalStatus) || undefined;
      date = condition.onsetDateTime ?? condition.recordedDate;
      break;
    }
    case 'MedicationRequest': {
      const request = resource;
      title = conceptLabel(request.medicationCodeableConcept) || (request.medicationReference?.display ?? '');
      detail = request.status;
      date = request.authoredOn;
      break;
    }
    case 'AllergyIntolerance': {
      const allergy = resource;
      title = conceptLabel(allergy.code);
      detail = allergy.criticality ?? (conceptLabel(allergy.clinicalStatus) || undefined);
      date = allergy.recordedDate;
      break;
    }
    case 'Observation': {
      const observation = resource;
      title = conceptLabel(observation.code);
      detail = observationValue(observation);
      date = observation.effectiveDateTime ?? observation.issued;
      break;
    }
    case 'Encounter': {
      const encounter = resource;
      title = conceptLabel(encounter.type?.[0]) || encounter.class?.display || 'Encounter';
      detail = encounter.status;
      date = encounter.period?.start;
      break;
    }
    case 'Procedure': {
      const procedure = resource;
      title = conceptLabel(procedure.code);
      detail = procedure.status;
      date = procedure.performedDateTime ?? procedure.performedPeriod?.start;
      break;
    }
    case 'Immunization': {
      const immunization = resource;
      title = conceptLabel(immunization.vaccineCode);
      detail = immunization.status;
      date = immunization.occurrenceDateTime;
      break;
    }
    case 'DocumentReference': {
      const document = resource;
      title = document.description ?? conceptLabel(document.type);
      detail = document.content?.[0]?.attachment?.contentType;
      date = document.date;
      break;
    }
    default:
      break;
  }

  return {
    reference,
    resourceType: resource.resourceType,
    kind,
    title: title || reference,
    ...(detail && { detail }),
    ...(date && { date }),
  };
}

/**
 * Sort rows newest first, undated last.
 *
 * This replaces prod's model-extracted date window: the clinician asked about a
 * concept, so the newest records matching it are the ones they want, and nothing
 * has to be hidden to achieve that.
 * @param hits - The rows.
 * @returns The same rows, sorted.
 */
export function sortChartSearchHits(hits: ChartSearchHit[]): ChartSearchHit[] {
  return [...hits].sort((a, b) => {
    if (a.date && b.date) {
      if (a.date === b.date) {
        return 0;
      }
      return a.date < b.date ? 1 : -1;
    }
    if (a.date) {
      return -1;
    }
    return b.date ? 1 : 0;
  });
}
