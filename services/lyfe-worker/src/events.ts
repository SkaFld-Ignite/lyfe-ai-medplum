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
 *
 * Separate, but not optional. Every chart import emits this once the chart
 * lands — there is no flag, and there was never a good reason for one. Whether
 * the patient may actually be enrolled is decided inside the importer, from the
 * office their encounters are at (the Directory page's Zus column), which is
 * the only place that can decide it correctly. An ineligible patient comes back
 * refused, having cost nothing, and the run closes as skipped rather than
 * failed.
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

/**
 * A patient's documents to index for RAG.
 *
 * Its own event, and its own function, for the same reason the Zus pull is
 * separate from the chart import: it fails for different reasons and on a
 * different timescale. Extraction fails on Textract, on a corrupt PDF, on an
 * embedding quota — none of which say anything about whether the chart
 * imported, and none of which should mark a chart failed.
 *
 * It is also not emitted automatically by the chart import, which the Zus pull
 * is. Indexing is a derived index being rebuilt, not part of making a patient's
 * record complete, and a backfill over 2,823 documents is an operator's
 * decision about cost rather than a consequence of importing one chart.
 */
export interface RagIngestRequested {
  name: 'lyfe/rag.ingest.requested';
  data: {
    /** The clinic. Routing and concurrency — and here also the tenant written onto every chunk. */
    organizationId: string;
    /** Who asked; see {@link ChartImportRequested.data.requester}. */
    requester: string;
    /** The patient whose documents to index. */
    patientId: string;
    /**
     * A Task the caller already opened.
     *
     * Passed down rather than opened again. The worker opens one Task per run
     * and hands its id to whatever does the work, so one run is one row on the
     * Imports page — the same rule the chart and Zus imports now follow.
     */
    taskId?: string;
    batchId?: string;
  };
}

export type LyfeEvents = {
  'lyfe/chart.import.requested': ChartImportRequested;
  'lyfe/zus.import.requested': ZusImportRequested;
  'lyfe/rag.ingest.requested': RagIngestRequested;
};
