// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { serve } from 'inngest/node';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { ProviderBrake } from '../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';
import { chartImport } from './functions/chart-import.ts';
import { onboardingDiscovery, onboardingDiscoverySchedule } from './functions/onboarding-discovery.ts';
import { patientSummary } from './functions/patient-summary.ts';
import { ragIndex } from './functions/rag-index.ts';
import { zusImport } from './functions/zus-import.ts';
import { inngest } from './inngest.ts';
import { getMedplum } from './medplum.ts';
import { installSharedBreakerStore } from './providers/breaker-store.ts';
import { openProviderBrakes } from './providers/hold.ts';
import { handleRagIngest, handleRagSearch, handleRagStatus } from './rag-http.ts';
import { isRagConfigured } from './rag/db.ts';
import { handleResync, RESYNC_SOURCES } from './resync.ts';
import { handleBulkImport } from './trigger.ts';
import { adapterIds } from './webhooks/adapters/index.ts';
import { handleWebhook, parseWebhookUrl } from './webhooks/receive.ts';

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
const handler = serve({
  client: inngest,
  functions: [chartImport, zusImport, ragIndex, patientSummary, onboardingDiscoverySchedule, onboardingDiscovery],
});

/** Browser origins allowed to start a run. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3001').split(',').map((o) => o.trim());

// Installed before anything can import, so the first 429 of the process already
// has somewhere shared to record itself. Returns false when RAG_DATABASE_URL is
// unset, in which case the bots keep their per-process fallback — weaker, but
// the imports do not otherwise need this database and refusing to boot without
// it would be a worse outage than a brake that forgets on restart.
const sharedBrakes = installSharedBreakerStore();

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
  // Inbound webhooks. One route for every provider and every clinic — the
  // provider and the organization are path segments, and which adapter serves
  // them comes from the registry, so a new EHR adds no line here. A prefix
  // match rather than an exact one, which is why it is tested on its own
  // rather than folded in with the exact-match routes; the paths do not overlap.
  const webhook = parseWebhookUrl(req.url);
  if (webhook) {
    // Deliberately unauthenticated at this layer: the provider has no Medplum
    // token and never will. The trust boundary is the per-clinic signature
    // check inside, which fails closed.
    route(
      res,
      (async () => handleWebhook({ req, res, route: webhook, medplum: await getMedplum() }))().catch((err: unknown) => {
        // A throw here means the worker could not reach Medplum, not that the
        // delivery was bad. 5xx so the provider retries it.
        console.error('[webhook] unhandled error:', err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal error' }));
        }
      })
    );
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
    // Awaited, so the reply carries the brakes rather than a promise. A breaker
    // that opens silently is a system that looks broken: thirteen charts went
    // quiet for twenty minutes and the only way to find out why was to read
    // Inngest. `/health` answering "drchrono is holding clinic abc until 14:05"
    // is the difference between a diagnosis and a guess.
    route(
      res,
      (async () => {
        const brakes = await openProviderBrakes().catch(() => []);
        health(res, brakes);
      })()
    );
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`lyfe-worker listening on http://localhost:${PORT}/api/inngest`);
});

/**
 * Write the health report.
 * @param res - The response.
 * @param brakes - Provider rate-limit brakes currently open.
 */
function health(res: ServerResponse, brakes: ProviderBrake[]): void {
  // Reports ready only once Medplum login has succeeded. A health check that
  // passes while the client is still logging in lets a deploy go green and
  // then fail the first real request, which is a confusing way to find out.
  res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: ready,
      medplum: ready ? 'connected' : (startupError ?? 'connecting'),
      functions: [
        'drchrono-chart-import',
        'zus-record-import',
        'rag-document-index',
        'patient-ai-summary',
        'onboarding-discovery-schedule',
        'onboarding-discovery',
      ],
      // Reported from the registry rather than written out, so "is this
      // provider deployed yet" has an answer that cannot drift from the code.
      inboundProviders: adapterIds(),
      // Reported rather than inferred. RAG is optional — the worker runs the
      // imports fine without it — so "the search endpoint 503s" needs a way
      // to be told apart from "the worker is down".
      rag: isRagConfigured() ? 'configured' : 'RAG_DATABASE_URL unset',
      // Which sources this worker will re-pull a patient from. Reported
      // rather than duplicated in the app, so adding a source is a registry
      // entry here and not also a front-end release.
      resyncSources: Object.values(RESYNC_SOURCES).map((s) => ({ id: s.id, label: s.label })),
      // Which providers are refusing which clinics, and until when. Empty is
      // the normal answer and is reported as empty rather than omitted, so the
      // absence of a brake is distinguishable from a worker too old to report
      // one.
      //
      // `shared` says whether those brakes are visible to the other worker
      // instances. False means every instance is braking alone, which is worth
      // knowing before concluding that the brake is not working.
      rateLimits: {
        shared: sharedBrakes,
        open: brakes.map((brake) => ({
          provider: brake.provider,
          organizationId: brake.organizationId,
          openUntil: brake.openUntil.toISOString(),
          secondsRemaining: Math.max(0, Math.round((brake.openUntil.getTime() - Date.now()) / 1000)),
          reason: brake.reason,
        })),
      },
    })
  );
}

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
