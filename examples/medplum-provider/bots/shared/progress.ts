// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Task, TaskOutput } from '@medplum/fhirtypes';

/**
 * Live progress reporting for a long import, written onto the import's Task.
 *
 * There is no new resource type here, and no side table. FHIR's `Task` already
 * models a unit of work and already carries every field this needs:
 *
 *   status          requested / in-progress / completed / failed
 *   businessStatus  where the job is right now, in domain terms
 *   output          what it has produced so far
 *   statusReason    why it stopped, when it stopped badly
 *   executionPeriod when it started and finished
 *
 * The importers already created a Task; they simply never updated it between
 * "in-progress" and "done", so an import in flight was a black box. Writing
 * the phase as it changes turns the same resource into a live feed that any
 * client can watch with an ordinary FHIR search — no polling endpoint, no
 * websocket, nothing to keep in step with the bots.
 *
 * Every write here is best-effort. Progress reporting must never be the reason
 * a chart fails to import, so a throttled or rejected update is swallowed and
 * the import carries on.
 */

/**
 * Why an import failed, in the few categories worth acting on differently.
 *
 * Deliberately small. The value of a taxonomy here is that "token expired"
 * (reconnect the integration) reads differently from "rate limited" (wait and
 * retry) and from "not found" (the record is gone upstream). Splitting it
 * finer than that produces labels nobody routes on.
 */
export type ImportErrorReason =
  | 'rate-limited'
  | 'auth-expired'
  | 'timeout'
  | 'server-error'
  | 'network-error'
  | 'not-found'
  | 'validation-error'
  | 'unknown';

/** Human-readable label per reason, so UI and logs agree on the wording. */
export const IMPORT_ERROR_LABELS: Record<ImportErrorReason, string> = {
  'rate-limited': 'Rate limited',
  'auth-expired': 'Token expired',
  timeout: 'Timed out',
  'server-error': 'Server error',
  'network-error': 'Network error',
  'not-found': 'Not found',
  'validation-error': 'Invalid request',
  unknown: 'Unknown reason',
};

/** Coding system for {@link ImportErrorReason}. */
export const IMPORT_ERROR_SYSTEM = 'https://lyfe.com/import-error';

/**
 * Classify a thrown error into an actionable reason.
 *
 * Matching is on message text because that is all an HTTP client failure
 * gives us across three different upstreams (Medplum, DrChrono, Zus). Order
 * matters: a 401 inside a rate-limit retry should still read as auth.
 * @param err - The thrown error.
 * @returns The closest matching reason, or `unknown`.
 */
export function classifyImportError(err: unknown): ImportErrorReason {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/401|unauthor|invalid[_ ]grant|token (has )?expired|refresh token/.test(message)) {
    return 'auth-expired';
  }
  if (/429|too many requests|throttl|rate limit/.test(message)) {
    return 'rate-limited';
  }
  if (/timed out|timeout|etimedout|abort/.test(message)) {
    return 'timeout';
  }
  if (/404|not found/.test(message)) {
    return 'not-found';
  }
  if (/400|422|invalid|validation|required/.test(message)) {
    return 'validation-error';
  }
  if (/5\d\d|server error|bad gateway|service unavailable/.test(message)) {
    return 'server-error';
  }
  if (/econnreset|enotfound|econnrefused|network|fetch failed|socket/.test(message)) {
    return 'network-error';
  }
  return 'unknown';
}

/** Counts of what has been written, keyed by FHIR resource type or domain. */
export type ImportCountMap = Record<string, number>;

/**
 * Turn a count map into Task.output entries.
 *
 * One entry per domain with a real integer, rather than a single JSON blob in
 * a `valueString`, so the numbers are readable by any FHIR client and by
 * Medplum's own resource viewer without parsing anything.
 * @param counts - Counts keyed by domain.
 * @returns Task output entries, zero counts omitted.
 */
export function countsToOutput(counts: ImportCountMap): TaskOutput[] {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, value]) => ({ type: { text: type }, valueInteger: value }));
}

/**
 * Tracks one import run and reports it onto its Task.
 *
 * Construct it once the Task exists, call {@link phase} as the import moves
 * through its steps, and close with {@link finish} or {@link fail}.
 */
export class ImportProgress {
  private readonly medplum: MedplumClient;
  private readonly taskId: string | undefined;
  private readonly total: number;
  private step = 0;

  /**
   * @param props - Tracker inputs.
   * @param props.medplum - Bot-scoped Medplum client.
   * @param props.task - The Task opened for this run.
   * @param props.totalPhases - How many phases the run has, for "3 of 11".
   */
  constructor(props: { medplum: MedplumClient; task: Task; totalPhases: number }) {
    this.medplum = props.medplum;
    this.taskId = props.task.id;
    this.total = props.totalPhases;
  }

  /**
   * Record that the run has entered a named phase.
   *
   * A JSON Patch on the single field rather than a full update: the Task is
   * being written from one place only, but a patch cannot carry a stale copy
   * of the rest of the resource, and it is a far smaller write to repeat a
   * dozen times per import.
   * @param label - What is being pulled, in the words a reader would use.
   * @returns Resolves once the update has been attempted.
   */
  async phase(label: string): Promise<void> {
    this.step++;
    if (!this.taskId) {
      return;
    }
    const text = `${this.step} of ${this.total} · ${label}`;
    await this.medplum
      .patchResource('Task', this.taskId, [
        { op: 'add', path: '/businessStatus', value: { text } satisfies CodeableConcept },
        { op: 'add', path: '/lastModified', value: new Date().toISOString() },
      ])
      // Progress reporting must never fail an import.
      .catch(() => undefined);
  }

  /**
   * Publish the running totals without changing phase.
   *
   * Lets a long phase show what it has produced so far, which is the
   * difference between "still going" and "still going, 400 observations in".
   * @param counts - Counts so far, keyed by domain.
   * @returns Resolves once the update has been attempted.
   */
  async report(counts: ImportCountMap): Promise<void> {
    if (!this.taskId) {
      return;
    }
    await this.medplum
      .patchResource('Task', this.taskId, [{ op: 'add', path: '/output', value: countsToOutput(counts) }])
      .catch(() => undefined);
  }
}

/**
 * Build the `statusReason` for a failed import.
 *
 * Carries both the coded reason and the original message: the code is what a
 * list view groups and filters on, the message is what actually tells someone
 * what went wrong.
 * @param err - The thrown error.
 * @returns A CodeableConcept naming the reason.
 */
export function buildStatusReason(err: unknown): CodeableConcept {
  const reason = classifyImportError(err);
  const message = err instanceof Error ? err.message : String(err);
  return {
    coding: [{ system: IMPORT_ERROR_SYSTEM, code: reason, display: IMPORT_ERROR_LABELS[reason] }],
    text: message.slice(0, 500),
  };
}
