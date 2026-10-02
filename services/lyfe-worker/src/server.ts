// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { serve } from 'inngest/node';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { chartImport } from './functions/chart-import.ts';
import { patientSummary } from './functions/patient-summary.ts';
import { ragIndex } from './functions/rag-index.ts';
import { zusImport } from './functions/zus-import.ts';
import { inngest } from './inngest.ts';
import { getMedplum } from './medplum.ts';
import { handleRagIngest, handleRagSearch, handleRagStatus } from './rag-http.ts';
import { isRagConfigured } from './rag/db.ts';
import { handleResync, RESYNC_SOURCES } from './resync.ts';
import { handleBulkImport } from './trigger.ts';

/**
 * The worker's HTTP endpoint.
 *
 * Inngest invokes functions by calling this, which is what makes the execution
 * horizontal: run more of these and more patients import at once, without
 * anything inside Medplum having to grow.
 */
const PORT = Number(process.env.PORT ?? 3020);

// Every link of the import chain is registered here, and a link that is not
// registered is a link that silently never runs: Inngest delivers an event only
// to the functions this endpoint declares, so a missing entry looks exactly
// like an event nobody sent.
const handler = serve({ client: inngest, functions: [chartImport, zusImport, ragIndex, patientSummary] });

/** Browser origins allowed to start a run. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3001').split(',').map((o) => o.trim());

// Logged in at startup rather than on the first request. Lazily, a request
// arriving during a cold start races the login and surfaces as a 500 rather
// than as the 401 or 202 it should be.
let ready = false;
let startupError: string | undefined;
getMedplum()
  .then(() => {
    ready = true;
    console.log('lyfe-worker connected to Medplum');
    return undefined;
  })
  .catch((err: unknown) => {
    startupError = err instanceof Error ? err.message : String(err);
    console.error('lyfe-worker could not reach Medplum:', startupError);
  });

createServer((req, res) => {
  // The app is served from a different origin to this worker, so the browser
  // preflights. Allowlisted rather than `*`, because this endpoint starts real
  // work against real patient data.
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url?.startsWith('/api/inngest')) {
    handler(req, res);
    return;
  }
  if (req.url === '/api/imports/bulk' && req.method === 'POST') {
    route(res, handleBulkImport(req, res));
    return;
  }
  // Re-pull one patient from one configured source. Same trust boundary as the
  // bulk endpoint, and it sends the same event the import chain does.
  if (req.url === '/api/imports/resync' && req.method === 'POST') {
    route(res, handleResync(req, res));
    return;
  }
  // Document RAG. Every one of these authenticates the caller's own Medplum
  // token and resolves their organization server-side; see `rag-http.ts`.
  if (req.url === '/api/rag/ingest' && req.method === 'POST') {
    route(res, handleRagIngest(req, res));
    return;
  }
  if (req.url === '/api/rag/search' && req.method === 'POST') {
    route(res, handleRagSearch(req, res));
    return;
  }
  if (req.url === '/api/rag/status' && req.method === 'POST') {
    route(res, handleRagStatus(req, res));
    return;
  }
  if (req.url === '/health') {
    // Reports ready only once Medplum login has succeeded. A health check that
    // passes while the client is still logging in lets a deploy go green and
    // then fail the first real request, which is a confusing way to find out.
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: ready,
        medplum: ready ? 'connected' : (startupError ?? 'connecting'),
        functions: ['drchrono-chart-import', 'zus-record-import', 'rag-document-index', 'patient-ai-summary'],
        // Reported rather than inferred. RAG is optional — the worker runs the
        // imports fine without it — so "the search endpoint 503s" needs a way
        // to be told apart from "the worker is down".
        rag: isRagConfigured() ? 'configured' : 'RAG_DATABASE_URL unset',
        // Which sources this worker will re-pull a patient from. Reported
        // rather than duplicated in the app, so adding a source is a registry
        // entry here and not also a front-end release.
        resyncSources: Object.values(RESYNC_SOURCES).map((s) => ({ id: s.id, label: s.label })),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`lyfe-worker listening on http://localhost:${PORT}/api/inngest`);
});

/**
 * Send a handler's rejection as a 500 rather than an unhandled rejection.
 *
 * Each handler already catches its own errors and replies; this is the net
 * under that, for a throw before the try block is entered. Without it a
 * rejected promise here takes the process down and with it the imports.
 * @param res - The response.
 * @param work - The handler's promise.
 */
function route(res: ServerResponse, work: Promise<void>): void {
  work.catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });
}
