// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { isXmlContentType } from './cda';

/**
 * How a document's file should be shown.
 *
 * A clinician opening a chart document wants to read it, not to download it and
 * hunt for it in a Downloads folder. So the rule here is: render anything we
 * can render honestly, and when we cannot, say why in one line and offer the
 * file — never a blank frame or a browser error.
 *
 * The split is by what the *browser* can do, because that is the real
 * constraint:
 *
 * - `framed`    PDF, plain text, JSON — the browser renders these itself.
 * - `xml`       C-CDA and friends, rendered as a readable document rather than
 *               as source, which is what a clinician actually wants from a CCD.
 * - `image`     formats a browser decodes natively.
 * - `tiff`      it does not decode TIFF — no browser does — but medical imaging
 *               and fax gateways emit it constantly, so it is decoded in the
 *               page instead of being written off as unsupported.
 * - `docx`      Word, converted to HTML. Layout is approximate; the text,
 *               headings, lists and tables are all there, which is the part
 *               that carries clinical meaning.
 * - `spreadsheet` Excel, rendered as a table.
 * - `download`  everything left: legacy `.doc`, archives, unknown bytes.
 *               Honest about it rather than showing a broken frame.
 */
export type PreviewKind = 'framed' | 'xml' | 'image' | 'tiff' | 'docx' | 'spreadsheet' | 'download';

/** Formats a browser decodes without help. `image/tiff` is deliberately absent. */
const NATIVE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/svg+xml',
]);

const DOCX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
]);

const SPREADSHEET_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

/**
 * Decide how to show a file.
 * @param contentType - The attachment's content type, resolved from its name where it had none.
 * @returns Which preview to render.
 */
export function getPreviewKind(contentType: string | undefined): PreviewKind {
  if (!contentType) {
    return 'download';
  }
  const type = contentType.split(';')[0].trim().toLowerCase();

  if (isXmlContentType(type)) {
    return 'xml';
  }
  if (type === 'application/pdf' || type === 'application/json' || type.startsWith('text/')) {
    return 'framed';
  }
  if (type === 'image/tiff' || type === 'image/tif') {
    return 'tiff';
  }
  if (NATIVE_IMAGE_TYPES.has(type)) {
    return 'image';
  }
  if (DOCX_TYPES.has(type)) {
    return 'docx';
  }
  if (SPREADSHEET_TYPES.has(type)) {
    return 'spreadsheet';
  }
  return 'download';
}

/**
 * A short, plain reason a file is offered for download instead of shown.
 *
 * Written for a clinician, not a developer: it says what the file is and what
 * to do, and never blames them or the file.
 * @param contentType - The attachment's content type.
 * @returns One sentence.
 */
export function getDownloadReason(contentType: string | undefined): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/msword') {
    return 'This is an older Word file (.doc), a format browsers cannot display. Download it to open it in Word.';
  }
  if (!type || type === 'application/octet-stream') {
    return 'This file arrived without a type, so it cannot be shown safely. Download it to open it.';
  }
  return `Files of type ${type} cannot be displayed in a browser. Download it to open it.`;
}
