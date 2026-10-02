// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * DrChrono's half of the inbound contract.
 *
 * THE CONTRACT, AS DRCHRONO ACTUALLY IMPLEMENTS IT
 * ------------------------------------------------
 * Read off the live documentation at
 * `https://app.drchrono.com/api-docs/#section/Webhooks` on 2026-10-02, because
 * lyfe-provider-ui was written against a different one and nobody noticed:
 *
 * - `X-drchrono-signature` **is the secret token itself**, sent verbatim. The
 *   docs call it "Secret token associated with this webhook". It is not an HMAC
 *   of anything. lyfe-provider-ui computed `HMAC-SHA256(secret, rawBody)` and
 *   compared that, which can never equal the token, so every signed delivery
 *   failed the check. (It survived because an unsigned delivery took a "this is
 *   probably a verification ping" branch that answered 200.)
 * - The event name is in the **`X-drchrono-event` header**, not the body.
 *   lyfe-provider-ui read `payload.event`, which does not exist.
 * - `X-drchrono-delivery` is the delivery id.
 * - The body is `{ practice_group_id, object, receiver }` — the practice that
 *   generated the event, the affected object serialised exactly as the REST API
 *   would return it, and the webhook's own JSON. Confirmed against live
 *   deliveries in the API console; the published docs describe only the last
 *   two, and `practice_group_id` is the one the tenant check rests on.
 *   lyfe-provider-ui expected `{ event, data, timestamp }`.
 * - **There is no timestamp anywhere.** Not in the headers, not in the body.
 *   lyfe-provider-ui's 300-second staleness window therefore never rejected
 *   anything, because its check passed unconditionally when the field was
 *   absent — and it was always absent. No replay window is implemented here:
 *   an honest absence of protection beats a check that cannot fire. Replay
 *   safety comes from the delivery id instead, which is real.
 * - A failed delivery is retried **three times — at +1h, +3h and +7h** after
 *   the original event — and then only by hand from the console. Only the
 *   status code is looked at; any 2xx is success and everything else, including
 *   a 302, is failure. That retry budget is why a misconfiguration here answers
 *   5xx rather than 200: three automatic retries over seven hours is enough
 *   time for someone to fix a missing setting, and a 200 would burn the event.
 *
 * Verification is a separate, GET-based handshake; see {@link challenge}.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * There is no routing here, no tenant lookup, no Medplum call and no Inngest
 * send. Everything above is a pure function of (headers, body, secret). That is
 * what makes this an adapter rather than the DrChrono-shaped hole the legacy
 * design had.
 */
import { createHmac } from 'node:crypto';
import type { AdapterContext, ChallengeResponse, InboundAdapter, InboundIntent, InboundRequest } from '../contract.ts';
import { constantTimeEquals, header } from '../contract.ts';

/** Header carrying the secret token verbatim. */
export const SIGNATURE_HEADER = 'x-drchrono-signature';

/** Header carrying the event name, or `PING`. */
export const EVENT_HEADER = 'x-drchrono-event';

/** Header carrying this delivery's id. */
export const DELIVERY_HEADER = 'x-drchrono-delivery';

/**
 * Longest challenge string this endpoint will sign.
 *
 * The GET handshake is an HMAC oracle under the clinic's webhook secret: send
 * `msg`, get `HMAC-SHA256(secret, msg)` back, and it answers before any delivery
 * has been authenticated because that is the whole point of it. Under
 * DrChrono's real contract that oracle buys an attacker nothing for forging a
 * delivery — a delivery is authenticated with the raw secret, not an HMAC — but
 * a general-purpose signing service bound to a clinic's secret is not a thing to
 * leave lying around, and a secret reused anywhere else would make it one. The
 * cap, and the structural-character check below, keep it to echoing short
 * opaque nonces, which is all DrChrono ever sends. Carried over from
 * lyfe-provider-ui, which got this part right.
 */
const MAX_CHALLENGE_LENGTH = 256;

/** Characters that would let a challenge be a JSON document. */
const JSON_STRUCTURAL = /[{}[\]"]/;

/**
 * Events that mean "this patient's chart has changed", and where the patient id is.
 *
 * A map rather than the legacy's `startsWith('PATIENT_')` prefix matching, which
 * silently sorted `PATIENT_FLAG_CMODIFY` — DrChrono's own typo, which the
 * console spells `PATIENT_FLAG_MODIFY` — into the wrong handler and then into
 * the wrong `switch` default. Both spellings are listed here because DrChrono's
 * documentation and its console disagree, and whichever it actually sends has
 * to work.
 *
 * The value names the field on `object` that holds the DrChrono patient id.
 * `PATIENT_CREATE` and `PATIENT_MODIFY` carry the patient itself, so the id is
 * `id`; everything else references it as `patient`.
 */
const CHART_EVENTS: Readonly<Record<string, 'id' | 'patient'>> = {
  PATIENT_CREATE: 'id',
  PATIENT_MODIFY: 'id',
  PATIENT_ALLERGY_CREATE: 'patient',
  PATIENT_ALLERGY_MODIFY: 'patient',
  PATIENT_PROBLEM_CREATE: 'patient',
  PATIENT_PROBLEM_MODIFY: 'patient',
  PATIENT_MEDICATION_CREATE: 'patient',
  PATIENT_MEDICATION_MODIFY: 'patient',
  PATIENT_FLAG_CREATE: 'patient',
  PATIENT_FLAG_MODIFY: 'patient',
  PATIENT_FLAG_CMODIFY: 'patient',
  APPOINTMENT_CREATE: 'patient',
  APPOINTMENT_MODIFY: 'patient',
  APPOINTMENT_DELETE: 'patient',
  CLINICAL_NOTE_LOCK: 'patient',
  CLINICAL_NOTE_UNLOCK: 'patient',
  LAB_ORDER_CREATE: 'patient',
  LAB_ORDER_MODIFY: 'patient',
  LAB_ORDER_DELETE: 'patient',
  VACCINE_ADMINISTERED: 'patient',
};

/**
 * Events DrChrono sends that have no bearing on the chart Lyfe keeps.
 *
 * Listed explicitly, with a reason, rather than falling through to "unknown".
 * The LYFE-AI webhook has all 27 events ticked, so most deliveries will land
 * here, and a known-and-deliberately-dropped event must be distinguishable in
 * the logs from one this adapter has never heard of.
 */
const IGNORED_EVENTS: Readonly<Record<string, string>> = {
  PING: 'verification ping',
  LINE_ITEM_CREATE: 'billing: Lyfe does not import line items',
  LINE_ITEM_MODIFY: 'billing: Lyfe does not import line items',
  LINE_ITEM_DELETE: 'billing: Lyfe does not import line items',
  LINE_ITEM_TRANSACTION_DELETE: 'billing: Lyfe does not import line items',
  CASH_PAYMENT_DELETE: 'billing: Lyfe does not import payments',
  TASK_CREATE: 'DrChrono practice tasks are not Lyfe import Tasks',
  TASK_MODIFY: 'DrChrono practice tasks are not Lyfe import Tasks',
  TASK_DELETE: 'DrChrono practice tasks are not Lyfe import Tasks',
};

/**
 * Answer DrChrono's "prove you own this URL" handshake.
 *
 * DrChrono sends a **GET** to the callback URL with a `msg` query parameter and
 * expects `200` with `{"secret_token": HMAC_SHA256(secret, msg).hexdigest()}`.
 * This happens when the webhook is first created and again whenever the
 * callback URL changes, and it is a different mechanism from the `PING` event,
 * which is a POST and carries a real signature.
 *
 * Note the direction: here the secret is the HMAC *key* and the challenge is the
 * message. That is the opposite of what lyfe-provider-ui did for deliveries, and
 * it is the only place in DrChrono's design where an HMAC appears at all.
 * @param props - The request and the clinic's secret.
 * @param props.request - The inbound GET.
 * @param props.secret - The clinic's webhook secret.
 * @returns The reply.
 */
function challenge(props: { request: InboundRequest; secret: string }): ChallengeResponse {
  const msg = props.request.query.get('msg');
  if (msg === null) {
    return { status: 400, body: { error: 'Missing msg parameter' } };
  }
  if (!isSignableChallenge(msg)) {
    return { status: 400, body: { error: 'Challenge rejected' } };
  }
  return {
    status: 200,
    body: { secret_token: createHmac('sha256', props.secret).update(msg).digest('hex') },
  };
}

/**
 * Decide whether a string is safe to sign. See {@link MAX_CHALLENGE_LENGTH}.
 * @param msg - The challenge DrChrono sent.
 * @returns True when it is a short, opaque, structureless token.
 */
export function isSignableChallenge(msg: string): boolean {
  if (msg.length === 0 || msg.length > MAX_CHALLENGE_LENGTH) {
    return false;
  }
  if (JSON_STRUCTURAL.test(msg)) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(msg);
}

/**
 * Pull a DrChrono patient id out of an event's object.
 *
 * DrChrono returns an id as a number in one place and a string in another, so
 * both are accepted and normalised — the same `refKey` lesson the importer
 * records. Anything else, including `null` and the empty string, is "not
 * present", which the caller turns into an explicit `ignore`.
 * @param object - The event's `object` payload.
 * @param field - Which field holds the patient id.
 * @returns The id as a string, or undefined.
 */
function patientId(object: unknown, field: 'id' | 'patient'): string | undefined {
  if (typeof object !== 'object' || object === null) {
    return undefined;
  }
  const value = (object as Record<string, unknown>)[field];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The DrChrono adapter. */
export const drchronoAdapter: InboundAdapter = {
  id: 'drchrono',
  name: 'DrChrono',
  secretField: 'webhookSecret',

  challenge,

  verify(props: { request: InboundRequest; secret: string }): boolean {
    const supplied = header(props.request.headers, SIGNATURE_HEADER);
    if (!supplied) {
      return false;
    }
    // The header IS the secret. Not a digest of it, not a digest of the body.
    // See the contract note at the top of this file.
    return constantTimeEquals(supplied, props.secret);
  },

  deliveryId(props: { request: InboundRequest }): string | undefined {
    return header(props.request.headers, DELIVERY_HEADER);
  },

  eventName(props: { request: InboundRequest }): string | undefined {
    return header(props.request.headers, EVENT_HEADER);
  },

  tenantClaim(props: { body: unknown }): string | undefined {
    // `practice_group_id` is on every delivery, alongside `object` and
    // `receiver` — confirmed against live deliveries in the DrChrono console,
    // where this practice sends 222. It arrives as a JSON number, and is
    // stringified here because the configured value is stored as text; a
    // numeric compare would make "222" and 222 different answers to the same
    // question.
    const value = (props.body as { practice_group_id?: unknown } | null)?.practice_group_id;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  },

  toIntents(props: { eventName: string; body: unknown; context: AdapterContext }): InboundIntent[] {
    const { eventName, body, context } = props;

    const ignored = IGNORED_EVENTS[eventName];
    if (ignored) {
      return [{ kind: 'ignore', reason: ignored }];
    }

    const field = CHART_EVENTS[eventName];
    if (!field) {
      return [
        {
          kind: 'unknown',
          reason: `DrChrono sent ${eventName}, which this adapter does not map`,
        },
      ];
    }

    // The clinic's own allow-list is applied here rather than in the receiver,
    // because only this adapter knows what a DrChrono event name looks like.
    // Checked after the event is recognised so that "you have this switched
    // off" never masquerades as "we have never heard of this".
    if (context.subscribedEvents && !context.subscribedEvents.includes(eventName)) {
      return [{ kind: 'ignore', reason: `${eventName} is not in this clinic's webhookEvents list` }];
    }

    const object = (body as { object?: unknown } | null)?.object;
    const id = patientId(object, field);
    if (!id) {
      // Acknowledged rather than retried: DrChrono will send the identical body
      // three more times and it will be just as unusable. Reported so it is
      // visible if a whole event type turns out to be shaped differently.
      return [{ kind: 'ignore', reason: `${eventName} carried no usable patient id in object.${field}` }];
    }

    // Every chart event means the same thing: this patient's DrChrono record
    // moved, so re-pull it. The importer is a conditional PUT by business
    // identifier from end to end, so re-pulling converges rather than
    // duplicating — which is what lets one intent serve twenty event types.
    return [{ kind: 'chart.import', externalPatientId: id }];
  },
};
