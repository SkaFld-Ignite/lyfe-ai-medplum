// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { NonRetriableError } from 'inngest';
import { handler as drchronoHandler } from '../../../../examples/medplum-provider/bots/drchrono-import.ts';
import { inngest, PER_CLINIC_CONCURRENCY } from '../inngest.ts';
import { getMedplum } from '../medplum.ts';
import { completeTask, failTask, setPhase, startTask } from '../task.ts';

/**
 * Import one DrChrono chart.
 *
 * The import itself is the same code the Medplum bot ran — it was always a
 * plain function over a `MedplumClient`, so it moves across untouched. What
 * changes is everything around it: concurrency is keyed per clinic, retries
 * and backoff belong to Inngest, and there is no 15-minute execution ceiling
 * to design around.
 *
 * A FHIR `Task` is still written for every run. Inngest answers "why did forty
 * imports fail"; the Task answers "did this patient import", which is the
 * question the people using the product actually ask. See `task.ts`.
 */
export const chartImport = inngest.createFunction(
  {
    id: 'drchrono-chart-import',
    name: 'DrChrono chart import',
    concurrency: { key: 'event.data.organizationId', limit: PER_CLINIC_CONCURRENCY },
    retries: 3,
  },
  { event: 'lyfe/chart.import.requested' },
  async ({ event, step, runId, logger }) => {
    const { organizationId, drchronoPatientId, withZus, batchId } = event.data;
    const medplum = await getMedplum();
    const organization = { reference: `Organization/${organizationId}` };

    // The chart import resolves the Medplum patient itself, so the Task cannot
    // be opened against a patient until the import has run at least far enough
    // to find or create one. Rather than guess, the import runs first and the
    // Task is opened from its result — which is also what makes the Task
    // patient-keyed rather than DrChrono-keyed.
    const result = await step.run('import-chart', async () => {
      logger.info('importing chart', { drchronoPatientId, organizationId });
      return drchronoHandler(medplum, {
        bot: { reference: 'Bot/inngest' },
        contentType: 'application/json',
        secrets: {},
        input: { action: 'import', drchronoPatientId },
      } as never);
    });

    if (!result.ok) {
      // A chart that DrChrono will never return is not worth three attempts.
      // Anything else — a timeout, a 429, a blip — is, and throwing a plain
      // Error lets Inngest retry with backoff.
      const message = 'error' in result ? String(result.error) : 'import failed';
      if (/not found|no patient|invalid/i.test(message)) {
        throw new NonRetriableError(message);
      }
      throw new Error(message);
    }

    const patientId = 'medplumPatientId' in result ? (result.medplumPatientId as string) : undefined;
    if (!patientId) {
      throw new NonRetriableError('Import reported success without a patient id');
    }

    // Recorded after the fact rather than streamed: this function's phases are
    // visible in Inngest as steps, and the Task's job is to be the patient-keyed
    // record of what landed, not a second progress bar.
    await step.run('record-task', async () => {
      const task = await startTask({
        medplum,
        organization,
        code: 'drchrono-import',
        patientId,
        runId,
        batchId,
      });
      await setPhase(medplum, task.id as string, 'chart imported');
      await completeTask(
        medplum,
        task.id as string,
        ('counts' in result ? result.counts : {}) as Record<string, number>
      );
      return task.id;
    });

    // Sent as its own event rather than awaited inline, so a Zus failure never
    // marks a chart that imported perfectly well as failed, and either half can
    // be retried without the other.
    if (withZus) {
      await step.sendEvent('request-zus', {
        name: 'lyfe/zus.import.requested',
        data: { organizationId, medplumPatientId: patientId, batchId },
      });
    }

    return { patientId, counts: 'counts' in result ? result.counts : {} };
  }
);

/**
 * Turn a thrown error into the coded reason the Imports page shows.
 *
 * Kept next to the function that produces the failures rather than in the
 * shared task module, because the classification is about *these* imports.
 * @param err - Whatever was thrown.
 * @returns A coded reason.
 */
export function classify(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/429|rate.?limit/i.test(message)) {
    return 'rate-limited';
  }
  if (/401|403|token|unauthor/i.test(message)) {
    return 'auth-expired';
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return 'timeout';
  }
  if (/5\d\d|server error/i.test(message)) {
    return 'server-error';
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|network/i.test(message)) {
    return 'network-error';
  }
  if (/404|not found/i.test(message)) {
    return 'not-found';
  }
  return 'unknown';
}

export { failTask };
