// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The inbound receiver. One route for every provider, for every clinic.
 *
 *   GET  /api/webhooks/:provider/:organizationId   the provider's ownership handshake
 *   POST /api/webhooks/:provider/:organizationId   a delivery
 *
 * THE TENANT IS IN THE URL
 * ------------------------
 * Each clinic registers its own callback URL carrying its own organization id,
 * and the secret is looked up for *that* clinic and no other. lyfe-provider-ui
 * had one global endpoint and one global `DRCHRONO_WEBHOOK_SECRET` env var,
 * which meant every clinic shared a secret, the receiver could not tell whose
 * event it was holding, and per-org webhook secrets collected by the admin UI
 * were written to the database and never read.
 *
 * Putting the organization in the path is not a security decision — the path is
 * public — the secret is. It is a *routing* decision, and it is what makes
 * per-tenant secret isolation possible: clinic A's secret only ever authenticates
 * requests to clinic A's URL, so a leaked secret is one clinic's problem.
 *
 * VERIFICATION FAILS CLOSED
 * -------------------------
 * There is exactly one way past the signature check, and it is passing it. No
 * unsigned branch, no "this looks like a ping", no "the provider is probably
 * still verifying". lyfe-provider-ui had all three, and because its signature
 * algorithm was wrong in the first place, the unsigned branch was the only one
 * that ever returned 200 — every real event was answered `verified: true` and
 * dropped. A ping is just an event that happens to mean nothing, and it carries
 * a signature like any other.
 *
 * WHAT THE STATUS CODES MEAN TO THE PROVIDER
 * ------------------------------------------
 * Providers read the status code and nothing else. DrChrono retries non-2xx
 * three times (+1h, +3h, +7h) and then stops. So:
 *
 *   200  we own this event now — including "deliberately ignored" and
 *        "we have never heard of this", both of which retrying cannot improve
 *   401  not authentic. Never retried into working.
 *   400  authentic but unusable — no delivery id, no event name.
 *   404  nothing here: unknown provider, or a clinic with no such integration.
 *   5xx  our fault and possibly temporary. Retry, and please do.
 *
 * The one rule underneath all of that: never answer 200 for an event we failed
 * to take responsibility for. A 200 destroys the event.
 */
import type { MedplumClient } from '@medplum/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../trigger.ts';
import { getAdapter } from './adapters/index.ts';
import type { InboundRequest } from './contract.ts';
import { claimDelivery, releaseDelivery } from './delivery-claim.ts';
import { dispatchIntents } from './dispatch.ts';
import { loadTenantConfig, WebhookConfigError } from './tenant-config.ts';

/** URL prefix every inbound callback sits under. */
export const WEBHOOK_PATH_PREFIX = '/api/webhooks/';

/**
 * Cap on a delivery body.
 *
 * A webhook endpoint is unauthenticated until the signature is checked, and the
 * signature cannot be checked until the body has been read. So the body is read
 * first by definition, and an uncapped read is a free memory-exhaustion lever
 * for anyone who knows the URL. DrChrono's largest `object` is a chart row.
 */
const MAX_BODY_BYTES = 1_000_000;

/** A parsed callback URL. */
export interface WebhookRoute {
  /** The adapter id. */
  readonly provider: string;
  /** The clinic. */
  readonly organizationId: string;
  /** The query string. */
  readonly query: URLSearchParams;
}

/**
 * Parse `/api/webhooks/:provider/:organizationId`.
 *
 * Exported for its own test: the receiver's whole tenant isolation rests on this
 * returning the right organization or nothing at all, and a path parser that
 * accepts `/api/webhooks/drchrono/../../other` is a cross-tenant bug.
 * @param url - The request URL, path and query.
 * @returns The route, or undefined when the URL is not a webhook callback.
 */
export function parseWebhookUrl(url: string | undefined): WebhookRoute | undefined {
  if (!url?.startsWith(WEBHOOK_PATH_PREFIX)) {
    return undefined;
  }
  const [path, queryString] = url.split('?', 2);
  const segments = path.slice(WEBHOOK_PATH_PREFIX.length).split('/').filter(Boolean);
  if (segments.length !== 2) {
    return undefined;
  }
  const [provider, organizationId] = segments.map(decodeURIComponent);
  // Both are used to build a FHIR search; a segment that is not a plain id has
  // no legitimate caller and is rejected rather than escaped.
  if (!/^[A-Za-z0-9-]+$/.test(provider) || !/^[A-Za-z0-9-]+$/.test(organizationId)) {
    return undefined;
  }
  return { provider, organizationId, query: new URLSearchParams(queryString ?? '') };
}

/**
 * Read the body as bytes, without parsing it.
 *
 * `readJson` in `trigger.ts` parses as it reads, which is no use here: a
 * provider that signs the body signs the bytes it sent, and re-serialising a
 * parsed object does not reproduce them.
 * @param req - The request.
 * @returns The raw body as a string.
 */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new WebhookConfigError(413, 'Webhook body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Handle one inbound webhook request.
 * @param props - The request context.
 * @param props.req - The request.
 * @param props.res - The response.
 * @param props.route - The parsed callback URL.
 * @param props.medplum - The worker's own Medplum client.
 */
export async function handleWebhook(props: {
  req: IncomingMessage;
  res: ServerResponse;
  route: WebhookRoute;
  medplum: MedplumClient;
}): Promise<void> {
  const { req, res, route, medplum } = props;

  const adapter = getAdapter(route.provider);
  if (!adapter) {
    send(res, 404, { error: `No inbound adapter registered for "${route.provider}"` });
    return;
  }

  let rawBody: string;
  try {
    rawBody = req.method === 'POST' ? await readRawBody(req) : '';
  } catch (err) {
    const status = err instanceof WebhookConfigError ? err.status : 400;
    send(res, status, { error: err instanceof Error ? err.message : 'Could not read body' });
    return;
  }

  const request: InboundRequest = { headers: req.headers, rawBody, query: route.query };

  let config;
  try {
    config = await loadTenantConfig({ medplum, adapter, organizationId: route.organizationId });
  } catch (err) {
    if (err instanceof WebhookConfigError) {
      // Logged, because this is the class of failure nobody sees otherwise: the
      // provider's console shows a red delivery and nothing says why.
      console.warn(`[webhook] ${adapter.id}/${route.organizationId}: ${err.message}`);
      send(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }

  if (req.method === 'GET') {
    const reply = adapter.challenge?.({ request, secret: config.secret });
    if (!reply) {
      send(res, 405, { error: `${adapter.name} does not use a GET handshake` });
      return;
    }
    send(res, reply.status, reply.body);
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Everything above this line is routing. Nothing below it runs for a request
  // that is not provably from the provider.
  if (!adapter.verify({ request, secret: config.secret })) {
    console.warn(`[webhook] ${adapter.id}/${route.organizationId}: signature rejected`);
    send(res, 401, { error: 'Signature verification failed' });
    return;
  }

  const eventName = adapter.eventName({ request });
  if (!eventName) {
    send(res, 400, { error: `${adapter.name} delivery carried no event name` });
    return;
  }

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    send(res, 400, { error: 'Body is not valid JSON' });
    return;
  }

  const intents = adapter.toIntents({ eventName, body, context: { subscribedEvents: config.subscribedEvents } });

  for (const intent of intents) {
    if (intent.kind === 'unknown') {
      // Loud, and reported in the response, so a provider that adds an event
      // type shows up as a line in the log rather than as a quiet gap in the
      // chart. The legacy code mapped every unrecognised event onto
      // "ehr.sync.completed" and nobody could have known.
      console.warn(`[webhook] ${adapter.id}/${route.organizationId}: unmapped event ${eventName} — ${intent.reason}`);
    }
  }

  const actionable = intents.filter((intent) => intent.kind !== 'ignore' && intent.kind !== 'unknown');
  if (actionable.length === 0) {
    // No work, so no claim: a delivery id is only needed to stop work happening
    // twice. This is also what makes a missing delivery id survivable for a ping.
    send(res, 200, { accepted: false, event: eventName, intents: intents.map(describe) });
    return;
  }

  const deliveryId = adapter.deliveryId({ request });
  if (!deliveryId) {
    // Only reached for a delivery that would cause work. Without the provider's
    // own id there is no way to tell a retry from a new event, and importing a
    // chart twice per retry is not an acceptable default.
    send(res, 400, { error: `${adapter.name} delivery carried no delivery id` });
    return;
  }

  const claim = await claimDelivery({
    medplum,
    provider: adapter.id,
    organizationId: route.organizationId,
    deliveryId,
    eventName,
  });
  if (!claim.won) {
    send(res, 200, { accepted: false, duplicate: true, event: eventName, deliveryId });
    return;
  }

  try {
    const dispatched = await dispatchIntents({
      intents,
      organizationId: route.organizationId,
      requester: config.requester,
      deliveryId,
    });
    send(res, 200, { accepted: true, event: eventName, deliveryId, intents: dispatched });
  } catch (err) {
    // The claim guarded work that never started, so give it back. Otherwise the
    // provider's redelivery — the thing that exists to recover from exactly
    // this — would be discarded as a duplicate of nothing.
    await releaseDelivery({ medplum, id: claim.id });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhook] ${adapter.id}/${route.organizationId}: dispatch failed — ${message}`);
    send(res, 500, { error: 'Could not queue the work for this event' });
  }
}

/**
 * Describe an intent for the response body.
 * @param intent - The intent.
 * @param intent.kind - The intent kind.
 * @param intent.reason - Why, for the kinds that carry a reason.
 * @returns A loggable summary.
 */
function describe(intent: { kind: string; reason?: string }): { kind: string; reason?: string } {
  return intent.reason ? { kind: intent.kind, reason: intent.reason } : { kind: intent.kind };
}
