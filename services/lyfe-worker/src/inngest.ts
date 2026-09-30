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
 * The ceiling that matters is not this number but what DrChrono and Zus
 * tolerate, and what Medplum can absorb in writes. Start where a real day can
 * be measured, then raise it on evidence.
 */
export const PER_CLINIC_CONCURRENCY = 20;
