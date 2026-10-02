// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CITATION_LIMITS,
  DOCUMENT_EXCERPT_CHARS,
} from '../../../../examples/medplum-provider/bots/shared/ai-summary-prompt.ts';

/**
 * The import chain: chart → documents indexed → AI summary, with nobody
 * clicking anything.
 *
 * One file rather than four, and against the repo's usual module-per-test-file
 * rule, because the thing under test is not any one function — it is the
 * wiring *between* them. Every property here spans at least two functions
 * ("the chart import's completion is the indexer's trigger"), and `vi.mock` is
 * per-file, so splitting it would mean four copies of one module graph's worth
 * of stubs and no single place that states the chain.
 *
 * ## What is asserted, and what cannot be
 *
 * Each link is asserted as **the event that was sent**, not as a call into the
 * next stage, because that is genuinely how the link works: `step.sendEvent`
 * hands the work to Inngest and returns, which is what keeps a failure in one
 * stage from reaching back and failing the stage before it. So the tests read
 * "this run emitted this event with this payload", which is the contract.
 *
 * The one thing that **cannot** be unit-tested is the debounce actually
 * collapsing two requests into one run: that happens inside Inngest, between
 * the event being accepted and the function being invoked, and no amount of
 * local stubbing reaches it. What is testable, and tested, is the two halves
 * that make it work — that the function declares a debounce keyed on the
 * patient, and that both index completions for one patient emit events carrying
 * the *same* patient id, so they land in the same debounce key. See
 * `describe('the summary is debounced per patient')`.
 *
 * No part of this chain has been run live. The RAG index lives on a
 * Railway-internal Postgres host that does not resolve from a developer
 * machine, so there is no end-to-end run behind these assertions.
 */

// Set before anything imports `bot-event.ts`, which reads it when building the
// event for a bot. The summary function goes through the real `botEvent` rather
// than a stub of it, so that the test would catch the chain being wired with a
// requester the bot cannot resolve a clinic from.
process.env.LYFE_CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key';

/** An Inngest function definition, as `createFunction` was handed it. */
interface CapturedFunction {
  config: {
    id: string;
    retries?: number;
    debounce?: { key?: string; period: string; timeout?: string };
    concurrency?: { key: string; limit: number } | { key: string; limit: number }[];
  };
  trigger: { event: string };
  handler: (ctx: unknown) => Promise<unknown>;
}

/** Every function this file's imports registered, by id. */
const registered: Record<string, CapturedFunction> = {};

vi.mock('../inngest.ts', () => ({
  // `createFunction` is replaced by a recorder. The real one builds an object
  // only the Inngest runtime can invoke; this keeps the three arguments so the
  // handler can be driven directly and the config can be asserted on, which is
  // the only way to check a declaration like `debounce` that is never executed
  // in-process.
  inngest: {
    createFunction: (
      config: CapturedFunction['config'],
      trigger: CapturedFunction['trigger'],
      handler: CapturedFunction['handler']
    ) => {
      registered[config.id] = { config, trigger, handler };
      return { config, trigger, handler };
    },
    send: vi.fn(),
  },
  PER_CLINIC_CONCURRENCY: 5,
}));

const medplum = { readResource: vi.fn(), searchResources: vi.fn() };
vi.mock('../medplum.ts', () => ({
  getMedplum: async () => medplum,
  requiredEnv: () => 'https://medplum.example.com/',
}));

const startTask = vi.fn(async () => ({ resourceType: 'Task', id: 'task-1' }));
const completeTask = vi.fn(async () => undefined);
const failTask = vi.fn(async () => undefined);
const setPhase = vi.fn(async () => undefined);
const attachPatient = vi.fn(async () => undefined);
vi.mock('../task.ts', () => ({
  startTask: (...args: unknown[]) => startTask(...(args as [])),
  completeTask: (...args: unknown[]) => completeTask(...(args as [])),
  failTask: (...args: unknown[]) => failTask(...(args as [])),
  setPhase: (...args: unknown[]) => setPhase(...(args as [])),
  attachPatient: (...args: unknown[]) => attachPatient(...(args as [])),
}));

const drchronoHandler = vi.fn();
vi.mock('../../../../examples/medplum-provider/bots/drchrono-import.ts', () => ({
  handler: (...args: unknown[]) => drchronoHandler(...args),
}));

const zusHandler = vi.fn();
vi.mock('../../../../examples/medplum-provider/bots/zus-import.ts', () => ({
  handler: (...args: unknown[]) => zusHandler(...args),
}));

const summaryHandler = vi.fn();
vi.mock('../../../../examples/medplum-provider/bots/patient-ai-summary.ts', () => ({
  handler: (...args: unknown[]) => summaryHandler(...args),
}));

vi.mock('../../../../examples/medplum-provider/bots/shared/progress.ts', () => ({
  openOrAdoptTask: async (props: { taskId?: string; create: () => Promise<{ id: string }> }) =>
    props.taskId ? { resourceType: 'Task', id: props.taskId } : props.create(),
}));

const isRagConfigured = vi.fn(() => true);
vi.mock('../rag/db.ts', () => ({ isRagConfigured: () => isRagConfigured() }));
vi.mock('../rag/schema.ts', () => ({ ensureRagSchema: async () => undefined }));

const listPatientDocuments = vi.fn();
const ingestDocument = vi.fn();
vi.mock('../rag/ingest.ts', () => ({
  listPatientDocuments: (...args: unknown[]) => listPatientDocuments(...args),
  ingestDocument: (...args: unknown[]) => ingestDocument(...args),
}));

vi.mock('../rag/ocr.ts', () => ({ getOcrUnavailableReason: () => undefined }));

const recentDocumentExcerpts = vi.fn();
vi.mock('../rag/retrieve.ts', () => ({
  recentDocumentExcerpts: (...args: unknown[]) => recentDocumentExcerpts(...args),
}));

// Imported for their side effect: each module registers its function with the
// recorder above. Nothing is read off the exports.
await import('./chart-import.ts');
await import('./zus-import.ts');
await import('./rag-index.ts');
await import('./patient-summary.ts');

/** An event this run handed to Inngest. */
interface SentEvent {
  /** The step id, which Inngest memoises on. */
  id: string;
  name: string;
  data: Record<string, unknown>;
}

/**
 * Drive one registered function and collect what it emitted.
 *
 * `step.run` simply calls its body: step memoisation is Inngest's and replaying
 * it here would test the stub. What matters is that the body ran, what it
 * returned, and which events the run sent.
 * @param id - The function id, e.g. `drchrono-chart-import`.
 * @param data - The triggering event's `data`.
 * @param options - Harness options.
 * @param options.sendFails - Make every `step.sendEvent` reject, as it would once
 *   Inngest's event API had exhausted the step's own retries.
 * @returns The handler's result, or the error it threw, plus the events sent.
 */
async function run(
  id: string,
  data: Record<string, unknown>,
  options: { sendFails?: boolean } = {}
): Promise<{ result?: unknown; error?: unknown; sent: SentEvent[]; stepOutput: unknown[] }> {
  const sent: SentEvent[] = [];
  // Everything Inngest would persist to memoise a step. Collected so the
  // "no clinical text in the event store" rule can actually be asserted
  // rather than only reasoned about.
  const stepOutput: unknown[] = [];
  const step = {
    run: async (_stepId: string, body: () => unknown) => {
      const output = await body();
      stepOutput.push(output);
      return output;
    },
    sendEvent: async (stepId: string, event: { name: string; data: Record<string, unknown> }) => {
      sent.push({ id: stepId, name: event.name, data: event.data });
      if (options.sendFails) {
        throw new Error('Inngest event API unreachable');
      }
    },
    sleep: async () => undefined,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  try {
    const result = await registered[id].handler({ event: { data }, step, runId: `run-${id}`, logger });
    return { result, sent, stepOutput };
  } catch (error) {
    return { error, sent, stepOutput };
  }
}

/**
 * Names of the events a run emitted, in order.
 * @param sent - What the run handed to Inngest.
 * @returns The event names.
 */
function names(sent: SentEvent[]): string[] {
  return sent.map((event) => event.name);
}

/**
 * The one event of a given name, asserting there is exactly one.
 *
 * The "exactly one" is the assertion that matters: a stage emitting the same
 * request twice would still satisfy every `toMatchObject` written against it.
 * @param sent - What the run handed to Inngest.
 * @param name - The event name to pick out.
 * @returns The single matching event.
 */
function only(sent: SentEvent[], name: string): SentEvent {
  const matches = sent.filter((event) => event.name === name);
  expect(matches).toHaveLength(1);
  return matches[0];
}

/**
 * Re-register the summary function under a given `SUMMARY_DEBOUNCE_PERIOD`.
 *
 * The debounce is read from the environment at module load, which is the only
 * moment it can be: `createFunction` is called once, at import. So reading it
 * back for a different value means re-importing the module — and then putting
 * the default registration back, so a test after this one drives the function
 * the worker actually ships rather than this one's variant.
 * @param period - The value to register with.
 * @returns That registration's config.
 */
async function summaryConfigWith(period: string): Promise<CapturedFunction['config']> {
  vi.resetModules();
  vi.stubEnv('SUMMARY_DEBOUNCE_PERIOD', period);
  const { patientSummary } = await import('./patient-summary.ts');
  const config = (patientSummary as unknown as CapturedFunction).config;
  vi.unstubAllEnvs();
  vi.resetModules();
  await import('./patient-summary.ts');
  return config;
}

const CHART_EVENT = {
  organizationId: 'clinic-1',
  requester: 'Practitioner/prac-1',
  drchronoPatientId: 'dc-99',
  batchId: 'batch-1',
};

const INDEX_EVENT = {
  organizationId: 'clinic-1',
  requester: 'Practitioner/prac-1',
  patientId: 'pat-1',
  batchId: 'batch-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  isRagConfigured.mockReturnValue(true);
  startTask.mockResolvedValue({ resourceType: 'Task', id: 'task-1' });
  drchronoHandler.mockResolvedValue({ ok: true, medplumPatientId: 'pat-1', counts: { Observation: 12 } });
  zusHandler.mockResolvedValue({ ok: true, counts: { DocumentReference: 4 } });
  summaryHandler.mockResolvedValue({ ok: true, mode: 'generate', compositionId: 'comp-1', status: 'final' });
  listPatientDocuments.mockResolvedValue([]);
  ingestDocument.mockResolvedValue({ status: 'indexed', chunkCount: 3 });
  recentDocumentExcerpts.mockResolvedValue([]);
  isRagConfigured.mockReturnValue(true);
});

describe('every link of the chain is registered and triggered by the link before it', () => {
  test('the four functions are wired end to end', () => {
    expect(registered['drchrono-chart-import'].trigger).toEqual({ event: 'lyfe/chart.import.requested' });
    expect(registered['zus-record-import'].trigger).toEqual({ event: 'lyfe/zus.import.requested' });
    expect(registered['rag-document-index'].trigger).toEqual({ event: 'lyfe/rag.ingest.requested' });
    expect(registered['patient-ai-summary'].trigger).toEqual({ event: 'lyfe/summary.generate.requested' });
  });
});

describe('a network pull is serialised per patient', () => {
  test('zus-record-import declares a per-patient concurrency limit of 1', () => {
    // The one race that can genuinely duplicate a chart. Every write is a
    // conditional update keyed on the Zus id, which the server resolves by
    // searching and then creating or updating — read-then-write. Two runs for
    // the same patient at the same moment can both search, both find nothing,
    // and both create.
    //
    // It stopped being hypothetical the moment a clinician got a button: two
    // clicks, or a manual sync arriving while the chart import's own pull is
    // still in flight, is exactly this. Nothing inside the bot can fix it,
    // because by the time the bot runs the race has already started.
    //
    // Asserted as configuration because that is what it is. The serialisation
    // happens inside Inngest, between the event being accepted and the
    // function being invoked, and no local stubbing reaches it.
    const concurrency = registered['zus-record-import'].config.concurrency;
    expect(Array.isArray(concurrency)).toBe(true);
    expect(concurrency).toEqual(expect.arrayContaining([{ key: 'event.data.medplumPatientId', limit: 1 }]));
  });

  test('the per-clinic limit is kept alongside it', () => {
    // Serialising per patient must not cost the per-clinic fairness that keeps
    // one clinic's backfill from starving the other four.
    expect(registered['zus-record-import'].config.concurrency).toEqual(
      expect.arrayContaining([{ key: 'event.data.organizationId', limit: 5 }])
    );
  });
});

describe('chart import completion fans out to indexing', () => {
  test('emits the index request alongside the Zus request', async () => {
    const { sent } = await run('drchrono-chart-import', CHART_EVENT);
    expect(names(sent)).toEqual(['lyfe/zus.import.requested', 'lyfe/rag.ingest.requested']);
    expect(only(sent, 'lyfe/rag.ingest.requested').data).toEqual({
      organizationId: 'clinic-1',
      requester: 'Practitioner/prac-1',
      // The *Medplum* patient the importer resolved, not the DrChrono id the
      // run was started with. Sending `dc-99` here would queue an index run
      // against a patient that does not exist and report zero documents.
      patientId: 'pat-1',
      batchId: 'batch-1',
    });
  });

  test('does not hand the indexer the chart import’s own Task', async () => {
    // `RagIngestRequested.taskId` makes the indexer adopt a caller's Task
    // instead of opening its own. Passing the chart import's Task would have
    // the index run re-close a finished import with document counts in place of
    // the chart's own counts — one run, two units of work, one row.
    const { sent } = await run('drchrono-chart-import', CHART_EVENT);
    expect(only(sent, 'lyfe/rag.ingest.requested').data).not.toHaveProperty('taskId');
  });

  test('a chart whose hand-off could not be sent is still a chart that imported', async () => {
    // The chart import is the expensive stage — two minutes of DrChrono work —
    // so having it reported as failed because the event bus was briefly
    // unreachable would send a provider to re-run an import that succeeded.
    // `completeTask` has already run; `failTask` will not undo it.
    const { error } = await run('drchrono-chart-import', CHART_EVENT, { sendFails: true });
    expect((error as Error).message).toMatch(/event API unreachable/);
    expect(completeTask).toHaveBeenCalled();
    expect(attachPatient).toHaveBeenCalledWith(expect.anything(), 'task-1', 'pat-1');
  });

  test('a chart that failed to import asks for nothing downstream', async () => {
    drchronoHandler.mockResolvedValue({ ok: false, error: 'DrChrono returned 500' });
    const { error, sent } = await run('drchrono-chart-import', CHART_EVENT);
    expect(error).toBeInstanceOf(Error);
    expect(sent).toEqual([]);
    expect(failTask).toHaveBeenCalled();
  });
});

describe('network import completion also triggers indexing', () => {
  const ZUS_EVENT = {
    organizationId: 'clinic-1',
    requester: 'Practitioner/prac-1',
    medplumPatientId: 'pat-1',
    batchId: 'batch-1',
  };

  test('emits the index request once the network record lands', async () => {
    const { sent } = await run('zus-record-import', ZUS_EVENT);
    expect(only(sent, 'lyfe/rag.ingest.requested').data).toEqual(INDEX_EVENT);
    expect(completeTask).toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
  });

  test('a refused pull is not a failure and asks for no re-index', async () => {
    // The office may simply not be enrolled with Zus. Nothing was written, so
    // there is nothing new to index — and the chart import already had this
    // patient's own documents indexed.
    zusHandler.mockResolvedValue({ ok: false, error: 'Patient is not eligible for Zus' });
    const { result, sent } = await run('zus-record-import', ZUS_EVENT);
    expect(result).toMatchObject({ skipped: true });
    expect(sent).toEqual([]);
    expect(completeTask).toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
  });

  test('a record the networks had nothing for asks for no re-index', async () => {
    // Successful, but zero resources written after the whole 30m/2h/6h ladder.
    // Re-extracting and re-embedding every document to discover that nothing
    // changed is paid for in Textract and Bedrock calls.
    zusHandler.mockResolvedValue({ ok: true, counts: {} });
    const { result, sent } = await run('zus-record-import', ZUS_EVENT);
    expect(result).toMatchObject({ empty: true });
    expect(names(sent)).toEqual([]);
    expect(failTask).not.toHaveBeenCalled();
  });
});

describe('indexing completion triggers the summary', () => {
  test('a patient with documents ends in a summary request', async () => {
    listPatientDocuments.mockResolvedValue([{ id: 'doc-1' }, { id: 'doc-2' }]);
    const { result, sent } = await run('rag-document-index', INDEX_EVENT);
    expect(result).toMatchObject({ documents: 2, indexed: 2, chunks: 6 });
    expect(only(sent, 'lyfe/summary.generate.requested').data).toEqual({
      organizationId: 'clinic-1',
      requester: 'Practitioner/prac-1',
      patientId: 'pat-1',
      reason: 'documents-indexed',
      batchId: 'batch-1',
    });
  });

  test('the index Task is closed before the summary is asked for', async () => {
    // Ordering matters for the claim that a summary failure cannot fail the
    // index run: by the time anything can go wrong with the model, the Task
    // this run is reported on is already `completed`.
    const order: string[] = [];
    completeTask.mockImplementation(async () => {
      order.push('complete-task');
    });
    listPatientDocuments.mockResolvedValue([{ id: 'doc-1' }]);
    const { sent } = await run('rag-document-index', INDEX_EVENT);
    order.push('summary-requested');
    expect(order).toEqual(['complete-task', 'summary-requested']);
    expect(names(sent)).toContain('lyfe/summary.generate.requested');
  });

  test('indexing that failed still asks for a summary', async () => {
    // A dead pgvector connection says nothing about whether the chart is
    // summarisable — the summary is read from Medplum, not from this index.
    // One outage must not cost the patient two things.
    listPatientDocuments.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const { error, sent } = await run('rag-document-index', INDEX_EVENT);
    expect(error).toBeInstanceOf(Error);
    expect(failTask).toHaveBeenCalled();
    expect(only(sent, 'lyfe/summary.generate.requested').data).toMatchObject({ reason: 'index-failed' });
  });

  test('an undelivered hand-off fails the run but only after the Task is closed', async () => {
    // `step.sendEvent` can fail, and when it does the error reaches the catch
    // block, so the run goes red and an operator can replay it — which is the
    // right outcome, because the hand-off really did not happen. What must not
    // follow is the index run being restated as failed: `completeTask` has
    // already run by this point, and `failTask` refuses to reopen a completed
    // Task (asserted in `task.test.ts`, where it is not a stub).
    listPatientDocuments.mockResolvedValue([{ id: 'doc-1' }]);
    const { error } = await run('rag-document-index', INDEX_EVENT, { sendFails: true });
    expect((error as Error).message).toMatch(/event API unreachable/);
    expect(completeTask).toHaveBeenCalled();
  });

  test('a worker with no index configured still asks for a summary', async () => {
    // RAG is an addition to this service, not a precondition for it. If the
    // summary hung off `RAG_DATABASE_URL`, a worker deployed without it would
    // silently produce no summaries for anybody.
    isRagConfigured.mockReturnValue(false);
    const { error, sent } = await run('rag-document-index', INDEX_EVENT);
    expect((error as Error).message).toMatch(/RAG_DATABASE_URL/);
    expect(only(sent, 'lyfe/summary.generate.requested').data).toMatchObject({ reason: 'index-unavailable' });
  });
});

describe('a patient with no documents is not a failure', () => {
  test('the run completes, reports zero, and still asks for a summary', async () => {
    listPatientDocuments.mockResolvedValue([]);
    const { result, sent } = await run('rag-document-index', INDEX_EVENT);
    expect(result).toEqual({ patientId: 'pat-1', documents: 0, indexed: 0, skipped: 0, failed: 0, chunks: 0 });
    // Completed, not failed. A new intake with no attachments is an ordinary
    // patient, and a red row on the Imports page for that is a lie.
    expect(completeTask).toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
    // Asked for anyway: the summary is written from structured FHIR —
    // conditions, medications, labs, encounters — and document excerpts are an
    // extra context block. Zero chunks is not zero chart.
    expect(only(sent, 'lyfe/summary.generate.requested').data).toMatchObject({ reason: 'no-documents' });
  });

  test('a document nobody can read is skipped, not failed', async () => {
    listPatientDocuments.mockResolvedValue([{ id: 'doc-1' }, { id: 'doc-2' }]);
    ingestDocument
      .mockResolvedValueOnce({ status: 'indexed', chunkCount: 4 })
      .mockResolvedValueOnce({ status: 'skipped', chunkCount: 0 });
    const { result } = await run('rag-document-index', INDEX_EVENT);
    expect(result).toMatchObject({ indexed: 1, skipped: 1, failed: 0, chunks: 4 });
    expect(completeTask).toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
  });
});

describe('the summary is debounced per patient', () => {
  test('the function declares a debounce keyed on the patient', () => {
    // The collapsing itself is Inngest's, between the event being accepted and
    // the function being invoked, so it cannot be observed from here. What can
    // be observed is the declaration that buys it — and a declaration with the
    // wrong key, or none, is exactly the regression this guards: the chain
    // would still work and would simply cost two model calls per patient,
    // which no behavioural test would notice.
    expect(registered['patient-ai-summary'].config.debounce).toEqual({
      key: 'event.data.patientId',
      period: '10m',
      timeout: '30m',
    });
  });

  test('both index completions for one patient share that key', () => {
    // The DrChrono-driven and network-driven index runs are separate runs with
    // separate Tasks, and each asks for a summary. They collapse only because
    // both carry the same `patientId` — which is what this asserts, since a
    // `patientId` that differed between the two (a DrChrono id on one side, a
    // Medplum id on the other) would put them in different debounce buckets and
    // produce two model calls that looked correct in every other respect.
    expect(registered['patient-ai-summary'].config.debounce?.key).toBe('event.data.patientId');
  });

  test('an operator can turn it off without a code change', async () => {
    // Inngest refuses a *registration* asking for more than the plan allows —
    // `inngest.ts` records the exact message for a concurrency of 20 against a
    // plan limit of 5 — and a refusal means these functions do not register,
    // which from outside looks identical to events nobody sent. There is no way
    // to ask Inngest at build time whether debouncing is available, so the
    // escape hatch is an environment variable: the chain keeps working and pays
    // two model calls per patient instead of one, which is a bill rather than
    // an outage.
    expect(await summaryConfigWith('off')).not.toHaveProperty('debounce');
  });

  test('an empty value is the default, not off', async () => {
    // `.env.example` ships the key with no value, so copying it must not
    // silently double every patient's model calls. Only the literal `off`
    // turns debouncing off.
    expect((await summaryConfigWith('')).debounce).toMatchObject({ period: '10m' });
  });

  test('a retuned window is passed through as given', async () => {
    expect((await summaryConfigWith('3m')).debounce).toEqual({
      key: 'event.data.patientId',
      period: '3m',
      timeout: '30m',
    });
  });

  test('two index runs for one patient emit the same debounce key value', async () => {
    listPatientDocuments.mockResolvedValue([{ id: 'doc-1' }]);
    const first = await run('rag-document-index', INDEX_EVENT);
    const second = await run('rag-document-index', INDEX_EVENT);
    const keyOf = (sent: SentEvent[]): unknown => only(sent, 'lyfe/summary.generate.requested').data.patientId;
    expect(keyOf(first.sent)).toBe('pat-1');
    expect(keyOf(second.sent)).toBe(keyOf(first.sent));
  });
});

describe('the summary run', () => {
  const SUMMARY_EVENT = {
    organizationId: 'clinic-1',
    requester: 'Practitioner/prac-1',
    patientId: 'pat-1',
    reason: 'documents-indexed',
  };

  test('generates through the bot handler and reports the Composition', async () => {
    const { result } = await run('patient-ai-summary', SUMMARY_EVENT);
    expect(result).toEqual({ patientId: 'pat-1', compositionId: 'comp-1', status: 'final', documents: 0 });
    expect(summaryHandler).toHaveBeenCalledOnce();
    const event = summaryHandler.mock.calls[0][1] as { requester: { reference: string }; input: unknown };
    // The requester travels all the way down: the bot resolves the clinic it
    // files the Composition under from it, not from `organizationId`.
    expect(event.requester).toEqual({ reference: 'Practitioner/prac-1' });
    expect(event.input).toEqual({ patientId: 'pat-1', mode: 'generate', documents: [] });
  });

  test('feeds the indexed documents into the summary as prompt context', async () => {
    // The payload, not just the plumbing. Without this the chain is correctly
    // ordered and carries nothing: the prompt's RECENT DOCUMENTS block renders
    // "None extracted yet" and index-then-summarise changes nothing the model
    // sees.
    recentDocumentExcerpts.mockResolvedValue([
      {
        documentId: 'doc-1',
        title: 'Nephrology consult',
        documentDate: '2026-07-02',
        excerpt: 'Impression: eGFR 38, progressive.',
      },
      { documentId: 'doc-2', title: null, documentDate: null, excerpt: 'Discharge summary text.' },
    ]);

    const { result } = await run('patient-ai-summary', SUMMARY_EVENT);
    const input = (summaryHandler.mock.calls[0][1] as { input: { documents: unknown[] } }).input;

    expect(input.documents).toEqual([
      {
        // A DocumentReference, because `buildCitationIndex` stores this as the
        // `Dn` citation target — a chunk id here would produce a citation chip
        // pointing at nothing a provider can open.
        reference: { reference: 'DocumentReference/doc-1' },
        title: 'Nephrology consult',
        date: '2026-07-02',
        excerpt: 'Impression: eGFR 38, progressive.',
      },
      {
        reference: { reference: 'DocumentReference/doc-2' },
        title: 'Untitled document',
        excerpt: 'Discharge summary text.',
      },
    ]);
    // Reported on the run, so "why does this summary not mention the referral
    // letter" has an answer without opening a database.
    expect(result).toMatchObject({ documents: 2 });
  });

  test('asks for exactly as many documents as the prompt will render', async () => {
    // The prompt module's own constants, passed in rather than re-stated here,
    // so the query cannot drift from what `buildChartPrompt` and
    // `buildCitationIndex` actually read.
    await run('patient-ai-summary', SUMMARY_EVENT);
    expect(recentDocumentExcerpts).toHaveBeenCalledWith(
      { organizationId: 'clinic-1', patientId: 'pat-1' },
      { limit: CITATION_LIMITS.documents, excerptChars: DOCUMENT_EXCERPT_CHARS }
    );
  });

  test('a patient with nothing indexed behaves exactly as before the seam', async () => {
    recentDocumentExcerpts.mockResolvedValue([]);
    const { result, error } = await run('patient-ai-summary', SUMMARY_EVENT);
    expect(error).toBeUndefined();
    const input = (summaryHandler.mock.calls[0][1] as { input: { documents: unknown[] } }).input;
    // Empty list, no error, summary still generated — the prompt renders
    // "None extracted yet" and the model is told to ignore the block.
    expect(input.documents).toEqual([]);
    expect(result).toMatchObject({ compositionId: 'comp-1', documents: 0 });
  });

  test('a worker with no index does not even query for context', async () => {
    // RAG is an addition to this service, not a precondition. The deployed
    // Medplum bot is in the same position by construction: it has no database,
    // passes no documents, and still writes a summary.
    isRagConfigured.mockReturnValue(false);
    const { result } = await run('patient-ai-summary', SUMMARY_EVENT);
    expect(recentDocumentExcerpts).not.toHaveBeenCalled();
    expect(result).toMatchObject({ compositionId: 'comp-1', documents: 0 });
  });

  test('an unreachable index costs the document block, not the summary', async () => {
    // Quality versus availability, decided towards availability: a summary
    // without its document block is worse than one with it, and far better
    // than none. The degradation is logged and the count is on the run.
    recentDocumentExcerpts.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const { result, error } = await run('patient-ai-summary', SUMMARY_EVENT);
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ compositionId: 'comp-1', documents: 0 });
  });

  test('the document text never becomes Inngest step output', async () => {
    // Inngest persists every step's return value to memoise it, so a
    // `step.run` that returned excerpts would write the text of clinical
    // documents into the event store — the thing `events.ts` says this worker
    // never does. The read happens inside the model step; what the step
    // returns is a Composition id.
    recentDocumentExcerpts.mockResolvedValue([
      { documentId: 'doc-1', title: 'Consult', documentDate: '2026-07-02', excerpt: 'SECRET CLINICAL TEXT' },
    ]);
    const { result, stepOutput } = await run('patient-ai-summary', SUMMARY_EVENT);
    // The excerpt did reach the model …
    const input = (summaryHandler.mock.calls[0][1] as { input: { documents: { excerpt: string }[] } }).input;
    expect(input.documents[0].excerpt).toBe('SECRET CLINICAL TEXT');
    // … and did not reach anything Inngest keeps.
    expect(JSON.stringify(stepOutput)).not.toContain('SECRET CLINICAL TEXT');
    expect(JSON.stringify(result)).not.toContain('SECRET CLINICAL TEXT');
  });

  test('opens no Task, so no import row is created or touched', async () => {
    // The summary's state is already a FHIR fact — the Composition exists or it
    // does not. A Task per summary would double the rows on the Imports page,
    // and a failed one of those rows reads as a failed import.
    await run('patient-ai-summary', SUMMARY_EVENT);
    expect(startTask).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
  });

  test('a project without the AI feature degrades to “no summary yet”', async () => {
    summaryHandler.mockResolvedValue({ ok: false, error: 'Project does not have the ai feature enabled' });
    const { result, error } = await run('patient-ai-summary', SUMMARY_EVENT);
    // Resolved, not thrown. A thousand red runs saying "this project has no AI
    // enabled" buries the failures worth looking at, and no retry adds a
    // feature flag.
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ patientId: 'pat-1', skipped: true });
    expect(failTask).not.toHaveBeenCalled();
  });

  test('a transient model failure is thrown so Inngest retries it', async () => {
    summaryHandler.mockResolvedValue({ ok: false, error: '502 Bad Gateway from the model proxy' });
    const { error } = await run('patient-ai-summary', SUMMARY_EVENT);
    expect((error as Error).message).toMatch(/502/);
    // Still no Task: the failure belongs to this run, and the import and index
    // Tasks it followed are already closed as successes.
    expect(failTask).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
  });

  test('a summary failure leaves the import and the index successful', async () => {
    // Stated as one test because it is the promise the whole design rests on.
    // The chart import and the index run each close their own Task and then
    // hand off by event; the summary is a separate run with no Task of its own,
    // so there is no path by which it can reopen or re-fail either of them.
    drchronoHandler.mockResolvedValue({ ok: true, medplumPatientId: 'pat-1', counts: { Observation: 12 } });
    const chart = await run('drchrono-chart-import', CHART_EVENT);
    expect(chart.result).toMatchObject({ patientId: 'pat-1' });
    expect(completeTask).toHaveBeenCalledTimes(1);

    listPatientDocuments.mockResolvedValue([{ id: 'doc-1' }]);
    const index = await run('rag-document-index', INDEX_EVENT);
    expect(index.result).toMatchObject({ indexed: 1 });
    expect(completeTask).toHaveBeenCalledTimes(2);

    summaryHandler.mockRejectedValue(new Error('the model proxy is unreachable'));
    const summary = await run('patient-ai-summary', SUMMARY_EVENT);
    expect(summary.error).toBeInstanceOf(Error);

    // Nothing was failed, and nothing was re-closed, by the summary blowing up.
    expect(failTask).not.toHaveBeenCalled();
    expect(completeTask).toHaveBeenCalledTimes(2);
  });
});
