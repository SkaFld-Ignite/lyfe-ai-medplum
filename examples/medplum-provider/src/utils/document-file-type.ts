// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Attachment, DocumentReference } from '@medplum/fhirtypes';

/**
 * Extension to MIME type, for attachments stored without a content type.
 *
 * The DrChrono importer now types every file it stores (`bots/shared/file-type.ts`),
 * but documents imported before that carry only a link and a title such as
 * "08172026 LABCORP RESULTS .pdf". Keep this table in step with the bot's.
 */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  json: 'application/json',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Guess a file's type from a name or URL ending in an extension.
 * @param name - A file name, title or URL; query strings and fragments are ignored.
 * @returns The MIME type, or undefined if there is no known extension.
 */
export function contentTypeFromName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const path = name.split(/[?#]/)[0].trim().toLowerCase();
  const match = /\.([a-z0-9]{2,5})$/.exec(path);
  return match ? EXTENSION_TYPES[match[1]] : undefined;
}

/**
 * The attachment's content type, or one inferred from its title, the document's
 * description or the file URL when the attachment was stored without one.
 * @param doc - The document the attachment belongs to.
 * @param attachment - The attachment.
 * @returns The content type, or undefined when nothing identifies the file.
 */
export function getAttachmentContentType(
  doc: DocumentReference,
  attachment: Attachment | undefined
): string | undefined {
  if (!attachment) {
    return undefined;
  }
  return (
    attachment.contentType ??
    contentTypeFromName(attachment.title) ??
    contentTypeFromName(doc.description) ??
    contentTypeFromName(attachment.url)
  );
}
