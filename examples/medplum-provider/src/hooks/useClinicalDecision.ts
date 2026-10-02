// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { useCallback, useState } from 'react';
import type { ClinicalDecisionBotResult } from '../utils/clinical-decision';
import { CLINICAL_DECISION_BOT_IDENTIFIER } from '../utils/clinical-decision';

export interface ClinicalDecisionState {
  result?: ClinicalDecisionBotResult;
  running: boolean;
  error?: string;
  /** Run the action. Nothing happens until the clinician asks. */
  run: () => void;
}

/**
 * Run one action of the clinical-decision bot.
 *
 * ON DEMAND, NOT ON MOUNT
 * -----------------------
 * Neither action runs automatically, and that is the design rather than a
 * shortcut. Both spend a model call, so firing them on every chart open would
 * bill a request for every patient a clinician scrolls past; and more
 * importantly, an advisory AI panel that appears unasked next to real clinical
 * data reads as part of the chart. The clinician asks for a suggestion, which is
 * also what makes it reviewable.
 *
 * NOTHING IS CACHED
 * -----------------
 * As in `useChartSearch`: the answer lives in this hook's state and is discarded
 * on navigation. Prod's search cache key omitted the organization while the
 * route's included it, which is how a cross-org cache-poisoning PHI leak
 * happened once; the surest way for that not to recur is for there to be no
 * shared keyspace. A stale coding suggestion is also worse than a fresh one,
 * since the note it was drawn from is being edited on the same screen.
 * @param input - The bot input.
 * @param input.action - Which action to run.
 * @param input.encounterId - The encounter, for `icd-codes`.
 * @param input.patientId - The patient, for `drug-interactions`.
 * @returns The result with its loading state, and the run action.
 */
export function useClinicalDecision(input: {
  action: 'icd-codes' | 'drug-interactions';
  encounterId?: string;
  patientId?: string;
}): ClinicalDecisionState {
  const medplum = useMedplum();
  const [result, setResult] = useState<ClinicalDecisionBotResult | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const { action, encounterId, patientId } = input;

  const run = useCallback(() => {
    setRunning(true);
    setError(undefined);
    medplum
      .searchOne(
        'Bot',
        `identifier=${CLINICAL_DECISION_BOT_IDENTIFIER.system}|${CLINICAL_DECISION_BOT_IDENTIFIER.value}`
      )
      .then(async (bot) => {
        if (!bot?.id) {
          throw new Error(`The ${CLINICAL_DECISION_BOT_IDENTIFIER.value} bot is not deployed to this project`);
        }
        const next = (await medplum.executeBot(
          bot.id,
          { action, encounterId, patientId },
          'application/json'
        )) as ClinicalDecisionBotResult;
        if (next?.ok === false) {
          throw new Error(next.error ?? 'The request could not be completed');
        }
        return next;
      })
      .then((next) => {
        setResult(next);
        setRunning(false);
      })
      .catch((err: unknown) => {
        setError(normalizeErrorString(err));
        setRunning(false);
      });
  }, [medplum, action, encounterId, patientId]);

  return { result, running, error, run };
}
