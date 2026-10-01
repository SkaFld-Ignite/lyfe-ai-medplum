// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { serve } from 'inngest/node';
import { createServer } from 'node:http';
import { chartImport } from './functions/chart-import.ts';
import { zusImport } from './functions/zus-import.ts';
import { inngest } from './inngest.ts';
import { getMedplum } from './medplum.ts';
import { handleBulkImport } from './trigger.ts';

/**
 * The worker's HTTP endpoint.
 *
 * Inngest invokes functions by calling this, which is what makes the execution
 * horizontal: run more of these and more patients import at once, without
 * anything inside Medplum having to grow.
 */
const PORT = Number(process.env.PORT ?? 3020);

const handler = serve({ client: inngest, functions: [chartImport, zusImport] });

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
    handleBulkImport(req, res).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    });
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
        functions: ['drchrono-chart-import', 'zus-record-import'],
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`lyfe-worker listening on http://localhost:${PORT}/api/inngest`);
});
