// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The events this worker runs on.
 *
 * Deliberately small, and deliberately carrying ids rather than data. An event
 * says *which patient to import*, never the chart itself — so nothing clinical
 * is ever written to the event store, and a replayed run reads fresh data from
 * the source rather than re-applying a stale copy.
 *
 * `organizationId` is on every event because it is the concurrency key. Fan-out
 * is bounded per clinic, not globally, so one clinic's thousand-patient
 * backfill cannot starve the other four — which is the thing neither Medplum
 * bot runtime could express.
 */

/** A DrChrono chart to import. */
export interface ChartImportRequested {
  name: 'lyfe/chart.import.requested';
  data: {
    /** The clinic, and the concurrency key. */
    organizationId: string;
    /** DrChrono's patient id. */
    drchronoPatientId: string;
    /** Pull the Zus record once the chart lands. */
    withZus: boolean;
    /** Groups the patients of one bulk run, so a run can be found as a whole. */
    batchId?: string;
  };
}

/**
 * A patient's Zus record to pull.
 *
 * Separate from the chart import rather than a step inside it, because the two
 * fail independently and for different reasons: a chart import fails on
 * DrChrono, a Zus pull on eligibility or the network. Keeping them apart means
 * a Zus failure never masks a chart that imported perfectly well, and either
 * can be retried alone.
 */
export interface ZusImportRequested {
  name: 'lyfe/zus.import.requested';
  data: {
    organizationId: string;
    /** The Medplum patient the record is written onto. */
    medplumPatientId: string;
    /** True the first time a patient is enrolled, which is the slow path. */
    freshEnrolment?: boolean;
    batchId?: string;
  };
}

export type LyfeEvents = {
  'lyfe/chart.import.requested': ChartImportRequested;
  'lyfe/zus.import.requested': ZusImportRequested;
};
