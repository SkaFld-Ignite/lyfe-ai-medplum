// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The contract every inbound provider implements.
 *
 * This file is the whole point of the inbound rewrite, so it is worth being
 * explicit about what it is reacting to. In lyfe-provider-ui the DrChrono and
 * Zus webhooks were not two instances of one idea, they were two unrelated
 * programs that happened to share a directory. Adding a third EHR there meant
 * editing routing, verification, a prefix-matching `if/else`, two `switch`
 * statements and a hardcoded name map — four files before any new code ran.
 *
 * Here, a provider is an {@link InboundAdapter}: a value. The receiver in
 * `receive.ts` knows nothing about DrChrono, Zus or anything else. It resolves
 * an adapter by id, asks it four questions, and turns the answers into events.
 * Adding a provider is writing one of these and adding one line to
 * `adapters/index.ts`.
 *
 * WHAT AN ADAPTER MAY NOT DO
 * --------------------------
 * An adapter never talks to Medplum, never sends an Inngest event, never reads
 * configuration and never decides which clinic a request belongs to. It is a
 * pure function of (headers, body, secret). That is not stylistic: the tenant
 * boundary is the one thing that must not be reimplemented per provider, so it
 * lives in exactly one place and adapters are structurally unable to touch it.
 */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/**
 * One inbound HTTP request, already read.
 *
 * `rawBody` is the bytes as they arrived, not a re-serialisation of the parsed
 * body. A provider that signs the body signs those bytes, and `JSON.parse`
 * followed by `JSON.stringify` does not reproduce them — key order, whitespace
 * and number formatting all drift. Nothing in this codebase had a raw-body read
 * before this, which is why one is defined here rather than reused.
 */
export interface InboundRequest {
  /** Lower-cased header names to values, as Node delivers them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The request body, exactly as received. Empty string for a GET. */
  readonly rawBody: string;
  /** The parsed query string. */
  readonly query: URLSearchParams;
}

/**
 * What the receiver should do about one delivered event.
 *
 * Provider-neutral on purpose. An adapter says "this means import that chart",
 * never "send `lyfe/chart.import.requested`" — the mapping from intent to
 * Inngest event is the pipeline's business and lives in one place, so a provider
 * cannot invent its own parallel chain the way the legacy Svix path did.
 *
 * `ignore` and `unknown` are deliberately different. `ignore` is the adapter
 * saying "I understand this event and there is nothing to do" — a ping, a
 * billing line item. `unknown` is the adapter saying "I have never heard of
 * this". The first is routine; the second is a provider that has added an event
 * since this adapter was written, and it gets logged and reported rather than
 * swallowed. The legacy code mapped every unrecognised DrChrono event to
 * `"ehr.sync.completed"` and lost the distinction entirely.
 */
export type InboundIntent =
  /** Pull this patient's chart from the provider. Keyed by the provider's own patient id. */
  | { readonly kind: 'chart.import'; readonly externalPatientId: string }
  /** Pull this patient's network record. Keyed by the Medplum patient id. */
  | { readonly kind: 'zus.import'; readonly medplumPatientId: string }
  /** Re-index this patient's documents. Keyed by the Medplum patient id. */
  | { readonly kind: 'rag.ingest'; readonly medplumPatientId: string }
  /** Understood, and nothing to do. */
  | { readonly kind: 'ignore'; readonly reason: string }
  /** Not understood. Acknowledged, logged loudly, never silently dropped. */
  | { readonly kind: 'unknown'; readonly reason: string };

/** The result of an adapter's verification handshake. */
export interface ChallengeResponse {
  /** HTTP status to reply with. */
  readonly status: number;
  /** JSON body to reply with. */
  readonly body: unknown;
}

/** What an adapter is told about the tenant, minus anything it must not see. */
export interface AdapterContext {
  /**
   * The provider event names this clinic has opted into, or undefined for all.
   *
   * Passed to {@link InboundAdapter.toIntents} rather than filtered by the
   * receiver, because only the adapter knows what its event names look like.
   */
  readonly subscribedEvents?: readonly string[];
}

/**
 * One provider's half of the inbound contract.
 *
 * Four questions, in the order the receiver asks them: is this request really
 * from you, which delivery is it, which event is it, and what should we do.
 */
export interface InboundAdapter {
  /**
   * Registry id, and the path segment clinics' callback URLs carry.
   *
   * Must match the integration key the clinic's credentials are stored under —
   * `drchrono`, `zus` — because that is how the receiver finds the secret.
   */
  readonly id: string;

  /** Human name, for logs and error messages. */
  readonly name: string;

  /**
   * The secret field in the clinic's credential record holding the webhook secret.
   *
   * Named rather than assumed so a provider that signs with its OAuth client
   * secret, or with a separate per-webhook token, can say so.
   */
  readonly secretField: string;

  /**
   * Answer the provider's ownership-of-URL handshake, if it has one.
   *
   * Called for `GET` only. Return `undefined` for a provider that does not do a
   * GET handshake, and the receiver answers 405.
   *
   * This runs *before* any delivery has ever been verified, so it is the one
   * place an adapter is handed the secret without a prior proof of identity.
   * It must therefore only ever echo a challenge — never reveal the secret, and
   * never sign something an attacker chose freely.
   * @param props - The request and the clinic's secret.
   * @param props.request - The inbound GET.
   * @param props.secret - The clinic's webhook secret.
   * @returns The reply, or undefined when this provider has no GET handshake.
   */
  challenge?(props: { request: InboundRequest; secret: string }): ChallengeResponse | undefined;

  /**
   * Decide whether a delivery really came from the provider.
   *
   * Fails closed by contract: the receiver treats anything but `true` as a
   * rejection and replies 401 without looking at the body. There is no
   * "unsigned requests are probably pings" branch, which is what lyfe-provider-ui
   * had and what turns a signature check into decoration.
   * @param props - The request and the clinic's secret.
   * @param props.request - The inbound POST.
   * @param props.secret - The clinic's webhook secret.
   * @returns True only if the request is authentic.
   */
  verify(props: { request: InboundRequest; secret: string }): boolean;

  /**
   * The provider's own id for this delivery.
   *
   * This is the idempotency key, and it has to be the provider's, not ours: a
   * redelivery of the same event is byte-identical in every other respect, so a
   * hash of the payload cannot tell "sent again" from "happened again". The
   * legacy Zus path hashed the payload and the legacy DrChrono path did not
   * dedup at all.
   * @param props - The request.
   * @param props.request - The inbound POST.
   * @returns The delivery id, or undefined when the provider did not send one.
   */
  deliveryId(props: { request: InboundRequest }): string | undefined;

  /**
   * The provider's own id for the tenant this event came from, if it sends one.
   *
   * A second, independent answer to "whose event is this?", and the only one the
   * provider itself asserts. The organization in the URL was chosen by whoever
   * configured the webhook, and the signature proves only that the sender knows
   * a secret. If someone onboarding a second clinic copies *both* the callback
   * URL and the token from the first, every delivery verifies cleanly and one
   * clinic's patients import into the other's chart. Nothing else in the request
   * can catch that; this can.
   *
   * Optional, because not every provider sends one. An adapter that returns
   * undefined leaves the check unperformed rather than failing it.
   *
   * Reads the parsed body rather than the raw bytes: this is only ever consulted
   * after {@link InboundAdapter.verify} has passed, so the body is already known
   * to be the provider's own.
   * @param props - The delivery.
   * @param props.body - The parsed JSON body.
   * @returns The provider's tenant id, or undefined when it sends none.
   */
  tenantClaim?(props: { body: unknown }): string | undefined;

  /**
   * The provider's own name for this event.
   * @param props - The request.
   * @param props.request - The inbound POST.
   * @returns The event name, or undefined when the provider did not send one.
   */
  eventName(props: { request: InboundRequest }): string | undefined;

  /**
   * Turn one delivered event into what the pipeline should do about it.
   *
   * Returns a list because one provider event can legitimately mean two things.
   * An empty list is not allowed — say `ignore` and give a reason, so a
   * disappearing event is a decision in the log rather than an absence.
   * @param props - The event.
   * @param props.eventName - The provider's event name.
   * @param props.body - The parsed JSON body.
   * @param props.context - Per-tenant settings the adapter is allowed to see.
   * @returns One or more intents.
   */
  toIntents(props: { eventName: string; body: unknown; context: AdapterContext }): InboundIntent[];
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * The same shape as `statesMatch` in `bots/shared/drchrono-oauth.ts`, which is
 * the existing precedent in this codebase; restated here rather than imported
 * because the webhook core must not depend on a module named after one
 * provider. Length is compared first and non-constant-time on purpose —
 * `timingSafeEqual` throws on a length mismatch, and the length of a secret is
 * not the secret.
 * @param a - One value.
 * @param b - The other.
 * @returns True when the two are equal and non-empty.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Read a header as a single string.
 * @param headers - The request headers.
 * @param name - Lower-cased header name.
 * @returns The value, or undefined when absent or empty.
 */
export function header(headers: InboundRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.length > 0 ? single : undefined;
}
