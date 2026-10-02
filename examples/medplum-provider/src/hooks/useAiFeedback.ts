// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { ProfileResource } from '@medplum/core';
import { getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiFeedback, AiFeedbackTarget } from '../utils/ai-feedback';
import {
  aiFeedbackSearchQuery,
  buildFeedbackCommunication,
  isEmptyFeedback,
  parseFeedbackCommunication,
} from '../utils/ai-feedback';

export interface AiFeedbackState {
  feedback: AiFeedback;
  loading: boolean;
  saving: boolean;
  error?: string;
  /** True once a submit from this session has been stored. */
  saved: boolean;
  /**
   * Merge a partial change into the standing record and store the result.
   *
   * The merge happens here, in one place, rather than in the widget: the write
   * is a conditional update that replaces the resource, so a comment typed
   * without a rating has to carry the existing rating with it or it would erase
   * it. Prod did this merge inside the server action with `??`, which is also
   * what made un-toggling a thumb a no-op — `undefined` was indistinguishable
   * from "leave it". Here an explicit `rating: undefined` in `patch` clears it,
   * because {@link AiFeedbackPatch} marks the field as present.
   */
  submit: (patch: AiFeedbackPatch) => void;
}

/**
 * A change to the standing record. A key that is absent is left alone; a key
 * present with `undefined` is cleared.
 */
export type AiFeedbackPatch = Partial<Pick<AiFeedback, 'rating' | 'comment' | 'correction'>>;

/** Nothing on screen until the read lands, so a stale vote is never rendered. */
const EMPTY: AiFeedback = {};

/**
 * Load and store one clinician's feedback on one AI-generated document.
 *
 * Reads and writes the `Communication` directly rather than through a bot. No
 * bot is needed and one would be wrong here: there is no model call and no
 * privileged read, the clinic access policy already grants
 * `Communication?_compartment=%organization`, and the server fills in the
 * compartment from the policy on create — so the clinician's own credentials are
 * sufficient and are also the correct `sender`.
 * @param target - Who is rating what. `undefined` while the document is still loading.
 * @returns The feedback with its loading state and the submit action.
 */
export function useAiFeedback(target: AiFeedbackTarget | undefined): AiFeedbackState {
  const medplum = useMedplum();
  const [feedback, setFeedback] = useState<AiFeedback>(EMPTY);
  // Which target's read has landed. `loading` is derived from it rather than
  // being its own state, following `usePatientAiSummary`: a `setLoading(true)`
  // in the effect body is a synchronous setState in an effect, which cascades a
  // render and which `react-hooks/set-state-in-effect` flags.
  const [loadedKey, setLoadedKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The standing record, readable synchronously inside `submit`. A `setFeedback`
  // updater cannot do the merge AND the write, because React may invoke an
  // updater more than once — which under StrictMode would double-POST.
  const currentRef = useRef<AiFeedback>(EMPTY);
  const apply = useCallback((next: AiFeedback): void => {
    currentRef.current = next;
    setFeedback(next);
  }, []);

  const compositionReference = target?.composition.reference;
  const reviewerReference = target?.reviewer.reference;
  const requestKey = `${compositionReference ?? ''}|${reviewerReference ?? ''}`;

  useEffect(() => {
    if (!compositionReference || !reviewerReference) {
      return undefined;
    }
    let active = true;
    const key = `${compositionReference}|${reviewerReference}`;
    const compositionId = compositionReference.split('/')[1];
    medplum
      .searchOne('Communication', aiFeedbackSearchQuery(compositionId, reviewerReference), { cache: 'no-cache' })
      .then((communication) => {
        if (active) {
          apply(communication ? parseFeedbackCommunication(communication) : EMPTY);
          setLoadedKey(key);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          // A failed read leaves the widget usable but blank, which is honest:
          // the clinician's standing vote is unknown, so none is shown.
          setError(normalizeErrorString(err));
          setLoadedKey(key);
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, apply, compositionReference, reviewerReference]);

  const submit = useCallback(
    (patch: AiFeedbackPatch) => {
      if (!target) {
        return;
      }
      const current = currentRef.current;
      const next: AiFeedback = {
        ...current,
        ...('rating' in patch && { rating: patch.rating }),
        ...('comment' in patch && { comment: patch.comment }),
        ...('correction' in patch && { correction: patch.correction }),
      };
      apply(next);

      if (isEmptyFeedback(next) && !current.communicationId) {
        // Nothing stored and nothing to store. Writing an empty Communication
        // would put a record on the chart that says nothing.
        return;
      }

      setSaving(true);
      setError(undefined);
      const compositionId = target.composition.reference.split('/')[1];
      medplum
        .upsertResource<Communication>(
          buildFeedbackCommunication({ target, feedback: next, sent: new Date().toISOString() }),
          aiFeedbackSearchQuery(compositionId, target.reviewer.reference)
        )
        .then((stored) => {
          apply(parseFeedbackCommunication(stored));
          setSaved(true);
        })
        .catch((err: unknown) => setError(normalizeErrorString(err)))
        .finally(() => setSaving(false));
    },
    [medplum, apply, target]
  );

  return { feedback, loading: loadedKey !== requestKey, saving, error, saved, submit };
}

/**
 * Build the target from what a summary card already has.
 *
 * Returns `undefined` — which disables the widget — when the document has not
 * loaded or the session has no profile reference to credit as `sender`. A
 * feedback record with no sender would be an anonymous opinion on a chart.
 * @param props - The pieces the card holds.
 * @param props.compositionId - The rated document.
 * @param props.patientId - The chart it belongs to.
 * @param props.profile - `medplum.getProfile()`.
 * @returns The target, or undefined when it cannot be formed.
 */
export function aiFeedbackTarget(props: {
  compositionId: string | undefined;
  patientId: string;
  profile: ProfileResource | undefined;
}): AiFeedbackTarget | undefined {
  const reviewer = props.profile ? getReferenceString(props.profile) : undefined;
  if (!props.compositionId || !reviewer) {
    return undefined;
  }
  return {
    composition: { reference: `Composition/${props.compositionId}` },
    patient: { reference: `Patient/${props.patientId}` },
    reviewer: { reference: reviewer },
  };
}
