// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The adapter's event surface, pinned against the real one.
 *
 * `EVERY_EVENT` below is transcribed from the LYFE-AI application's webhook
 * settings in the DrChrono console on 2026-10-02, where all 27 are ticked. That
 * is the live subscription, so these are the events that will actually arrive —
 * and the point of the first test is that **none of them is a surprise**. An
 * event this adapter has never considered must show up here as a failure, not in
 * production as a warning nobody reads.
 */
import { describe, expect, test } from 'vitest';
import type { InboundRequest } from '../contract.ts';
import { drchronoAdapter, isSignableChallenge } from './drchrono.ts';

/** Every event the LYFE-AI webhook is subscribed to, plus the ping. */
const EVERY_EVENT = [
  'APPOINTMENT_CREATE',
  'APPOINTMENT_DELETE',
  'APPOINTMENT_MODIFY',
  'CASH_PAYMENT_DELETE',
  'CLINICAL_NOTE_LOCK',
  'CLINICAL_NOTE_UNLOCK',
  'LAB_ORDER_CREATE',
  'LAB_ORDER_DELETE',
  'LAB_ORDER_MODIFY',
  'LINE_ITEM_CREATE',
  'LINE_ITEM_DELETE',
  'LINE_ITEM_MODIFY',
  'LINE_ITEM_TRANSACTION_DELETE',
  'PATIENT_ALLERGY_CREATE',
  'PATIENT_ALLERGY_MODIFY',
  'PATIENT_CREATE',
  'PATIENT_FLAG_CREATE',
  'PATIENT_FLAG_MODIFY',
  'PATIENT_MEDICATION_CREATE',
  'PATIENT_MEDICATION_MODIFY',
  'PATIENT_MODIFY',
  'PATIENT_PROBLEM_CREATE',
  'PATIENT_PROBLEM_MODIFY',
  'TASK_CREATE',
  'TASK_DELETE',
  'TASK_MODIFY',
  'VACCINE_ADMINISTERED',
  'PING',
];

/**
 * Map one event with a body carrying both candidate id fields.
 * @param eventName - The DrChrono event name.
 * @returns The intents.
 */
function intentsFor(eventName: string): ReturnType<typeof drchronoAdapter.toIntents> {
  return drchronoAdapter.toIntents({
    eventName,
    body: { receiver: { id: 1 }, object: { id: 500, patient: 900 } },
    context: {},
  });
}

/**
 * Build a request with the given headers.
 * @param headers - Lower-cased headers.
 * @returns The request.
 */
function request(headers: Record<string, string>): InboundRequest {
  return { headers, rawBody: '{}', query: new URLSearchParams() };
}

describe('event coverage', () => {
  test('every subscribed event is a decision, never an unknown', () => {
    const surprises = EVERY_EVENT.filter((name) => intentsFor(name).some((intent) => intent.kind === 'unknown'));
    expect(surprises).toEqual([]);
  });

  test('clinical events import the patient they name', () => {
    // PATIENT_CREATE/MODIFY carry the patient itself, so the id is `object.id`.
    expect(intentsFor('PATIENT_MODIFY')).toEqual([{ kind: 'chart.import', externalPatientId: '500' }]);
    // Everything else references it as `object.patient`. Reading the wrong
    // field here would import a random patient whose id happened to collide
    // with an appointment's.
    expect(intentsFor('APPOINTMENT_CREATE')).toEqual([{ kind: 'chart.import', externalPatientId: '900' }]);
    expect(intentsFor('CLINICAL_NOTE_LOCK')).toEqual([{ kind: 'chart.import', externalPatientId: '900' }]);
    expect(intentsFor('LAB_ORDER_MODIFY')).toEqual([{ kind: 'chart.import', externalPatientId: '900' }]);
    expect(intentsFor('PATIENT_PROBLEM_CREATE')).toEqual([{ kind: 'chart.import', externalPatientId: '900' }]);
  });

  test("DrChrono's own PATIENT_FLAG spelling discrepancy is handled both ways", () => {
    // The API documentation says PATIENT_FLAG_CMODIFY; the console says
    // PATIENT_FLAG_MODIFY. Whichever it sends has to work, and the legacy
    // `startsWith('PATIENT_')` prefix match sorted neither into a handler that
    // did anything.
    expect(intentsFor('PATIENT_FLAG_MODIFY')[0].kind).toBe('chart.import');
    expect(intentsFor('PATIENT_FLAG_CMODIFY')[0].kind).toBe('chart.import');
  });

  test('billing and practice-task events are ignored with a stated reason', () => {
    for (const name of ['LINE_ITEM_CREATE', 'CASH_PAYMENT_DELETE', 'TASK_MODIFY']) {
      const [intent] = intentsFor(name);
      expect(intent.kind).toBe('ignore');
      expect('reason' in intent && intent.reason.length).toBeGreaterThan(0);
    }
  });

  test('an id is read whether DrChrono sends it as a number or a string', () => {
    const asString = drchronoAdapter.toIntents({
      eventName: 'PATIENT_MODIFY',
      body: { object: { id: '12345' } },
      context: {},
    });
    expect(asString).toEqual([{ kind: 'chart.import', externalPatientId: '12345' }]);
  });
});

describe('the delivery contract', () => {
  test('the signature header is the secret itself, compared whole', () => {
    const secret = 'a-high-entropy-secret-token-value';
    expect(drchronoAdapter.verify({ request: request({ 'x-drchrono-signature': secret }), secret })).toBe(true);
    // A prefix must not pass. `timingSafeEqual` throws on a length mismatch,
    // so a comparison that forgot to check length first would crash here
    // rather than return false.
    expect(drchronoAdapter.verify({ request: request({ 'x-drchrono-signature': secret.slice(0, 10) }), secret })).toBe(
      false
    );
    expect(drchronoAdapter.verify({ request: request({}), secret })).toBe(false);
  });

  test('an empty secret never verifies', () => {
    // Otherwise an unconfigured clinic would accept a request with an empty
    // signature header, which is the fail-open version of this check.
    expect(drchronoAdapter.verify({ request: request({ 'x-drchrono-signature': '' }), secret: '' })).toBe(false);
  });

  test('the event name and delivery id come from headers, not the body', () => {
    const req = request({ 'x-drchrono-event': 'PATIENT_MODIFY', 'x-drchrono-delivery': 'abc-123' });
    expect(drchronoAdapter.eventName({ request: req })).toBe('PATIENT_MODIFY');
    expect(drchronoAdapter.deliveryId({ request: req })).toBe('abc-123');
    expect(drchronoAdapter.eventName({ request: request({}) })).toBeUndefined();
    expect(drchronoAdapter.deliveryId({ request: request({}) })).toBeUndefined();
  });
});

describe('challenge guard', () => {
  test('accepts an opaque token and rejects anything document-shaped', () => {
    expect(isSignableChallenge('9f8a7b6c5d4e')).toBe(true);
    expect(isSignableChallenge('')).toBe(false);
    expect(isSignableChallenge('x'.repeat(257))).toBe(false);
    expect(isSignableChallenge('{"receiver":1}')).toBe(false);
    expect(isSignableChallenge('[1,2]')).toBe(false);
    expect(isSignableChallenge('a\nb')).toBe(false);
  });
});
