// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { IDENTIFIER_SYSTEMS } from '../../../../examples/medplum-provider/bots/drchrono-import.ts';
import { BATCH_IDENTIFIER, SOURCE_ID_IDENTIFIER } from '../task.ts';

/**
 * The two questions that make a pass idempotent.
 *
 * Re-running must not create a second chart. The import itself is already a
 * conditional update by `https://drchrono.com/patients|<id>`, so a duplicate
 * queue cannot produce a duplicate patient — but it can produce a duplicate
 * run: another Task on the Imports page, another trip through DrChrono, and
 * another slice of a practice's quota spent re-reading a chart nobody changed.
 * On a provider that throttles for forty-five minutes, that is not free.
 *
 * So the pass asks twice, and the two questions are genuinely different:
 *
 * 1. Is this patient already in Medplum? ({@link findImportedPatientIds})
 *    Answers for every previous day and every other route in — the manual
 *    onboarding screen, a webhook, a bulk run.
 * 2. Has this same window already queued them? ({@link findQueuedSourceIds})
 *    Answers for the minutes between a pass emitting an event and the import
 *    finishing, which is precisely when question 1 still says "no".
 */

/** DrChrono's patient identifier system, as the importer stamps it. */
export const DRCHRONO_PATIENT_SYSTEM = IDENTIFIER_SYSTEMS.patient;

/**
 * How many identifiers go into one search.
 *
 * FHIR token search takes a comma-separated list as an OR, so forty patients
 * is one round trip rather than forty. Chunked anyway because the list ends up
 * in a URL and servers have opinions about how long one may be.
 */
const SEARCH_CHUNK = 40;

/**
 * Which of these DrChrono patients already have a chart in this clinic.
 *
 * Scoped to the clinic, and deliberately not only by identifier. DrChrono ids
 * are unique within a practice, not across them, so a bare identifier search
 * can legitimately return another tenant's patient — and treating that as
 * "already imported" would mean this clinic silently never gets the chart. A
 * patient carrying no account at all is accepted as this clinic's: those are
 * rows written before compartment stamping, and rejecting them would re-import
 * every one of them.
 * @param props - The lookup.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.organizationId - The clinic.
 * @param props.drchronoPatientIds - Candidate DrChrono ids.
 * @returns The subset that already has a chart here.
 */
export async function findImportedPatientIds(props: {
  medplum: MedplumClient;
  organizationId: string;
  drchronoPatientIds: readonly string[];
}): Promise<Set<string>> {
  const { medplum, organizationId } = props;
  const expected = `Organization/${organizationId}`;
  const found = new Set<string>();

  for (const chunk of chunks(props.drchronoPatientIds, SEARCH_CHUNK)) {
    const query = chunk.map((id) => `${DRCHRONO_PATIENT_SYSTEM}|${id}`).join(',');
    const patients = await medplum.searchResources('Patient', {
      identifier: query,
      _count: String(SEARCH_CHUNK * 2),
    });
    for (const patient of patients) {
      const account = patient.meta?.account?.reference;
      if (account && account !== expected) {
        continue;
      }
      for (const identifier of patient.identifier ?? []) {
        if (identifier.system === DRCHRONO_PATIENT_SYSTEM && identifier.value) {
          found.add(identifier.value);
        }
      }
    }
  }
  return found;
}

/**
 * Which DrChrono patients this window has already queued.
 *
 * Read off the Tasks the chart imports open, by the batch id the pass derives
 * from the clinic and the window — so two passes over the same window share a
 * batch and the second one can see what the first did. Every Task carries the
 * DrChrono id it is about (`SOURCE_ID_IDENTIFIER`), which is what makes this
 * answerable in one search instead of one per patient.
 *
 * Failed Tasks count as queued. Inngest has already retried that import six
 * times, and a discovery pass re-running an hour later would only walk it into
 * the same wall; tomorrow's pass derives a different batch id from a different
 * window start and will try again, which is the right cadence for a chart that
 * needs a person to look at it.
 * @param props - The lookup.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.batchId - The batch this window queues under.
 * @returns The DrChrono ids already represented by a Task in that batch.
 */
export async function findQueuedSourceIds(props: { medplum: MedplumClient; batchId: string }): Promise<Set<string>> {
  const tasks = await props.medplum.searchResources('Task', {
    identifier: `${BATCH_IDENTIFIER}|${props.batchId}`,
    _count: '500',
  });
  const found = new Set<string>();
  for (const task of tasks) {
    for (const identifier of task.identifier ?? []) {
      if (identifier.system === SOURCE_ID_IDENTIFIER && identifier.value) {
        found.add(identifier.value);
      }
    }
  }
  return found;
}

/**
 * Record on the pass's own Task which patients it queued.
 *
 * Without this the second question above cannot be answered. The chart-import
 * Tasks that carry these ids do not exist yet at the moment the events are
 * sent — they are opened by the import function, which Inngest may not start
 * for minutes — so a pass re-run in that gap would find no Patient and no Task
 * and queue every one of them a second time. Writing the ids here closes the
 * window, on the resource the pass already owns, using the identifier system
 * the importers already stamp.
 *
 * Appended rather than replacing: the Task is read back first so the run id
 * and the batch id it was opened with survive. Failing to record is logged and
 * swallowed for the same reason a lost progress update is — the imports have
 * already been asked for, and a bookkeeping write must not be what turns a
 * successful pass into a failed one. The cost of losing it is a duplicate
 * request, which the conditional update downstream absorbs.
 * @param props - What to record.
 * @param props.medplum - The worker's own Medplum client.
 * @param props.taskId - The pass's Task.
 * @param props.drchronoPatientIds - The ids just queued.
 */
export async function recordQueuedSourceIds(props: {
  medplum: MedplumClient;
  taskId: string;
  drchronoPatientIds: readonly string[];
}): Promise<void> {
  if (props.drchronoPatientIds.length === 0) {
    return;
  }
  try {
    const task = await props.medplum.readResource('Task', props.taskId);
    const identifier = [
      ...(task.identifier ?? []),
      ...props.drchronoPatientIds.map((value) => ({ system: SOURCE_ID_IDENTIFIER, value })),
    ];
    await props.medplum.updateResource({ ...task, identifier });
  } catch (err) {
    console.warn(`[discovery] could not record queued patients: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The batch one clinic's pass over one window queues under.
 *
 * Deterministic rather than random, which is the whole mechanism behind
 * {@link findQueuedSourceIds}: a second pass over the same window has to land
 * in the same batch to be able to see the first one's work. It also means the
 * Imports page groups a day's onboarding as one run.
 * @param props - What identifies the pass.
 * @param props.organizationId - The clinic.
 * @param props.start - The window's first date.
 * @returns The batch id.
 */
export function discoveryBatchId(props: { organizationId: string; start: string }): string {
  return `discovery-${props.organizationId}-${props.start}`;
}

/**
 * Split a list into chunks.
 * @param values - The list.
 * @param size - Chunk size.
 * @yields Each chunk in turn.
 */
function* chunks<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) {
    yield values.slice(i, i + size);
  }
}
