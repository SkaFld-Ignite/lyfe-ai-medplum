// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * What the patient page knows about pulling this patient's record again.
 *
 * Three questions, and all three are answered from things that already exist
 * rather than from anything new:
 *
 *   - **which sources can be pulled** — the worker's registry intersected with
 *     the clinic's connected integrations (`services/resync.ts`)
 *   - **when each last ran, and how it went** — the run's own import `Task`
 *     (`services/imports.ts`). There is no "last synced at" field anywhere,
 *     which is deliberate: a denormalised timestamp is a second source of
 *     truth that can disagree with the runs it claims to describe
 *   - **is one going now** — the same Task, before it reaches a terminal status
 *
 * Polling, not subscriptions. A re-sync is a thing someone just pressed, so
 * they are looking at it; a ten-second refresh while a run is open is enough
 * to watch it move, and it stops the moment the run closes.
 */
import { useMedplum } from '@medplum/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportRun, ImportSource } from '../services/imports';
import { isRunning, latestRunBySource, listPatientImportRuns } from '../services/imports';
import type { ResyncSource } from '../services/resync';
import { listResyncSources, queuePatientResync } from '../services/resync';

/** How often the runs are re-read while one is still open. */
const POLL_INTERVAL_MS = 10_000;

/**
 * How long a just-queued sync is shown as queued before the Task takes over.
 *
 * The worker answers 202 as soon as Inngest accepts the event, which is before
 * the function has started and therefore before any Task exists. Without this
 * the button would report "queued" and the card would still show the previous
 * run, which reads like nothing happened.
 */
const QUEUED_GRACE_MS = 90_000;

export interface PatientResyncState {
  /** Sources this clinic can pull this patient from. Empty while loading, and when there are none. */
  readonly sources: readonly ResyncSource[];
  /** The newest run per source. */
  readonly latest: Partial<Record<ImportSource, ImportRun>>;
  /** Sources queued in this session whose run has not appeared yet. */
  readonly queued: ReadonlySet<ImportSource>;
  /** True until the first read finishes. */
  readonly loading: boolean;
  /** Why the last trigger failed, when one did. */
  readonly error?: string;
  /**
   * Ask for a re-pull.
   * @param source - Which source to pull from.
   */
  readonly resync: (source: ImportSource) => void;
}

/**
 * Re-sync state for one patient.
 * @param patientId - The Medplum patient id.
 * @returns What the card needs to render and the trigger.
 */
export function usePatientResync(patientId: string): PatientResyncState {
  const medplum = useMedplum();
  const [sources, setSources] = useState<readonly ResyncSource[]>([]);
  const [latest, setLatest] = useState<Partial<Record<ImportSource, ImportRun>>>({});
  const [queued, setQueued] = useState<ReadonlySet<ImportSource>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Set when a sync is queued, so the grace window can be measured without a
  // re-render per tick.
  const queuedAt = useRef<Partial<Record<ImportSource, number>>>({});

  const refresh = useCallback(async () => {
    const runs = await listPatientImportRuns(medplum, patientId);
    const bySource = latestRunBySource(runs);
    setLatest(bySource);
    // A queued source stops being "queued" once a run for it has started since
    // the request — or once the grace window is up, so a sync the worker
    // accepted but Inngest never ran does not spin forever.
    setQueued((previous) => {
      const next = new Set(previous);
      for (const source of previous) {
        const since = queuedAt.current[source] ?? 0;
        const run = bySource[source];
        const started = run?.startedAt ? new Date(run.startedAt).getTime() : 0;
        if (started >= since || Date.now() - since > QUEUED_GRACE_MS) {
          next.delete(source);
        }
      }
      return next.size === previous.size ? previous : next;
    });
  }, [medplum, patientId]);

  // No `setLoading(true)` here: the state starts true and the patient page
  // remounts this subtree per patient (`key={patientId}` in `PatientPage`), so
  // setting it again would only be a synchronous setState inside an effect,
  // which React now warns about and which buys nothing.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listResyncSources(medplum), listPatientImportRuns(medplum, patientId)])
      .then(([available, runs]) => {
        if (!cancelled) {
          setSources(available);
          setLatest(latestRunBySource(runs));
        }
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [medplum, patientId]);

  // Poll only while something is actually open. A patient whose last sync
  // finished a week ago costs nothing.
  const active = queued.size > 0 || sources.some((s) => isRunning(latest[s.id]));
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => {
      refresh().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const resync = useCallback(
    (source: ImportSource) => {
      setError(undefined);
      queuedAt.current[source] = Date.now();
      setQueued((previous) => new Set(previous).add(source));
      queuePatientResync(medplum, { patientId, source })
        .then(() => refresh())
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          setQueued((previous) => {
            const next = new Set(previous);
            next.delete(source);
            return next;
          });
          return undefined;
        });
    },
    [medplum, patientId, refresh]
  );

  return { sources, latest, queued, loading, error, resync };
}
