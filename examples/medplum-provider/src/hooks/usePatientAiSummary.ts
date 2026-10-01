// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import type { PatientAiSummary } from '../utils/patient-ai-summary';
import {
  AI_SUMMARY_BOT_IDENTIFIER,
  aiSummarySearchQuery,
  parseAiSummaryComposition,
} from '../utils/patient-ai-summary';

export interface PatientAiSummaryState {
  /** Undefined while loading, or when this patient has never had one generated. */
  summary?: PatientAiSummary;
  loading: boolean;
  /** True while the bot is writing a new one. The last good summary stays on screen. */
  generating: boolean;
  error?: string;
  reload: () => void;
  regenerate: () => void;
}

/**
 * Load a patient's AI summary Composition, and run the bot to rewrite it.
 *
 * Reads the Composition directly rather than through a service: the search is one
 * line, it is the only read this needs, and the server already enforces the
 * compartment. Writing goes the other way — only the bot writes a summary,
 * because only the bot can reach `$ai`.
 *
 * lyfe-provider-ui's refresh had a first stage that kicked off document
 * extraction and polled its progress before generating. There is no
 * document-extraction pipeline in this repo, so that stage and its progress bar
 * have no counterpart here; see the DOCUMENT CONTEXT SEAM in
 * `bots/shared/ai-summary-prompt.ts`.
 * @param patientId - The patient id.
 * @returns The summary with its loading state and the two actions.
 */
export function usePatientAiSummary(patientId: string): PatientAiSummaryState {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  // Kept apart from the load error: a failed regenerate must not be cleared by
  // the reload it triggers, and a reload that succeeds must not keep showing it.
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [settled, setSettled] = useState<{ key: string; summary?: PatientAiSummary; error?: string }>({ key: '' });
  const requestKey = `${patientId}:${reloadKey}`;

  useEffect(() => {
    let active = true;
    const key = `${patientId}:${reloadKey}`;
    medplum
      .searchOne('Composition', aiSummarySearchQuery(patientId), { cache: 'no-cache' })
      .then((composition) => {
        if (active) {
          setSettled({ key, summary: composition ? parseAiSummaryComposition(composition) : undefined });
        }
      })
      .catch((err: unknown) => active && setSettled({ key, error: normalizeErrorString(err) }));
    return () => {
      active = false;
    };
  }, [medplum, patientId, reloadKey]);

  const reload = useCallback(() => {
    setActionError(undefined);
    setReloadKey((k) => k + 1);
  }, []);

  const regenerate = useCallback(() => {
    setGenerating(true);
    setActionError(undefined);
    // Looked up by identifier rather than hard-coded id, the same way
    // `refreshCandidClaimResponse` resolves its bot: the id differs per project,
    // the identifier is the manifest's deploy key and does not.
    medplum
      .searchOne('Bot', `identifier=${AI_SUMMARY_BOT_IDENTIFIER.system}|${AI_SUMMARY_BOT_IDENTIFIER.value}`)
      .then(async (bot) => {
        if (!bot?.id) {
          throw new Error(`The ${AI_SUMMARY_BOT_IDENTIFIER.value} bot is not deployed to this project`);
        }
        const result = (await medplum.executeBot(bot.id, { patientId }, 'application/json')) as {
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
  }, [medplum, patientId, reload]);

  const current = settled.key === requestKey;
  return {
    summary: current ? settled.summary : undefined,
    loading: !current,
    generating,
    error: actionError ?? (current ? settled.error : undefined),
    reload,
    regenerate,
  };
}
