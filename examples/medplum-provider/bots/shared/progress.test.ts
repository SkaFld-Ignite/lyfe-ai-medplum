// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient, WithId } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import { openOrAdoptTask } from './progress.ts';

/**
 * One import must produce one Task.
 *
 * The worker opens a Task before invoking a bot so that a run dying before the
 * bot is reached still leaves a record. The bot then used to open a second one,
 * and the Imports page showed the same import twice — one row with the run and
 * batch ids but no progress, one with the progress but no ids. These pin down
 * that the bot adopts the caller's Task instead.
 */
const CALLER_TASK = { resourceType: 'Task', id: 'caller-task', status: 'in-progress' } as WithId<Task>;
const OWN_TASK = { resourceType: 'Task', id: 'own-task', status: 'in-progress' } as WithId<Task>;

function clientReturning(task: WithId<Task>): MedplumClient {
  return { readResource: vi.fn().mockResolvedValue(task) } as unknown as MedplumClient;
}

function clientRejecting(): MedplumClient {
  return { readResource: vi.fn().mockRejectedValue(new Error('not found')) } as unknown as MedplumClient;
}

describe('openOrAdoptTask', () => {
  test('adopts the caller’s Task rather than opening a second one', async () => {
    const create = vi.fn().mockResolvedValue(OWN_TASK);
    const task = await openOrAdoptTask({
      medplum: clientReturning(CALLER_TASK),
      taskId: 'caller-task',
      create,
    });
    expect(task.id).toBe('caller-task');
    // The whole point: no second Task is created.
    expect(create).not.toHaveBeenCalled();
  });

  test('opens its own when invoked directly, with no caller Task', async () => {
    // This is the patient-search and onboarding path, which must keep working
    // exactly as before — those callers open nothing.
    const create = vi.fn().mockResolvedValue(OWN_TASK);
    const task = await openOrAdoptTask({ medplum: clientReturning(CALLER_TASK), taskId: undefined, create });
    expect(task.id).toBe('own-task');
    expect(create).toHaveBeenCalledOnce();
  });

  test('falls back to opening one when the caller’s Task cannot be read', async () => {
    // Losing the bookkeeping is bad; failing the import over it would be worse.
    const create = vi.fn().mockResolvedValue(OWN_TASK);
    const task = await openOrAdoptTask({ medplum: clientRejecting(), taskId: 'deleted-task', create });
    expect(task.id).toBe('own-task');
    expect(create).toHaveBeenCalledOnce();
  });

  test('does not read a Task when there is no id to read', async () => {
    const medplum = clientReturning(CALLER_TASK);
    await openOrAdoptTask({ medplum, taskId: undefined, create: async () => OWN_TASK });
    expect(medplum.readResource).not.toHaveBeenCalled();
  });
});
