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
 *
 * `requester` is on every event for a different reason, and it is a security
 * one. The importers derive the clinic they write into from the *caller's* own
 * ProjectMembership, never from their input — taking an `organizationId`
 * argument would be an IDOR, since anyone could pass another clinic's id and
 * have that clinic's chart written under their session. Moving the work out of
 * Medplum does not move that rule: the event carries whoever asked, and the
 * importer resolves the clinic from them exactly as before.
 *
 * Which means `organizationId` here is for routing and concurrency only. It is
 * never what decides where data lands. The two must agree, and the importer's
 * answer is the one that counts.
 */

/** A DrChrono chart to import. */
export interface ChartImportRequested {
  name: 'lyfe/chart.import.requested';
  data: {
    /** The clinic. Routing and concurrency only — see the note above. */
    organizationId: string;
    /**
     * Who asked, e.g. `Practitioner/abc`. The importer resolves the clinic
     * from this, so it must be set by a trusted emitter from an authenticated
     * session — never taken from a browser request body.
     */
    requester: string;
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
    /** Who asked; see {@link ChartImportRequested.data.requester}. */
    requester: string;
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
