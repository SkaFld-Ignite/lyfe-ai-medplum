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
 * It **is** emitted automatically, by both importers — which reverses what
 * this comment used to say. The argument for leaving it manual was cost: a
 * backfill over 2,823 documents is an operator's decision. That conflated two
 * different things. A *backfill* is an operator's decision and still is, which
 * is what `POST /api/rag/ingest` is for. Indexing *the patient who just
 * imported* is not a decision at all. Nobody pulls a chart and then wants its
 * documents left unsearchable, and asking a clinician to click a second button
 * to make the record they just imported legible to the assistant is asking
 * them to do the computer's bookkeeping.
 *
 * So the chart import emits this once the chart lands, and the Zus import emits
 * it again once the network record lands — the half that matters most, since
 * most documents come from the network and can arrive hours later. Two runs per
 * patient is correct rather than wasteful: a document's chunks are replaced on
 * re-ingest, never appended, so the second run converges on the same index plus
 * whatever the network added.
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

/**
 * A patient's AI summary to generate.
 *
 * The last link in the import chain, and its own event for the two reasons
 * every other link here is — plus a third that is specific to it.
 *
 * It **fails differently**: a summary fails on the `$ai` operation, on a model
 * returning something that is not the agreed JSON, on a project that does not
 * carry the `ai` feature. None of those say anything about whether the chart
 * imported or the documents indexed, and none may mark either as failed.
 *
 * It **retries differently**: one model call is worth a handful of attempts,
 * not the six a multi-hour network pull earns.
 *
 * And it has to be **debounced**, which is the reason a step inside the indexer
 * could not have served. A patient is indexed twice in the normal case — once
 * when the chart lands, once when the network record does — and each completion
 * asks for a summary. Undebounced that is two model calls over nearly the same
 * chart, the first overwritten by the second minutes later. Debounce is an
 * Inngest config at *function* level, so the only way to have it is for the
 * summary to be its own function behind its own event. See
 * `functions/patient-summary.ts`.
 */
export interface SummaryGenerateRequested {
  name: 'lyfe/summary.generate.requested';
  data: {
    /** The clinic. Routing and concurrency only — see the note at the top. */
    organizationId: string;
    /**
     * Who asked; see {@link ChartImportRequested.data.requester}.
     *
     * Load-bearing here exactly as it is for the importers: the summary bot
     * resolves the clinic it files the `Composition` under from this, through
     * `resolveCallerOrganization`, and not from `organizationId` above.
     */
    requester: string;
    /** The patient to summarise. Also the debounce key. */
    patientId: string;
    /**
     * Why a summary was asked for, e.g. `documents-indexed`.
     *
     * Carried for the log only. Debouncing keeps the last event of a window and
     * discards the earlier ones, so this names whichever request happened to
     * arrive last — useful for reading a run, never for deciding anything.
     */
    reason?: string;
    batchId?: string;
  };
}

export type LyfeEvents = {
  'lyfe/chart.import.requested': ChartImportRequested;
  'lyfe/zus.import.requested': ZusImportRequested;
  'lyfe/rag.ingest.requested': RagIngestRequested;
  'lyfe/summary.generate.requested': SummaryGenerateRequested;
};
