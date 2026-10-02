// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Clinician feedback as a `Communication`.
 *
 * Both sides of the wire live in one module here — nothing in `bots/` writes a
 * feedback record — so these are round-trip tests of `build` against `parse`,
 * plus the three properties the storage decision rests on: the identifier is the
 * upsert key, the payload entries are told apart by content type rather than by
 * position, and an absent rating really clears the rating.
 */
import type { Communication } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { AiFeedbackTarget } from './ai-feedback';
import {
  AI_FEEDBACK_CATEGORY_CODE,
  AI_FEEDBACK_CATEGORY_SYSTEM,
  AI_FEEDBACK_CORRECTION_TITLE,
  AI_FEEDBACK_IDENTIFIER_SYSTEM,
  AI_FEEDBACK_RATING_SYSTEM,
  aiFeedbackIdentifierValue,
  aiFeedbackSearchQuery,
  buildFeedbackCommunication,
  decodeAttachmentText,
  encodeAttachmentText,
  isEmptyFeedback,
  parseFeedbackCommunication,
} from './ai-feedback';

const TARGET: AiFeedbackTarget = {
  composition: { reference: 'Composition/comp-1' },
  patient: { reference: 'Patient/pat-1' },
  reviewer: { reference: 'Practitioner/doc-1' },
};

const SENT = '2026-10-02T12:00:00.000Z';

function build(feedback: Parameters<typeof buildFeedbackCommunication>[0]['feedback']): Communication {
  return buildFeedbackCommunication({ target: TARGET, feedback, sent: SENT });
}

describe('identifier', () => {
  test('keys on the rated document and the reviewer', () => {
    expect(aiFeedbackIdentifierValue('comp-1', 'Practitioner/doc-1')).toBe('comp-1:Practitioner:doc-1');
  });

  test('carries no bare pipe, which would split the identifier search', () => {
    // `identifier=<system>|<value>`: a `|` inside the value would be read as a
    // second delimiter and the search would silently match nothing.
    expect(aiFeedbackIdentifierValue('comp-1', 'Practitioner/doc-1')).not.toContain('|');
  });

  test('search query is the system and value, URL-encoded', () => {
    expect(aiFeedbackSearchQuery('comp-1', 'Practitioner/doc-1')).toBe(
      `identifier=${encodeURIComponent(`${AI_FEEDBACK_IDENTIFIER_SYSTEM}|comp-1:Practitioner:doc-1`)}`
    );
  });

  test('is on the built resource, so the conditional update is a true upsert', () => {
    expect(build({ rating: 'thumbs-up' }).identifier).toEqual([
      { system: AI_FEEDBACK_IDENTIFIER_SYSTEM, value: 'comp-1:Practitioner:doc-1' },
    ]);
  });
});

describe('build', () => {
  test('points `about` at the rated Composition and `subject` at the patient', () => {
    const communication = build({ rating: 'thumbs-up' });
    // `subject` is not decoration: the clinic access policy grants
    // `Communication?_compartment=%organization`, and the patient compartment is
    // what puts the record inside it.
    expect(communication.subject).toEqual({ reference: 'Patient/pat-1' });
    expect(communication.about).toEqual([{ reference: 'Composition/comp-1' }]);
    expect(communication.sender).toEqual({ reference: 'Practitioner/doc-1' });
    expect(communication.status).toBe('completed');
    expect(communication.sent).toBe(SENT);
  });

  test('always carries the feature category, so the records are searchable as a set', () => {
    const marker = build({ comment: 'hm' }).category?.[0];
    expect(marker?.coding).toEqual([{ system: AI_FEEDBACK_CATEGORY_SYSTEM, code: AI_FEEDBACK_CATEGORY_CODE }]);
  });

  test('puts the rating in a second category coding', () => {
    const codes = build({ rating: 'thumbs-down' }).category?.flatMap((c) => c.coding ?? []);
    expect(codes).toContainEqual({
      system: AI_FEEDBACK_RATING_SYSTEM,
      code: 'thumbs-down',
      display: 'Not helpful',
    });
  });

  test('omits the rating category when there is no rating', () => {
    // The point of the whole build-from-complete-state design: prod wrote
    // `rating ?? existing.rating`, so clearing a vote left it in the database.
    const codes = build({ comment: 'only a comment' }).category?.flatMap((c) => c.coding ?? []) ?? [];
    expect(codes.some((coding) => coding.system === AI_FEEDBACK_RATING_SYSTEM)).toBe(false);
  });

  test('stores the comment as a contentString payload', () => {
    expect(build({ comment: '  missed the AKI  ' }).payload).toEqual([{ contentString: 'missed the AKI' }]);
  });

  test('stores the correction as a titled text attachment', () => {
    const attachment = build({ correction: 'Patient is on apixaban, not warfarin.' }).payload?.[0]?.contentAttachment;
    expect(attachment?.contentType).toBe('text/plain');
    expect(attachment?.title).toBe(AI_FEEDBACK_CORRECTION_TITLE);
    expect(decodeAttachmentText(attachment?.data)).toBe('Patient is on apixaban, not warfarin.');
  });

  test('writes no payload at all when there is only a rating', () => {
    expect(build({ rating: 'thumbs-up' }).payload).toBeUndefined();
  });
});

describe('round trip', () => {
  test('a full record survives build then parse', () => {
    const parsed = parseFeedbackCommunication({
      ...build({ rating: 'thumbs-down', comment: 'Wrong medication list', correction: 'Apixaban 5mg BID' }),
      id: 'fb-1',
    });
    expect(parsed).toEqual({
      communicationId: 'fb-1',
      rating: 'thumbs-down',
      comment: 'Wrong medication list',
      correction: 'Apixaban 5mg BID',
      recordedAt: SENT,
    });
  });

  test('a correction with no comment parses as a correction, not a comment', () => {
    // The reason the two payload entries are distinguished by content type and
    // not by array position.
    const parsed = parseFeedbackCommunication(build({ correction: 'Apixaban, not warfarin' }));
    expect(parsed.correction).toBe('Apixaban, not warfarin');
    expect(parsed.comment).toBeUndefined();
  });

  test('non-ASCII text survives the attachment encoding', () => {
    // `btoa` alone throws above U+00FF, which a pasted clinical correction will
    // eventually contain.
    const text = 'Temp 38.5°C — déjà documented';
    expect(decodeAttachmentText(encodeAttachmentText(text))).toBe(text);
    expect(parseFeedbackCommunication(build({ correction: text })).correction).toBe(text);
  });
});

describe('parse is tolerant', () => {
  test('an unknown rating code yields no rating rather than throwing', () => {
    const parsed = parseFeedbackCommunication({
      resourceType: 'Communication',
      status: 'completed',
      category: [{ coding: [{ system: AI_FEEDBACK_RATING_SYSTEM, code: 'shrug' }] }],
    });
    expect(parsed.rating).toBeUndefined();
  });

  test('undecodable attachment data yields no correction rather than throwing', () => {
    const parsed = parseFeedbackCommunication({
      resourceType: 'Communication',
      status: 'completed',
      payload: [{ contentAttachment: { contentType: 'text/plain', data: 'not!base64!' } }],
    });
    expect(parsed.correction).toBeUndefined();
  });

  test('a record with no category and no payload parses to an empty state', () => {
    const parsed = parseFeedbackCommunication({ resourceType: 'Communication', status: 'completed' });
    expect(isEmptyFeedback(parsed)).toBe(true);
  });
});

describe('isEmptyFeedback', () => {
  test('whitespace is not content', () => {
    expect(isEmptyFeedback({ comment: '   ', correction: '\n' })).toBe(true);
    expect(isEmptyFeedback({ rating: 'thumbs-up' })).toBe(false);
    expect(isEmptyFeedback({ comment: 'x' })).toBe(false);
  });
});
