// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Clinician feedback on an AI-generated document, as a FHIR `Communication`.
 *
 * Ported from lyfe-provider-ui's `app/actions/ai-feedback-actions.ts` and
 * `components/ai/ai-feedback-widget.tsx`, which wrote a Prisma `ai_feedback`
 * row with `{ patientId, userId, generationType, rating, comment,
 * editedContent, originalContent }`.
 *
 * WHY `Communication`, AND WHAT WAS REJECTED
 * -----------------------------------------
 * There is no FHIR resource for "the clinician rated the model's output", so
 * this is a judgement call. Three candidates were on the table.
 *
 * `Provenance` on the Composition has exactly the right semantics for "who
 * assessed this output" — `agent.who` and an `activity` code — and nothing else
 * to offer. There is nowhere for the free-text comment and nowhere for the
 * clinician's corrected version, which are two of the widget's three controls.
 * It is also the wrong neighbourhood: `SignAddendum` and `chartNoteStatus` read
 * `Provenance` as the note's **signature trail**, so adding feedback records to
 * the same stream would put opinions in a place the app already treats as
 * attestation.
 *
 * `Composition.relatesTo` plus a corrected `Composition` is arguably the
 * truest model for "the clinician fixed the AI's output", and it is rejected on
 * cost rather than on semantics. It needs a second Composition per edit, which
 * would sit on the chart alongside the summary and collide with the summary's
 * own `identifier` upsert (`aiSummarySearchQuery`), and it has nothing at all to
 * say about the thumbs-up case — so a second mechanism would be needed anyway.
 * One widget should not need two storage models.
 *
 * `Communication` is what this uses:
 *
 * - `about` → the rated `Composition`. Note that `inResponseTo` — the obvious
 *   field by name — is `Reference(Communication)` in R4 and *cannot* point at a
 *   Composition, so `about` (which is `Reference(Any)`) is the correct one.
 * - `subject` → the `Patient`. Not decoration: the clinic access policy grants
 *   `Communication?_compartment=%organization`, and the patient compartment is
 *   what puts the record inside it.
 * - `sender` → the reviewing `Practitioner`.
 * - `category` → two codings: the feature marker, and the rating. `category` is
 *   the only one of `category` / `topic` / `reasonCode` that is a **search
 *   parameter** on `Communication` in R4, so putting the rating there makes
 *   "every thumbs-down in this clinic" a single search rather than a scan.
 * - `payload` → the comment as `contentString`, and the correction as a titled
 *   `text/plain` `contentAttachment`. Two payload entries distinguished by
 *   **content type**, not by array position, so a feedback record with a
 *   correction and no comment parses the same as one with both.
 *
 * A RUNNING RECORD, NOT A LOG
 * ---------------------------
 * lyfe-provider-ui kept one row per `(patient, user, generationType)` and
 * hand-upserted it, coalescing partial submits. That is preserved here: the
 * `identifier` is `(rated Composition, reviewing Practitioner)` and the write is
 * a conditional update, so a clinician has one standing opinion per document
 * rather than a history of them.
 *
 * Two reasons, beyond matching prod. First, the widget is itself stateful — it
 * shows the clinician the vote they already cast and lets them change it — so a
 * `Communication` per event would mean reading N records to render one, and
 * rendering the newest of them, which is the upsert with extra steps. Second,
 * nothing is lost: Medplum versions every update, so `Communication/<id>/_history`
 * already is the log, with no design needed.
 *
 * WHAT HAS NO COUNTERPART
 * -----------------------
 * Prod's `originalContent` column copied the rated AI text into the feedback
 * row. There is no equivalent field here and deliberately so: `about` points at
 * the document, which is the thing itself rather than a copy of it that can
 * drift. The consequence is honest and worth stating — if the summary is
 * regenerated, the standing feedback now hangs off the new text. Prod had the
 * same hole by a different route, since its upsert overwrote `originalContent`
 * on the next submit.
 *
 * Prod's `generationType` column is likewise gone. It existed to tell three
 * kinds of summary apart in one flat table; here the rated resource is named
 * directly by `about`, so the distinction is in the reference.
 */
import type {
  CodeableConcept,
  Communication,
  CommunicationPayload,
  Composition,
  Patient,
  Practitioner,
  Reference,
  RelatedPerson,
} from '@medplum/fhirtypes';

/** Identifier system for the one feedback record per (document, reviewer). */
export const AI_FEEDBACK_IDENTIFIER_SYSTEM = 'https://lyfe.com/ai-feedback';

/** Marks the Communication as this feature's output, for a `category` search. */
export const AI_FEEDBACK_CATEGORY_SYSTEM = 'https://lyfe.com/CodeSystem/communication-category';

/** The `category` code every feedback record carries. */
export const AI_FEEDBACK_CATEGORY_CODE = 'ai-feedback';

/** Thumbs up/down, as a second `category` so it is searchable. */
export const AI_FEEDBACK_RATING_SYSTEM = 'https://lyfe.com/CodeSystem/ai-feedback-rating';

/**
 * `Attachment.title` on the correction payload.
 *
 * The payload entries are told apart by content type first — a correction is the
 * only `contentAttachment` — so this is a label for a human reading the resource
 * rather than a discriminator the parser depends on.
 */
export const AI_FEEDBACK_CORRECTION_TITLE = 'Clinician-corrected text';

/**
 * Prod's `rating` was `1 = thumbs down, 2 = thumbs up`, an integer with no
 * meaning outside that file. Coded here so the stored resource says what it
 * means.
 */
export type FeedbackRating = 'thumbs-up' | 'thumbs-down';

export const FEEDBACK_RATING_LABELS: Record<FeedbackRating, string> = {
  'thumbs-up': 'Helpful',
  'thumbs-down': 'Not helpful',
};

/** The widget's state, and what one stored `Communication` parses back into. */
export interface AiFeedback {
  /** Absent until the first submit has been saved. */
  communicationId?: string;
  rating?: FeedbackRating;
  comment?: string;
  /** The clinician's corrected version of the AI text. */
  correction?: string;
  /** `Communication.sent`. */
  recordedAt?: string;
}

/** Who is rating what. */
export interface AiFeedbackTarget {
  /** The rated AI document. */
  composition: Reference<Composition> & { reference: string };
  /** The chart it belongs to, which is what carries the compartment. */
  patient: Reference<Patient> & { reference: string };
  /**
   * The reviewing clinician, from `medplum.getProfile()`.
   *
   * Typed as the three profile resources Medplum logs a human in as, which is
   * also the subset of `Communication.sender`'s targets a session can produce.
   */
  reviewer: Reference<Practitioner | Patient | RelatedPerson> & { reference: string };
}

const ID_SEPARATOR = ':';

/**
 * The identifier value: the rated document and the reviewer.
 *
 * `:` rather than `|`, because the value is interpolated into an
 * `identifier=<system>|<value>` search and a `|` inside it would be read as a
 * second system delimiter.
 * @param compositionId - The rated Composition's id.
 * @param reviewerReference - The reviewer's reference, e.g. `Practitioner/abc`.
 * @returns The identifier value.
 */
export function aiFeedbackIdentifierValue(compositionId: string, reviewerReference: string): string {
  return `${compositionId}${ID_SEPARATOR}${reviewerReference.replace('/', ID_SEPARATOR)}`;
}

/**
 * The search that finds one clinician's feedback on one document.
 * @param compositionId - The rated Composition's id.
 * @param reviewerReference - The reviewer's reference.
 * @returns The `identifier` search parameter, URL-encoded.
 */
export function aiFeedbackSearchQuery(compositionId: string, reviewerReference: string): string {
  const value = aiFeedbackIdentifierValue(compositionId, reviewerReference);
  return `identifier=${encodeURIComponent(`${AI_FEEDBACK_IDENTIFIER_SYSTEM}|${value}`)}`;
}

/**
 * UTF-8 safe base64, for the correction `Attachment.data`.
 *
 * `Attachment` has no plain-text field — the content is `base64Binary` or a URL
 * — and `btoa` alone throws on any character above U+00FF, which a pasted
 * clinical correction will eventually contain (a degree sign, an en dash, an
 * accented name).
 * @param text - The text to store.
 * @returns Base64 of its UTF-8 bytes.
 */
export function encodeAttachmentText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The inverse of {@link encodeAttachmentText}.
 * @param data - Base64 from `Attachment.data`.
 * @returns The decoded text, or an empty string when the data is not decodable.
 */
export function decodeAttachmentText(data: string | undefined): string {
  if (!data) {
    return '';
  }
  try {
    const binary = atob(data);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    // Unreadable stored data must not take the whole card down with it. The
    // widget renders as "no correction captured", which is true of what can be
    // read.
    return '';
  }
}

function ratingCategory(rating: FeedbackRating): CodeableConcept {
  return {
    coding: [{ system: AI_FEEDBACK_RATING_SYSTEM, code: rating, display: FEEDBACK_RATING_LABELS[rating] }],
    text: FEEDBACK_RATING_LABELS[rating],
  };
}

/**
 * Build the `Communication` for a feedback submission.
 *
 * Takes the **whole** desired state rather than a patch, because the write is a
 * conditional update that replaces the stored resource. Coalescing a partial
 * submit — a comment typed without a rating — is therefore the caller's job, and
 * visibly so; see `useAiFeedback`.
 *
 * That split also fixes a real prod bug. Its action wrote
 * `rating: params.rating ?? existing.rating`, so un-toggling a thumb sent
 * `undefined` and silently kept the old rating: the UI showed no vote and the
 * database held one. Here an absent `rating` means **no rating**, and the
 * rating `category` is simply not written.
 * @param props - The target and the complete feedback state.
 * @param props.target - Who is rating what.
 * @param props.feedback - The complete state to store.
 * @param props.sent - ISO instant of the submission.
 * @returns The Communication, ready for a conditional update on its identifier.
 */
export function buildFeedbackCommunication(props: {
  target: AiFeedbackTarget;
  feedback: AiFeedback;
  sent: string;
}): Communication {
  const { target, feedback } = props;
  const compositionId = target.composition.reference.split('/')[1];

  const payload: CommunicationPayload[] = [];
  const comment = feedback.comment?.trim();
  if (comment) {
    payload.push({ contentString: comment });
  }
  const correction = feedback.correction?.trim();
  if (correction) {
    payload.push({
      contentAttachment: {
        contentType: 'text/plain',
        title: AI_FEEDBACK_CORRECTION_TITLE,
        data: encodeAttachmentText(correction),
      },
    });
  }

  return {
    resourceType: 'Communication',
    identifier: [
      {
        system: AI_FEEDBACK_IDENTIFIER_SYSTEM,
        value: aiFeedbackIdentifierValue(compositionId, target.reviewer.reference),
      },
    ],
    status: 'completed',
    category: [
      {
        coding: [{ system: AI_FEEDBACK_CATEGORY_SYSTEM, code: AI_FEEDBACK_CATEGORY_CODE }],
        text: 'Feedback on AI-generated content',
      },
      ...(feedback.rating ? [ratingCategory(feedback.rating)] : []),
    ],
    subject: target.patient,
    about: [target.composition],
    sender: target.reviewer,
    sent: props.sent,
    ...(payload.length > 0 && { payload }),
  };
}

function isRating(value: string | undefined): value is FeedbackRating {
  return value === 'thumbs-up' || value === 'thumbs-down';
}

/**
 * Parse a stored feedback `Communication` back into the widget's state.
 *
 * Tolerant in the same way the summary parser is: an unknown rating code, a
 * payload with neither a string nor a readable attachment, or a record with no
 * payload at all each degrade to "that part is absent" rather than throwing.
 * @param communication - The stored record.
 * @returns The widget state.
 */
export function parseFeedbackCommunication(communication: Communication): AiFeedback {
  let rating: FeedbackRating | undefined;
  for (const category of communication.category ?? []) {
    for (const coding of category.coding ?? []) {
      if (coding.system === AI_FEEDBACK_RATING_SYSTEM && isRating(coding.code)) {
        rating = coding.code;
      }
    }
  }

  let comment: string | undefined;
  let correction: string | undefined;
  for (const entry of communication.payload ?? []) {
    // Content type, not position: a record carrying only a correction must parse
    // its correction, not read it as the comment.
    if (entry.contentString) {
      comment = entry.contentString;
    } else if (entry.contentAttachment?.data) {
      correction = decodeAttachmentText(entry.contentAttachment.data) || undefined;
    }
  }

  return {
    communicationId: communication.id,
    rating,
    comment,
    correction,
    recordedAt: communication.sent,
  };
}

/**
 * True when the record carries nothing worth storing.
 * @param feedback - The state to test.
 * @returns True when there is no rating, comment or correction.
 */
export function isEmptyFeedback(feedback: AiFeedback): boolean {
  return !feedback.rating && !feedback.comment?.trim() && !feedback.correction?.trim();
}
