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
 * Five was once the Inngest plan's ceiling rather than a judgement about the
 * workload. Registering anything higher was refused outright:
 *
 *   "The function 'DrChrono chart import' has higher concurrency limits (20)
 *    than your plan limit of 5"
 *
 * **That plan is gone** — the account is on Pro, which allows 100+ concurrent
 * steps. So the number is a choice again, and it is deliberately still small,
 * because what bounds the two functions using it is the service at the other
 * end rather than Inngest:
 *
 * - **Chart import** is paced by {@link DRCHRONO_IMPORTS_PER_HOUR}, because
 *   DrChrono's limit is a rate. At roughly seventy seconds an import this
 *   concurrency never binds; it stays as a guard against runs stacking up when
 *   one hangs rather than finishes.
 * - **The network pull** is bounded by Zus, which allows ten enrolment
 *   requests a minute per customer. At about forty seconds a pull, five at a
 *   time already sits near that.
 *
 * The work that genuinely wanted more room — indexing and summarisation, which
 * talk to Textract and Bedrock and never to DrChrono — has its own number:
 * {@link AI_CONCURRENCY}. Raising this one would buy nothing and spend
 * somebody else's quota.
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

/**
 * How many indexing and AI runs one clinic may have in flight at once.
 *
 * Separate from {@link PER_CLINIC_CONCURRENCY} because it is bounded by
 * something else entirely. Document indexing and summarisation talk to Textract
 * and Bedrock; they never touch DrChrono, so DrChrono's 500 calls an hour has
 * no opinion about them. Sharing one number meant the slowest-finishing half of
 * the chain — the half a clinician actually waits on, since the AI summary is
 * the last thing to appear — ran at a limit that existed only because the
 * Inngest Hobby plan allowed five concurrent steps. That plan is gone.
 *
 * Fifteen rather than something larger: each index run fans out internally to
 * four concurrent Textract calls, so fifteen patients is sixty OCR requests in
 * flight, which is a real fraction of a default Textract quota. Textract
 * throttles are retried rather than recorded as failures, so overshooting costs
 * time rather than documents — but there is no reason to aim for it.
 */
export const AI_CONCURRENCY = Number(process.env.AI_CONCURRENCY ?? 15);
