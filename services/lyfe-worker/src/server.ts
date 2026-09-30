// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { serve } from 'inngest/node';
import { createServer } from 'node:http';
import { chartImport } from './functions/chart-import.ts';
import { zusImport } from './functions/zus-import.ts';
import { inngest } from './inngest.ts';

/**
 * The worker's HTTP endpoint.
 *
 * Inngest invokes functions by calling this, which is what makes the execution
 * horizontal: run more of these and more patients import at once, without
 * anything inside Medplum having to grow.
 */
const PORT = Number(process.env.PORT ?? 3020);

const handler = serve({ client: inngest, functions: [chartImport, zusImport] });

createServer((req, res) => {
  if (req.url?.startsWith('/api/inngest')) {
    handler(req, res);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, functions: ['drchrono-chart-import', 'zus-record-import'] }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`lyfe-worker listening on http://localhost:${PORT}/api/inngest`);
});
