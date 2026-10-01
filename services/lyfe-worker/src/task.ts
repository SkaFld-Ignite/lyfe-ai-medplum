// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Organization, Reference, Task, TaskOutput } from '@medplum/fhirtypes';

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
  return props.medplum.createResource<Task>({
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
  });
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
  await medplum
    .patchResource('Task', taskId, [{ op: 'add', path: '/businessStatus', value: { text: phase } }])
    .catch(() => {
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
 */
export async function completeTask(medplum: MedplumClient, taskId: string, counts: CountMap): Promise<void> {
  const now = new Date().toISOString();
  // `for` and `identifier` are read back and rewritten deliberately: a bare
  // update built from a stale copy silently dropped `Task.for` once, which
  // detached a finished run from its patient.
  const current = await medplum.readResource('Task', taskId);
  await medplum.updateResource<Task>({
    ...current,
    status: 'completed',
    businessStatus: { text: 'complete' },
    output: countsToOutput(counts),
    lastModified: now,
    executionPeriod: { ...current.executionPeriod, end: now },
  });
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
  const current = await medplum.readResource('Task', taskId);
  const statusReason: CodeableConcept = {
    coding: [{ system: IMPORT_ERROR_SYSTEM, code: reason }],
    text: message.slice(0, 500),
  };
  await medplum.updateResource<Task>({
    ...current,
    status: 'failed',
    statusReason,
    output: countsToOutput(counts),
    lastModified: now,
    executionPeriod: { ...current.executionPeriod, end: now },
  });
}

/**
 * Attach the patient to a Task that was opened before one was known.
 * @param medplum - Authenticated Medplum client.
 * @param taskId - The Task to update.
 * @param patientId - The resolved Medplum patient.
 */
export async function attachPatient(medplum: MedplumClient, taskId: string, patientId: string): Promise<void> {
  await medplum
    .patchResource('Task', taskId, [{ op: 'add', path: '/for', value: { reference: `Patient/${patientId}` } }])
    .catch(() => {
      // A Task that cannot be re-pointed is still a record of the run; losing
      // the link must not fail the import that succeeded.
    });
}
