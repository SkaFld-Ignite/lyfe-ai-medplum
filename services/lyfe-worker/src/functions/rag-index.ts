// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { NonRetriableError } from 'inngest';
import { openOrAdoptTask } from '../../../../examples/medplum-provider/bots/shared/progress.ts';
import { AI_CONCURRENCY, inngest } from '../inngest.ts';
import { getMedplum } from '../medplum.ts';
import { isRagConfigured } from '../rag/db.ts';
import type { PatientDocument } from '../rag/ingest.ts';
import { ingestDocument, listPatientDocuments } from '../rag/ingest.ts';
import { getOcrUnavailableReason } from '../rag/ocr.ts';
import { ensureRagSchema } from '../rag/schema.ts';
import { withStepTimeout } from '../rate-limit.ts';
import { completeTask, failTask, setPhase, startTask } from '../task.ts';
import { classify } from './chart-import.ts';

/**
 * Build the document index for one patient.
 *
 * ## Why the work is sliced
 *
 * Inngest drives every step by making an HTTP request to this server, and
 * Railway's proxy kills any request at 15 minutes. `withStepTimeout` fails at
 * 12 so the error is ours and legible rather than a 502 with no step output.
 *
 * That budget is the whole reason this function is shaped the way it is. A
 * single scanned PDF can cost 50 Textract calls plus 40 embeddings — minutes,
 * for one document. The corpus is 2,823 documents; one step could not hold a
 * fraction of it.
 *
 * So documents are ingested {@link DOCS_PER_STEP} at a time, each slice its own
 * step. A slice that dies is retried alone, and the slices before it are
 * memoised — Inngest does not re-run them, so a retry does not re-OCR
 * everything that already succeeded. That is also why the per-document write is
 * idempotent: a retried slice re-ingests its documents, and re-ingest must
 * replace rather than duplicate.
 *
 * ## One Task, not two
 *
 * The run opens a Task if the event did not bring one, and otherwise adopts the
 * caller's — `openOrAdoptTask`, the same helper the bots use. Two Tasks for one
 * run is a bug this repo has already fixed once: it put two rows on the Imports
 * page for one import, one of them permanently stuck at its opening phase.
 */

/**
 * Documents per step.
 *
 * Four. Sized against the worst realistic document rather than the average:
 * a 50-page scan at four concurrent Textract calls is a few minutes, so four
 * of them is the most that reliably fits inside the 12-minute step budget. A
 * patient whose documents are all C-CDA will finish a slice in seconds — the
 * cost of a conservative number is more steps, and steps are cheap.
 */
export const DOCS_PER_STEP = 4;

/**
 * Hard cap on documents indexed in one run.
 *
 * Not a performance limit — a blast radius. The corpus averages well under this
 * per patient, so a patient exceeding it means something upstream has gone
 * wrong (a sync loop duplicating attachments, say), and discovering that
 * through a Textract bill is the expensive way.
 */
export const MAX_DOCS_PER_RUN = 400;

/** What a slice reports back: the four counts, plus why anything was not indexed. */
interface SliceTotals {
  indexed: number;
  skipped: number;
  failed: number;
  chunks: number;
  /** `<status>:<reason code>` → count, e.g. `skipped:ocr-unavailable`. */
  reasons: Record<string, number>;
}

export const ragIndex = inngest.createFunction(
  {
    id: 'rag-document-index',
    name: 'Document RAG index',
    concurrency: { key: 'event.data.organizationId', limit: AI_CONCURRENCY },
    // Matches the importers. Most of what fails here is a rate limit on
    // Medplum, Bedrock or Textract, and those reschedule rather than spend an
    // attempt usefully.
    retries: 6,
  },
  { event: 'lyfe/rag.ingest.requested' },
  async ({ event, step, runId, logger }) => {
    const { organizationId, requester, patientId, taskId: callerTaskId, batchId } = event.data;

    /**
     * Ask for this patient's AI summary.
     *
     * Sent from every terminal path of this function, including the ones that
     * indexed nothing, because the summary does not depend on the index being
     * useful — it is written from structured FHIR, and document excerpts are an
     * additional context block that is currently empty either way. A patient
     * with no documents, or whose indexing failed, still has conditions,
     * medications, labs and encounters worth summarising, and withholding the
     * summary because a derived index came back empty would be the chain
     * punishing the patient for the infrastructure.
     *
     * Its own event, fire-and-forget. One model call failing must not mark an
     * index run that succeeded as failed, and the two have to be retriable
     * independently. Debounced on the patient at the other end, so the
     * chart-driven and network-driven index completions produce one summary
     * rather than two — see `functions/patient-summary.ts`.
     *
     * Sent after the Task is closed, on both the empty and the indexed path.
     * `step.sendEvent` can itself fail, and when it does the error lands in the
     * `catch` below — which is deliberate rather than tolerated: an undelivered
     * hand-off is a real failure and should show as a red run an operator can
     * replay, not vanish into a log line. What it must *not* do is restate a
     * finished index run as a failed one, and that is `failTask`'s job to
     * refuse; see its guard in `task.ts`.
     * @param id - Step id; distinct per call site so replay stays deterministic.
     * @param why - What asked for it, for the log.
     * @returns Resolves once the event is accepted.
     */
    const requestSummary = async (id: string, why: string): Promise<unknown> =>
      step.sendEvent(id, {
        name: 'lyfe/summary.generate.requested',
        data: { organizationId, requester, patientId, reason: why, batchId },
      });

    if (!isRagConfigured()) {
      // The chain is forwarded before this run gives up. A worker deployed
      // without `RAG_DATABASE_URL` still runs the importers — RAG is an
      // addition to this service, not a precondition for it — and if the
      // summary hung off the index being configured, such a deployment would
      // silently produce no summaries at all. The summary needs Medplum and
      // `$ai`, neither of which is this variable.
      await requestSummary('request-summary-unconfigured', 'index-unavailable');
      // Not retryable: no number of attempts adds an environment variable.
      throw new NonRetriableError(
        'RAG_DATABASE_URL is not set on this worker, so there is no index to write to. ' +
          'On Railway it is a reference to the Medplum Postgres.'
      );
    }
    const medplum = await getMedplum();
    const organization = { reference: `Organization/${organizationId}` };

    // `requester` is carried on the event and not used to pick the clinic here,
    // for the same reason the importers carry it: the HTTP trigger already
    // resolved the organization from the caller's own membership, and this
    // function must not offer a second, weaker way to choose one.
    logger.info('indexing documents', { patientId, organizationId, requester });

    const taskId = await step.run('open-task', async () =>
      withStepTimeout('open-task', async () => {
        const task = await openOrAdoptTask({
          medplum,
          taskId: callerTaskId,
          // `startTask` is typed `Promise<Task>` while `openOrAdoptTask` wants
          // `Promise<WithId<Task>>`. A server-created resource always has an
          // id, so this narrows rather than asserts — but it is checked, so a
          // server that ever returned one without an id fails here saying so
          // instead of writing `undefined` into every later patch path.
          create: async () => {
            const created = await startTask({ medplum, organization, code: 'rag-index', patientId, runId, batchId });
            if (!created.id) {
              throw new Error('Medplum created a Task with no id');
            }
            return created as WithId<Task>;
          },
        });
        return task.id;
      })
    );

    try {
      // The migration runs here rather than at worker startup. At startup it
      // would make RAG a precondition for the DrChrono and Zus imports, which
      // do not use it; here it is idempotent, memoised per process, and a
      // missing pgvector grant fails the run that needed it with a message
      // naming the grant.
      await step.run('ensure-schema', () => withStepTimeout('ensure-schema', () => ensureRagSchema()));

      const documents = await step.run('list-documents', async () =>
        withStepTimeout(`list documents for ${patientId}`, async () => {
          await setPhase(medplum, taskId, 'finding documents');
          return listPatientDocuments(medplum, patientId, MAX_DOCS_PER_RUN);
        })
      );

      if (documents.length === 0) {
        // Completed, not failed. A patient with no documents is an ordinary
        // patient — a new intake, a chart whose attachments live only in the
        // outside record — and reporting that as an error would put a red row
        // on the Imports page for a run that did exactly what it should.
        await step.run('complete-empty', () => completeTask(medplum, taskId, {}));
        await requestSummary('request-summary-empty', 'no-documents');
        return { patientId, documents: 0, indexed: 0, skipped: 0, failed: 0, chunks: 0 };
      }

      const totals: SliceTotals = { indexed: 0, skipped: 0, failed: 0, chunks: 0, reasons: {} };
      const sliceCount = Math.ceil(documents.length / DOCS_PER_STEP);

      for (let slice = 0; slice < sliceCount; slice++) {
        const batch = documents.slice(slice * DOCS_PER_STEP, (slice + 1) * DOCS_PER_STEP);
        const result = await step.run(`ingest-${slice}`, async () =>
          withStepTimeout(`ingest slice ${slice + 1} of ${sliceCount}`, async () => {
            await setPhase(
              medplum,
              taskId,
              `indexing documents · ${slice * DOCS_PER_STEP + 1}-${slice * DOCS_PER_STEP + batch.length} of ${documents.length}`
            );
            return ingestSlice({ medplum, organizationId, patientId, batch });
          })
        );
        totals.indexed += result.indexed;
        totals.skipped += result.skipped;
        totals.failed += result.failed;
        totals.chunks += result.chunks;
        for (const [reason, count] of Object.entries(result.reasons)) {
          totals.reasons[reason] = (totals.reasons[reason] ?? 0) + count;
        }
      }

      // Reported on the Task so the Imports page can show what landed without
      // anyone opening Inngest. `skipped` is its own number rather than folded
      // into `failed`: a TIFF nobody can read and a PDF that errored need
      // different responses.
      //
      // The per-reason entries alongside them are the point of this run's
      // changes. Four integers were all that left the worker, and a batch that
      // reported `151 failed` could not be explained by anyone afterwards
      // because the reasons were written only into `lyfe_rag.documents`, which
      // resolves inside the Railway network and nowhere else. `Task.output`
      // takes a `type.text` and a `valueInteger` and needs no new data type to
      // carry `skipped:ocr-unavailable 41` beside `documents-skipped 41`.
      await step.run('complete-task', async () =>
        withStepTimeout('complete-task', async () => {
          const ocrNote = getOcrUnavailableReason();
          if (ocrNote) {
            await setPhase(medplum, taskId, 'complete — OCR unavailable, scanned documents skipped');
          }
          await completeTask(medplum, taskId, {
            'documents-indexed': totals.indexed,
            'documents-skipped': totals.skipped,
            'documents-failed': totals.failed,
            chunks: totals.chunks,
            ...totals.reasons,
          });
        })
      );

      // The index is current, so the summary can be written over the most
      // complete chart this patient has had. This is the ordering the platform
      // this was ported from used, and it is kept for a reason that is about to
      // matter rather than one that already does: the summary prompt has a
      // RECENT DOCUMENTS block (the DOCUMENT CONTEXT SEAM in
      // `shared/ai-summary-prompt.ts`) which is still fed an empty list, so
      // today the order changes nothing the model sees. The moment that seam is
      // wired to this index, the order is what makes the summary able to quote a
      // scanned referral — and nothing in the chain has to change for it.
      await requestSummary('request-summary', 'documents-indexed');

      return {
        patientId,
        documents: documents.length,
        ...totals,
        ocrUnavailable: getOcrUnavailableReason() ?? null,
      };
    } catch (err) {
      await step
        .run('record-failure', () =>
          failTask(medplum, taskId, classify(err), err instanceof Error ? err.message : String(err))
        )
        .catch(() => undefined);
      // Asked for even here. Reached only once a step has exhausted its
      // retries, so indexing really is over for this run — but a dead pgvector
      // connection or a Textract outage says nothing about whether the chart is
      // summarisable, and it is read from Medplum, not from this index. A RAG
      // failure costing the patient their summary as well would be one outage
      // doing double damage.
      await requestSummary('request-summary-failed', 'index-failed');
      throw err;
    }
  }
);

/**
 * Ingest one slice of documents, sequentially.
 *
 * Sequential on purpose. Each document already fans out internally — four
 * Textract calls and eight Bedrock calls at a time — so running four documents
 * concurrently would put 16 Textract and 32 Bedrock calls in flight and draw
 * throttling that reads as a model failure. The parallelism is inside a
 * document, not across them.
 * @param props - Slice inputs.
 * @param props.medplum - The worker's admin client.
 * @param props.organizationId - The tenant written onto every chunk.
 * @param props.patientId - The patient.
 * @param props.batch - The documents in this slice.
 * @returns Per-status counts for the slice.
 */
async function ingestSlice(props: {
  medplum: Awaited<ReturnType<typeof getMedplum>>;
  organizationId: string;
  patientId: string;
  batch: PatientDocument[];
}): Promise<SliceTotals> {
  const totals: SliceTotals = { indexed: 0, skipped: 0, failed: 0, chunks: 0, reasons: {} };
  for (const document of props.batch) {
    const result = await ingestDocument({
      medplum: props.medplum,
      organizationId: props.organizationId,
      patientId: props.patientId,
      document,
    });
    totals[result.status]++;
    totals.chunks += result.chunkCount;
    if (result.reasonCode) {
      const key = `${result.status}:${result.reasonCode}`;
      totals.reasons[key] = (totals.reasons[key] ?? 0) + 1;
    }
    if (result.pageErrors) {
      totals.reasons['indexed:pages-lost'] = (totals.reasons['indexed:pages-lost'] ?? 0) + 1;
    }
  }
  return totals;
}
