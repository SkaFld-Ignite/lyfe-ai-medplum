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

/**
 * Chart imports allowed to START per clinic per hour.
 *
 * DrChrono's documented default is **500 API calls per hour, reset at the top
 * of each hour** (their API docs, Introduction → Rate Limits). One chart import
 * is not one call: it reads appointments, problems, medications, allergies,
 * procedures, insurances, vaccines, lab orders, lab results, lab documents,
 * documents, doctors and offices, each paginated, plus a fetch per document.
 * Call it ~25 calls for a typical chart.
 *
 * 14 starts an hour is therefore roughly 350 calls — the hourly budget with
 * headroom left for everything else that talks to DrChrono from the same
 * application.
 *
 * This is the rate control. {@link PER_CLINIC_CONCURRENCY} is not: it caps how
 * many run at one instant, and at ~70s an import it would never bind at this
 * rate. It stays where it is as a pile-up guard, for the case where an import
 * hangs rather than finishes.
 *
 * Why a throttle and not a smaller concurrency: DrChrono's limit is a rate, so
 * the control has to be one too. Inngest spaces starts evenly across the period
 * (`burst` defaults to 1), which is also what stops a run spending the whole
 * hour's budget in its first two minutes and then waiting for the clock.
 *
 * An environment variable because the number is DrChrono's, not ours. They
 * invite a request for a higher limit; the day that lands, this is a config
 * change rather than a deploy.
 */
export const DRCHRONO_IMPORTS_PER_HOUR = Number(process.env.DRCHRONO_IMPORTS_PER_HOUR ?? 14);
