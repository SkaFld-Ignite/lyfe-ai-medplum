// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import type { EncounterAiSummary, SummaryKind } from '../utils/encounter-ai-summary';
import {
  ENCOUNTER_SUMMARY_BOT_IDENTIFIER,
  encounterSummarySearchQuery,
  parseEncounterSummary,
} from '../utils/encounter-ai-summary';

export interface EncounterAiSummaryState {
  /** Undefined while loading, or when this encounter has never had one generated. */
  summary?: EncounterAiSummary;
  loading: boolean;
  /** True while the bot is writing one. The last good summary stays on screen. */
  generating: boolean;
  error?: string;
  reload: () => void;
  generate: () => void;
}

/**
 * Load one encounter's pre-visit or post-visit summary Composition, and run the
 * bot to write it.
 *
 * The same shape as `usePatientAiSummary`, for the same reasons: the Composition
 * is read directly rather than through a service because the search is one line
 * and the server already enforces the compartment, and writing goes the other way
 * because only the bot can reach `$ai`.
 *
 * Prod cached the generated summary on the Appointment row and the card read it
 * from props, which is why a regenerate needed a separate "cached" flag. Here the
 * Composition *is* the cache, so a reload after the bot returns is the whole
 * mechanism.
 * @param encounterId - The encounter.
 * @param kind - Which summary.
 * @returns The summary with its loading state and the two actions.
 */
export function useEncounterAiSummary(encounterId: string | undefined, kind: SummaryKind): EncounterAiSummaryState {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  // Kept apart from the load error: a failed generate must not be cleared by the
  // reload it triggers, and a reload that succeeds must not keep showing it.
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [settled, setSettled] = useState<{ key: string; summary?: EncounterAiSummary; error?: string }>({ key: '' });
  const requestKey = `${encounterId}:${kind}:${reloadKey}`;

  useEffect(() => {
    if (!encounterId) {
      return undefined;
    }
    let active = true;
    const key = `${encounterId}:${kind}:${reloadKey}`;
    medplum
      .searchOne('Composition', encounterSummarySearchQuery(kind, encounterId), { cache: 'no-cache' })
      .then((composition) => {
        if (active) {
          setSettled({ key, summary: composition ? parseEncounterSummary(composition, kind) : undefined });
        }
      })
      .catch((err: unknown) => active && setSettled({ key, error: normalizeErrorString(err) }));
    return () => {
      active = false;
    };
  }, [medplum, encounterId, kind, reloadKey]);

  const reload = useCallback(() => {
    setActionError(undefined);
    setReloadKey((k) => k + 1);
  }, []);

  const generate = useCallback(() => {
    if (!encounterId) {
      return;
    }
    setGenerating(true);
    setActionError(undefined);
    // Looked up by identifier rather than hard-coded id, as `usePatientAiSummary`
    // does: the id differs per project, the identifier is the manifest's deploy
    // key and does not.
    medplum
      .searchOne(
        'Bot',
        `identifier=${ENCOUNTER_SUMMARY_BOT_IDENTIFIER.system}|${ENCOUNTER_SUMMARY_BOT_IDENTIFIER.value}`
      )
      .then(async (bot) => {
        if (!bot?.id) {
          throw new Error(`The ${ENCOUNTER_SUMMARY_BOT_IDENTIFIER.value} bot is not deployed to this project`);
        }
        const result = (await medplum.executeBot(bot.id, { encounterId, kind }, 'application/json')) as {
          ok?: boolean;
          error?: string;
        };
        if (result?.ok === false) {
          throw new Error(result.error ?? 'The summary could not be generated');
        }
      })
      .then(() => {
        setGenerating(false);
        reload();
      })
      .catch((err: unknown) => {
        setGenerating(false);
        setActionError(normalizeErrorString(err));
      });
  }, [medplum, encounterId, kind, reload]);

  const current = settled.key === requestKey;
  return {
    summary: current ? settled.summary : undefined,
    loading: Boolean(encounterId) && !current,
    generating,
    error: actionError ?? (current ? settled.error : undefined),
    reload,
    generate,
  };
}
