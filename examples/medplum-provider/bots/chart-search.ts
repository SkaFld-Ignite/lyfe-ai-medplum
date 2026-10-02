// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Natural-language search over one patient's chart.
 *
 * Ported from lyfe-provider-ui's `lib/services/unified-search-service.ts` and
 * `lib/services/ai-search-service.ts`, keeping the one idea in them that worked
 * — asking the model to expand "HTN" into "hypertension" before searching — and
 * dropping the mock document and procedure legs those services shipped. See the
 * header of `shared/chart-search.ts` for what was deleted and why.
 *
 * WHAT THIS BOT DOES AND DOES NOT DO
 * ----------------------------------
 * It uses the model for exactly one thing: turning a question into a list of
 * record types and a list of search terms. It then runs real FHIR searches for
 * those terms and returns the matched resources. The model's own words never
 * reach the clinician except as `interpretation`, a sentence saying what was
 * searched for, which the results on screen either bear out or do not. The model
 * is explicitly told not to answer the clinical question, because an answer it
 * produced would be ungrounded prose dressed as a search result.
 *
 * There is no confidence score. lyfe-provider-ui's schema had one; its siblings
 * filled the same field with a hardcoded `0.75` and an `85.0`, and there is no
 * honest way to compute it here either.
 *
 * WHY THE DOCUMENT LEG IS NOT HERE
 * --------------------------------
 * Document text lives in `lyfe_rag`, a pgvector index on the Medplum Postgres
 * that only `services/lyfe-worker` can reach, and a similarity search is not
 * expressible over FHIR REST in any case. This bot runs on `vmcontext` with no
 * database access and must not gain any — the same constraint
 * `patient-ai-summary.ts` documents. So the browser runs that leg itself against
 * `/api/rag/search` (`src/services/document-search.ts`) and merges the two sets.
 * The worker resolves the organization from the caller's token rather than from
 * the request body, so the clinic cannot be chosen by the caller.
 *
 * NO `Promise.all` AROUND SEARCHES
 * --------------------------------
 * Concurrent Medplum searches auto-batch and the batch flush uses `setTimeout`,
 * which the `vmcontext` sandbox does not have — the bot hangs forever with no
 * error. The loop below awaits one search at a time on purpose. This is the one
 * place it would be most tempting to parallelise, since the legs are
 * independent.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Parameters, Resource } from '@medplum/fhirtypes';
import type { ChartSearchHit, SearchIntent } from './shared/chart-search.ts';
import {
  buildChartSearchQueries,
  buildSearchPrompt,
  CHART_SEARCH_SYSTEM_PROMPT,
  MAX_QUERY_CHARS,
  parseSearchIntent,
  sortChartSearchHits,
  toChartSearchHit,
} from './shared/chart-search.ts';

/** Matches the other Lyfe bots: `$ai` forwards this to whatever `LLM_BASE_URL` points at. */
export const DEFAULT_SEARCH_MODEL = 'global.anthropic.claude-sonnet-4-6';

/**
 * Zero, not the summariser's 0.3.
 *
 * Choosing which record types to search and which synonyms a term has is a
 * lookup, not a piece of writing: the same question should produce the same
 * search every time, or a clinician who re-runs it gets a different chart.
 */
const SEARCH_TEMPERATURE = 0;

export interface ChartSearchInput {
  patientId?: string;
  query?: string;
  /** Overrides {@link DEFAULT_SEARCH_MODEL}. */
  model?: string;
}

export interface ChartSearchResult {
  ok: boolean;
  /** One sentence saying what was searched for. Absent when the model gave none. */
  interpretation?: string;
  /** Every term that went into the queries, so the UI can show what was matched. */
  terms?: string[];
  /** The record types that were searched, so "nothing in medications" can be said honestly. */
  kinds?: SearchIntent['kinds'];
  hits?: ChartSearchHit[];
  error?: string;
}

/**
 * Entry point.
 * @param medplum - Bot-scoped Medplum client.
 * @param event - `{ patientId, query, model? }`.
 * @returns The matched records, or the reason there are none.
 */
export async function handler(medplum: MedplumClient, event: BotEvent<ChartSearchInput>): Promise<ChartSearchResult> {
  // Returned, not thrown, for the same reason as the other Lyfe bots: a throw
  // reaches the caller as a bare 500, and almost every failure here is
  // configuration ("project does not have the ai feature") rather than a fault.
  try {
    return await run(medplum, event);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function run(medplum: MedplumClient, event: BotEvent<ChartSearchInput>): Promise<ChartSearchResult> {
  const patientId = event.input?.patientId?.trim();
  // Capped before it reaches the model, like the worker caps its own RAG query:
  // the body is caller-supplied and a megabyte of "query" is a bill, not a search.
  const query = event.input?.query?.trim().slice(0, MAX_QUERY_CHARS);
  if (!patientId) {
    throw new Error('patientId is required');
  }
  if (!query) {
    throw new Error('query is required');
  }

  // Reading the patient is not decoration. The bot runs as a project admin, so
  // its own searches are not compartment-filtered; this read goes through the
  // same client but the CALLER's access to the chart is what the app enforced
  // before getting here. Reading it first turns a patient id from another clinic
  // into a 404 at the top rather than an empty result that looks like "no
  // matches".
  await medplum.readResource('Patient', patientId);

  const intent = await resolveIntent({
    medplum,
    query,
    model: event.input?.model ?? DEFAULT_SEARCH_MODEL,
  });

  const queries = buildChartSearchQueries({ patientId, intent });
  const hits: ChartSearchHit[] = [];

  // One at a time. See the header: `Promise.all` here hangs the bot on vmcontext.
  for (const search of queries) {
    const resources = (await medplum.searchResources(search.resourceType, search.params)) as Resource[];
    for (const resource of resources) {
      hits.push(toChartSearchHit(resource, search.kind));
    }
  }

  return {
    ok: true,
    interpretation: intent.interpretation,
    terms: [...intent.terms, ...intent.expandedTerms],
    kinds: intent.kinds,
    hits: sortChartSearchHits(hits),
  };
}

/**
 * Ask the model for a search plan, through the server's `$ai` operation.
 *
 * `$ai` has no structured-output parameter, so the JSON contract is in the
 * prompt and `parseSearchIntent` is what actually enforces it.
 * @param props - The call inputs.
 * @param props.medplum - Bot-scoped Medplum client.
 * @param props.query - The clinician's question.
 * @param props.model - The model name.
 * @returns The validated plan.
 */
async function resolveIntent(props: { medplum: MedplumClient; query: string; model: string }): Promise<SearchIntent> {
  const parameters: Parameters = {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'messages',
        valueString: JSON.stringify([
          { role: 'system', content: CHART_SEARCH_SYSTEM_PROMPT },
          { role: 'user', content: buildSearchPrompt(props.query) },
        ]),
      },
      { name: 'model', valueString: props.model },
      { name: 'temperature', valueDecimal: SEARCH_TEMPERATURE },
    ],
  };

  const response = await props.medplum.post<Parameters>(props.medplum.fhirUrl('$ai'), parameters);
  const content = response.parameter?.find((p) => p.name === 'content')?.valueString;
  if (!content) {
    throw new Error('The $ai operation returned no content');
  }
  return parseSearchIntent(content);
}
