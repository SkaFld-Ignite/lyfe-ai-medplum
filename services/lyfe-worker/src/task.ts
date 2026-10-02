// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Organization, Reference, Task, TaskOutput } from '@medplum/fhirtypes';
import { withMedplum429Retry } from '../../../examples/medplum-provider/bots/shared/batch.ts';

/**
 * The Medplum half of the run's visibility.
 *
 * Inngest owns orchestration — retries, concurrency, step state — and its
 * dashboard is the right place to answer "why did forty imports fail last
 * night". It is the wrong place to answer "did Maria Gonzalez import, and did
 * her labs come through", because it is keyed on function runs and knows
 * nothing about patients.
 *
 * So every run also keeps a FHIR `Task`, exactly as the bots did. The Task is
 * keyed on the patient, lives beside the clinical data, and is what the
 * Imports page already reads — that page keeps working unchanged.
 *
 * The two halves are joined in both directions:
 *
 * - the Task carries the Inngest **run id** as an identifier, so a patient
 *   links to the run that imported them
 * - the Inngest event carries the **Task id**, so a run links back to the
 *   patient record it wrote
 *
 * Without that link you have two dashboards and no way to get from one to the
 * other, which is worse than either alone.
 */

/** Identifier system carrying the Inngest run id on a Task. */
export const INNGEST_RUN_IDENTIFIER = 'https://lyfe.com/inngest/run';

/** Identifier system carrying the batch a Task belongs to. */
export const BATCH_IDENTIFIER = 'https://lyfe.com/import-batch';

/** Identifier carrying the source-system id, for a Task with no patient yet. */
export const SOURCE_ID_IDENTIFIER = 'https://lyfe.com/source-id';

/**
 * The status this platform writes for a failed run.
 *
 * `failed` is **not** a FHIR R4 `Task.status` — the value set stops at
 * `cancelled`, `on-hold`, `completed` and friends. Both bots have written it
 * since before this worker existed and the server accepts it, so the Imports
 * page filters on it and the stored data uses it. Changing that is a migration,
 * not a tidy-up, so it is named here rather than silently cast at each use.
 */
const FAILED = 'failed' as Task['status'];

/** Coding system for a coded failure reason, matching what the bots wrote. */
export const IMPORT_ERROR_SYSTEM = 'https://lyfe.com/import-error';

export interface StartTaskProps {
  medplum: MedplumClient;
  organization: Reference<Organization>;
  /** `drchrono-import` or `zus-import`; the Imports page groups on this. */
  code: string;
  /**
   * The patient this run is about, when it is already known.
   *
   * A chart import does not know it yet: the patient is found or created by
   * the import itself. The Task is still opened first and the patient attached
   * once resolved, because a Task that only appears on success cannot report a
   * failure — and a run that fails invisibly is worse than one that fails.
   */
  patientId?: string;
  /** The source-system id, so a Task is findable before it has a patient. */
  sourceId?: string;
  /** Inngest's run id, so the patient links to the run. */
  runId: string;
  batchId?: string;
}

/**
 * Open the Task for a run.
 *
 * Created `in-progress` rather than `requested`: by the time this is called
 * Inngest has already scheduled the work, so "requested" would describe a
 * state that never exists.
 * @param props - The task inputs.
 * @returns The created Task.
 */
export async function startTask(props: StartTaskProps): Promise<Task> {
  const now = new Date().toISOString();
  // Every Medplum call here goes through the bots' own 429 helper. These are
  // the run's bookkeeping, not its work: a Task write losing a race with the
  // import's own writes for the same quota must not be what ends the run.
  return withMedplum429Retry(
    () =>
      props.medplum.createResource<Task>({
        resourceType: 'Task',
        meta: { account: props.organization, accounts: [props.organization] },
        status: 'in-progress',
        intent: 'order',
        code: { text: props.code },
        ...(props.patientId ? { for: { reference: `Patient/${props.patientId}` } } : {}),
        identifier: [
          { system: INNGEST_RUN_IDENTIFIER, value: props.runId },
          ...(props.batchId ? [{ system: BATCH_IDENTIFIER, value: props.batchId }] : []),
          ...(props.sourceId ? [{ system: SOURCE_ID_IDENTIFIER, value: props.sourceId }] : []),
        ],
        authoredOn: now,
        lastModified: now,
        executionPeriod: { start: now },
      }),
    `startTask ${props.code}`
  );
}

/**
 * Record which phase a run has reached.
 *
 * Patched rather than updated: a phase write races with nothing else on the
 * Task, and a full update would need the current version and could clobber an
 * output written a moment earlier.
 * @param medplum - Authenticated Medplum client.
 * @param taskId - The Task to update.
 * @param phase - Human-readable phase, e.g. "3 of 11 · encounters".
 */
export async function setPhase(medplum: MedplumClient, taskId: string, phase: string): Promise<void> {
  await withMedplum429Retry(
    () => medplum.patchResource('Task', taskId, [{ op: 'add', path: '/businessStatus', value: { text: phase } }]),
    'setPhase'
  ).catch(() => {
    // Losing a progress update must never fail the import it is describing.
  });
}

/** Per-resource-type counts, as the Imports page reads them. */
export type CountMap = Record<string, number>;

/**
 * Turn counts into Task outputs.
 * @param counts - Per-resource-type counts.
 * @returns Task output entries.
 */
export function countsToOutput(counts: CountMap): TaskOutput[] {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([type, value]) => ({ type: { text: type }, valueInteger: value }));
}

/**
 * Close the Task as a success.
 * @param medplum - Authenticated Medplum client.
 * @param taskId - The Task to complete.
 * @param counts - What was written, by resource type.
 * @param summary - Replaces the default `complete` business status.
 *
 * `countsToOutput` drops zeros, so a run that found nothing has no outputs at
 * all and a completed Task saying only "complete" is indistinguishable from a
 * run that never looked. The discovery pass passes its own sentence here —
 * "scanned 171 · queued 0 · 167 wrong reason" — so an empty result reads as an
 * answer rather than as silence.
 */
export async function completeTask(
  medplum: MedplumClient,
  taskId: string,
  counts: CountMap,
  summary?: string
): Promise<void> {
  const now = new Date().toISOString();
  // `for` and `identifier` are read back and rewritten deliberately: a bare
  // update built from a stale copy silently dropped `Task.for` once, which
  // detached a finished run from its patient.
  const current = await withMedplum429Retry(() => medplum.readResource('Task', taskId), 'completeTask read');
  // The bot now reports onto this same Task and closes it with more than we
  // have here — the patient id and the duration alongside the counts. Writing
  // over a Task it has already finished would strip those back out, so a run
  // the bot has closed is left exactly as the bot left it.
  if (current.status === 'completed' || current.status === FAILED) {
    return;
  }
  await withMedplum429Retry(
    () =>
      medplum.updateResource<Task>({
        ...current,
        status: 'completed',
        businessStatus: { text: summary ?? 'complete' },
        output: countsToOutput(counts),
        lastModified: now,
        executionPeriod: { ...current.executionPeriod, end: now },
      }),
    'completeTask write'
  );
}

/**
 * Close the Task as a failure, with a reason a reader can act on.
 * @param medplum - Authenticated Medplum client.
 * @param taskId - The Task to fail.
 * @param reason - Coded reason, e.g. `rate-limited`.
 * @param message - The underlying message.
 * @param counts - Whatever landed before it stopped; partial work is still work.
 */
export async function failTask(
  medplum: MedplumClient,
  taskId: string,
  reason: string,
  message: string,
  counts: CountMap = {}
): Promise<void> {
  const now = new Date().toISOString();
  const current = await withMedplum429Retry(() => medplum.readResource('Task', taskId), 'failTask read');
  // A failure the bot recorded names what actually broke inside the import.
  // This one only knows what escaped the step, so it must not overwrite it.
  //
  // `completed` is guarded for a different and less obvious reason. Every
  // function here closes its Task and *then* hands off to the next stage with
  // `step.sendEvent`. A hand-off that cannot be delivered throws into the
  // function's catch, which lands here — and without this guard the import or
  // index run that genuinely succeeded would be restated as failed because the
  // stage *after* it could not be started. That is the one thing this chain
  // must never do: a chart that imported perfectly, or an index that was
  // written, stays reported as such, and the undelivered hand-off shows up
  // where it belongs, as a failed run in Inngest that an operator can replay.
  //
  // Nothing in this worker legitimately fails a Task it has already completed:
  // completion is always the last meaningful act of a run.
  if (current.status === FAILED || current.status === 'completed') {
    return;
  }
  const statusReason: CodeableConcept = {
    coding: [{ system: IMPORT_ERROR_SYSTEM, code: reason }],
    text: message.slice(0, 500),
  };
  await withMedplum429Retry(
    () =>
      medplum.updateResource<Task>({
        ...current,
        status: FAILED,
        statusReason,
        output: countsToOutput(counts),
        lastModified: now,
        executionPeriod: { ...current.executionPeriod, end: now },
      }),
    'failTask write'
  );
}

/**
 * Attach the patient to a Task that was opened before one was known.
 * @param medplum - Authenticated Medplum client.
 * @param taskId - The Task to update.
 * @param patientId - The resolved Medplum patient.
 */
export async function attachPatient(medplum: MedplumClient, taskId: string, patientId: string): Promise<void> {
  await withMedplum429Retry(
    () =>
      medplum.patchResource('Task', taskId, [
        { op: 'add', path: '/for', value: { reference: `Patient/${patientId}` } },
      ]),
    'attachPatient'
  ).catch(() => {
    // A Task that cannot be re-pointed is still a record of the run; losing
    // the link must not fail the import that succeeded.
  });
}
