// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useCallback, useState } from 'react';
import { searchPatientDocuments } from '../services/document-search';
import type { ChartSearchBotResult, ChartSearchHit, SearchKind } from '../utils/chart-search';
import { CHART_SEARCH_BOT_IDENTIFIER, toDocumentSearchHits } from '../utils/chart-search';

/** How many document chunks to ask the worker for. It clamps this itself. */
const DOCUMENT_TOP_K = 12;

export interface ChartSearchAnswer {
  query: string;
  /** One sentence from the model saying what was searched for. */
  interpretation?: string;
  /** Every term that went into the queries, original and expanded. */
  terms: string[];
  /** The record types the search covered. */
  kinds: SearchKind[];
  hits: ChartSearchHit[];
  /**
   * Why the document leg returned nothing, when it did not run or failed.
   *
   * Carried separately from `error` because a missing document index must not
   * discard structured results that are perfectly good — and must not be
   * silently reported as "no documents mention this", which is a different
   * claim.
   */
  documentNote?: string;
}

export interface ChartSearchState {
  answer?: ChartSearchAnswer;
  searching: boolean;
  error?: string;
  search: (query: string) => void;
  clear: () => void;
}

/**
 * Run a natural-language search over one patient's chart.
 *
 * Two legs, because they live in two places. The bot turns the question into a
 * search plan and runs the FHIR searches; the browser runs the document leg
 * against the worker's `/api/rag/search`, which the bot cannot reach — see the
 * header of `bots/chart-search.ts`.
 *
 * NOTHING IS CACHED
 * -----------------
 * Results live in this hook's state, scoped to the mounted component, and are
 * discarded on navigation. That is deliberate and it is the fix for a specific
 * prod bug: `app/actions/search-actions.ts` cached under
 * `ai-search:${searchType}:${query}` with **no organization in the key**, while
 * the equivalent route handler's key had one. That asymmetry is how a previously
 * fixed cross-org cache-poisoning PHI leak happened, and the safest way for it
 * not to come back is for there to be no shared keyspace to get wrong. A search
 * is one bot execution and one indexed query; it does not need a cache.
 * @param patientId - The chart to search.
 * @returns The answer with its loading state, and the two actions.
 */
export function useChartSearch(patientId: string): ChartSearchState {
  const medplum = useMedplum();
  const [answer, setAnswer] = useState<ChartSearchAnswer | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const search = useCallback(
    (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query) {
        return;
      }
      setSearching(true);
      setError(undefined);

      // The bot first, then the document leg only if the plan asked for
      // documents. Running both at once would be one round trip faster and would
      // spend an embedding call on every "what medications is he on", which is a
      // question the index has no part in answering.
      medplum
        .searchOne('Bot', `identifier=${CHART_SEARCH_BOT_IDENTIFIER.system}|${CHART_SEARCH_BOT_IDENTIFIER.value}`)
        .then(async (bot): Promise<ChartSearchAnswer> => {
          if (!bot?.id) {
            throw new Error(`The ${CHART_SEARCH_BOT_IDENTIFIER.value} bot is not deployed to this project`);
          }
          const result = (await medplum.executeBot(
            bot.id,
            { patientId, query },
            'application/json'
          )) as ChartSearchBotResult;
          if (result?.ok === false) {
            throw new Error(result.error ?? 'The chart could not be searched');
          }

          const kinds = result.kinds ?? [];
          const base: ChartSearchAnswer = {
            query,
            interpretation: result.interpretation,
            terms: result.terms ?? [],
            kinds,
            hits: result.hits ?? [],
          };

          if (!kinds.includes('document')) {
            return base;
          }
          if (base.terms.length === 0) {
            return base;
          }

          try {
            const documents = await searchPatientDocuments(medplum, {
              patientId,
              // The question itself, not the expanded terms: the index is
              // semantic, so a natural sentence embeds better than a comma list,
              // and the expansion exists for the keyword legs.
              query,
              topK: DOCUMENT_TOP_K,
            });
            return { ...base, hits: [...base.hits, ...toDocumentSearchHits(documents.hits)] };
          } catch (err: unknown) {
            // Kept as a note rather than thrown. The structured results are real
            // and useful, and "the document index is unavailable" must not be
            // rendered as "no document mentions this".
            return { ...base, documentNote: normalizeErrorString(err) };
          }
        })
        .then((next) => {
          setAnswer(next);
          setSearching(false);
        })
        .catch((err: unknown) => {
          setError(normalizeErrorString(err));
          setSearching(false);
        });
    },
    [medplum, patientId]
  );

  const clear = useCallback(() => {
    setAnswer(undefined);
    setError(undefined);
  }, []);

  return { answer, searching, error, search, clear };
}
