// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import { completeTask, failTask } from './task.ts';

/**
 * The worker and the bot now write to the same Task, so the worker must not
 * undo what the bot already recorded.
 *
 * The bot closes with the patient id and the duration alongside the counts.
 * The worker knows only the counts, so a blind write-over strips the rest —
 * which is exactly what the duplicate-Task fix would otherwise reintroduce in
 * a subtler form.
 */
/**
 * A Medplum client that reads back a Task in a given state.
 * @param current - The stored Task's fields, notably its status.
 * @returns A stub client whose `updateResource` can be asserted on.
 */
function client(current: Partial<Task>): MedplumClient & { updateResource: ReturnType<typeof vi.fn> } {
  return {
    readResource: vi.fn().mockResolvedValue({ resourceType: 'Task', id: 't1', ...current }),
    updateResource: vi.fn().mockResolvedValue({}),
  } as unknown as MedplumClient & { updateResource: ReturnType<typeof vi.fn> };
}

describe('completeTask', () => {
  test('closes a Task the bot left open', async () => {
    const medplum = client({ status: 'in-progress' });
    await completeTask(medplum, 't1', { Observation: 12 });
    expect(medplum.updateResource).toHaveBeenCalledOnce();
    expect(medplum.updateResource.mock.calls[0][0]).toMatchObject({ status: 'completed' });
  });

  test('leaves a Task the bot already completed exactly as it is', async () => {
    const medplum = client({ status: 'completed' });
    await completeTask(medplum, 't1', { Observation: 12 });
    expect(medplum.updateResource).not.toHaveBeenCalled();
  });

  test('does not resurrect a Task the bot failed', async () => {
    const medplum = client({ status: 'failed' });
    await completeTask(medplum, 't1', {});
    expect(medplum.updateResource).not.toHaveBeenCalled();
  });
});

describe('failTask', () => {
  test('records a failure on a Task still in progress', async () => {
    const medplum = client({ status: 'in-progress' });
    await failTask(medplum, 't1', 'rate-limited', 'Too Many Requests');
    expect(medplum.updateResource).toHaveBeenCalledOnce();
    expect(medplum.updateResource.mock.calls[0][0]).toMatchObject({ status: 'failed' });
  });

  test('keeps the bot’s failure reason rather than overwriting it', async () => {
    // The bot's reason names what broke inside the import; this one only knows
    // what escaped the step.
    const medplum = client({ status: 'failed' });
    await failTask(medplum, 't1', 'unknown', 'step failed');
    expect(medplum.updateResource).not.toHaveBeenCalled();
  });

  test('does not restate a finished run as a failed one', async () => {
    // Every function in this worker closes its Task and *then* hands off to the
    // next stage with `step.sendEvent`. A hand-off that cannot be delivered
    // throws into the function's catch, which calls this — so without the guard
    // a chart that imported perfectly would be marked failed because the stage
    // after it could not be started. The undelivered hand-off belongs in
    // Inngest as a replayable run, not on the patient's row as a failed import.
    const medplum = client({ status: 'completed' });
    await failTask(medplum, 't1', 'unknown', 'could not send lyfe/rag.ingest.requested');
    expect(medplum.updateResource).not.toHaveBeenCalled();
  });
});
