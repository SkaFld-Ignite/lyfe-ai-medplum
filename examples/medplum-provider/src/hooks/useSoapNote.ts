// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeErrorString } from '@medplum/core';
import type { Composition, Provenance } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useState } from 'react';
import type { SoapNarratives, SoapNote } from '../utils/soap-note';
import {
  applySoapEdits,
  DRCHRONO_CLINICAL_NOTE_SYSTEM,
  parseSoapComposition,
  SOAP_NOTE_BOT_IDENTIFIER,
  soapNoteSearchQuery,
} from '../utils/soap-note';

/** What the drawer is waiting on, so each button can show its own spinner. */
export type SoapNoteBusy = 'generate' | 'save' | 'approve' | 'revert' | 'push';

export interface SoapNoteState {
  /** Undefined while loading, or when this encounter has never had a note drafted. */
  note?: SoapNote;
  loading: boolean;
  /** The action in flight, if any. The last good note stays on screen throughout. */
  busy?: SoapNoteBusy;
  error?: string;
  /** The DrChrono clinical-note id this note has been pushed to, from its Provenance. */
  drChronoNoteId?: string;
  reload: () => void;
  generate: () => void;
  save: (narratives: SoapNarratives) => void;
  approve: () => void;
  revert: () => void;
  push: () => void;
}

/**
 * Load an encounter's SOAP note, and drive the five things a provider can do to it.
 *
 * Three of those five are plain resource writes — save, approve, revert are
 * `Composition.status` and `section[].text` — so they go straight to the server
 * rather than through the bot. Only the two that need something the browser must
 * not hold go through `lyfe-soap-note`: `generate`, which needs `$ai`, and
 * `push`, which needs the clinic's DrChrono token.
 *
 * "Submitted" is read from `Provenance`, not from a field on the Composition.
 * FHIR's CompositionStatus has no such value and transmitting a document to an
 * external EHR is an event, not a clinical standing — see the note at the top of
 * `bots/shared/soap-note.ts`.
 * @param encounterId - The encounter the note documents.
 * @returns The note, its loading state and the five actions.
 */
export function useSoapNote(encounterId: string): SoapNoteState {
  const medplum = useMedplum();
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<SoapNoteBusy | undefined>(undefined);
  // Kept apart from the load error: a failed action must not be cleared by the
  // reload it triggers, and a reload that succeeds must not keep showing it.
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [settled, setSettled] = useState<{
    key: string;
    note?: SoapNote;
    drChronoNoteId?: string;
    error?: string;
  }>({ key: '' });
  const requestKey = `${encounterId}:${reloadKey}`;

  useEffect(() => {
    let active = true;
    const key = `${encounterId}:${reloadKey}`;
    const load = async (): Promise<{ note?: SoapNote; drChronoNoteId?: string }> => {
      const composition = await medplum.searchOne('Composition', soapNoteSearchQuery(encounterId), {
        cache: 'no-cache',
      });
      if (!composition?.id) {
        return {};
      }
      // Awaited after the Composition rather than alongside it: it needs the id.
      //
      // A failure here is swallowed on purpose. This read only decides whether a
      // badge says the note is already in DrChrono; losing the whole note to it
      // would be the worse outcome, and a denied Provenance search is exactly the
      // kind of access-policy gap that turns one optional surface into a blank
      // panel. The push does not trust this value — the bot re-reads the
      // Provenance server-side before it writes anything.
      const provenances = await medplum
        .searchResources('Provenance', `target=Composition/${composition.id}`, { cache: 'no-cache' })
        .catch(() => []);
      return { note: parseSoapComposition(composition), drChronoNoteId: drChronoNoteIdOf(provenances) };
    };

    load()
      .then((loaded) => active && setSettled({ key, ...loaded }))
      .catch((err: unknown) => active && setSettled({ key, error: normalizeErrorString(err) }));
    return () => {
      active = false;
    };
  }, [medplum, encounterId, reloadKey]);

  const reload = useCallback(() => {
    setActionError(undefined);
    setReloadKey((k) => k + 1);
  }, []);

  // Every action is the same three steps — mark busy, do the work, reload — so
  // they share one wrapper rather than repeating the error handling five times.
  const perform = useCallback(
    (kind: SoapNoteBusy, work: () => Promise<void>): void => {
      setBusy(kind);
      setActionError(undefined);
      work()
        .then(() => {
          setBusy(undefined);
          reload();
        })
        .catch((err: unknown) => {
          setBusy(undefined);
          setActionError(normalizeErrorString(err));
        });
    },
    [reload]
  );

  const runBot = useCallback(
    async (action: 'generate' | 'push'): Promise<void> => {
      // Looked up by identifier rather than by a hard-coded id: the id differs
      // per project, the identifier is the deploy manifest's key and does not.
      const bot = await medplum.searchOne(
        'Bot',
        `identifier=${SOAP_NOTE_BOT_IDENTIFIER.system}|${SOAP_NOTE_BOT_IDENTIFIER.value}`
      );
      if (!bot?.id) {
        throw new Error(`The ${SOAP_NOTE_BOT_IDENTIFIER.value} bot is not deployed to this project`);
      }
      const result = (await medplum.executeBot(bot.id, { encounterId, action }, 'application/json')) as {
        ok?: boolean;
        error?: string;
      };
      if (result?.ok === false) {
        throw new Error(result.error ?? 'The SOAP note request failed');
      }
    },
    [medplum, encounterId]
  );

  const setStatus = useCallback(
    async (status: Composition['status']): Promise<void> => {
      const composition = await medplum.searchOne('Composition', soapNoteSearchQuery(encounterId), {
        cache: 'no-cache',
      });
      if (!composition?.id) {
        throw new Error('There is no SOAP note for this encounter');
      }
      await medplum.updateResource<Composition>({ ...composition, status });
    },
    [medplum, encounterId]
  );

  const generate = useCallback(() => perform('generate', () => runBot('generate')), [perform, runBot]);
  const push = useCallback(() => perform('push', () => runBot('push')), [perform, runBot]);
  const approve = useCallback(() => perform('approve', () => setStatus('final')), [perform, setStatus]);
  const revert = useCallback(() => perform('revert', () => setStatus('preliminary')), [perform, setStatus]);

  const save = useCallback(
    (narratives: SoapNarratives) =>
      perform('save', async () => {
        const composition = await medplum.searchOne('Composition', soapNoteSearchQuery(encounterId), {
          cache: 'no-cache',
        });
        if (!composition?.id) {
          throw new Error('There is no SOAP note for this encounter');
        }
        await medplum.updateResource<Composition>(applySoapEdits(composition, narratives));
      }),
    [perform, medplum, encounterId]
  );

  const current = settled.key === requestKey;
  return {
    note: current ? settled.note : undefined,
    loading: !current,
    busy,
    error: actionError ?? (current ? settled.error : undefined),
    drChronoNoteId: current ? settled.drChronoNoteId : undefined,
    reload,
    generate,
    save,
    approve,
    revert,
    push,
  };
}

/**
 * Pull the DrChrono clinical-note id out of a Composition's Provenance records.
 *
 * Mirrors `drChronoNoteIdsFrom` on the bot side, which uses the same ids to
 * decide whether a push is allowed to overwrite the note it finds. The drawer
 * only needs the latest, so this returns one.
 * @param provenances - Provenance resources targeting the Composition.
 * @returns The note id, or undefined when the note has never been pushed.
 */
export function drChronoNoteIdOf(provenances: Provenance[]): string | undefined {
  for (const provenance of provenances) {
    for (const target of provenance.target ?? []) {
      if (target.identifier?.system === DRCHRONO_CLINICAL_NOTE_SYSTEM && target.identifier.value) {
        return target.identifier.value;
      }
    }
  }
  return undefined;
}
