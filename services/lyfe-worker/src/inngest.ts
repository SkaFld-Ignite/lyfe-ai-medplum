// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { EventSchemas, Inngest } from 'inngest';
import type { LyfeEvents } from './events.ts';

/**
 * The Inngest client, typed by {@link LyfeEvents} so a misspelled event name or
 * a missing field is a compile error rather than a run that never fires.
 */
export const inngest = new Inngest({
  id: 'lyfe-worker',
  schemas: new EventSchemas().fromRecord<LyfeEvents>(),
});

/**
 * How many patients one clinic imports at once.
 *
 * Keyed on the clinic, not global: at five clinics a global cap means one
 * clinic's thousand-patient backfill starves the other four, which is exactly
 * the failure a bounded loop in the browser also had.
 *
 * The number itself is currently set by the Inngest plan, not by anything
 * about this workload. Registering with a higher value is refused outright:
 *
 *   "The function 'DrChrono chart import' has higher concurrency limits (20)
 *    than your plan limit of 5"
 *
 * Worth being clear-eyed about what that means. It is not a limit DrChrono,
 * Zus or Medplum imposed, and it is lower than the six the in-page loop ran
 * at — so on this plan the move to Inngest buys durability, retries, per-clinic
 * fairness and the step-based waits that a fresh Zus enrolment needs, but it
 * does not by itself buy throughput. Throughput is a billing decision now,
 * which is at least a decision rather than an architectural ceiling.
 */
export const PER_CLINIC_CONCURRENCY = Number(process.env.INNGEST_CONCURRENCY ?? 5);
