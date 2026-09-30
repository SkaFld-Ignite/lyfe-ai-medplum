// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Working out what kind of file a DrChrono document is.
 *
 * DrChrono's `/documents` payload carries no MIME type, only a presigned S3
 * link and a free-text description, and that S3 object is usually served as
 * `application/octet-stream`. A DocumentReference without a real content type
 * cannot be previewed, so the importer decides the type from the bytes first
 * (magic numbers do not lie), then from a specific response header, then from
 * the file name, in that order.
 *
 * The app keeps its own name-based fallback in
 * `src/utils/document-file-type.ts` for documents imported before this existed.
 */

/** Used when nothing identifies the file. Stored as-is so the file can still be downloaded. */
export const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

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

const TYPE_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'text/plain': 'txt',
  'application/rtf': 'rtf',
};

/** Response types that say nothing about the file. */
const GENERIC_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/x-download',
  'application/download',
]);

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((b, i) => bytes[offset + i] === b);
}

/**
 * Identify a file from its leading bytes.
 * @param bytes - The file contents (only the first few bytes are read).
 * @returns The MIME type, or undefined if the signature is not recognised.
 */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf'; // %PDF-
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif'; // GIF8
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff'; // little- and big-endian
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'; // RIFF....WEBP
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return 'image/bmp';
  }
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return 'application/rtf'; // {\rtf
  }
  return undefined;
}

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
 * The type of a response, if the server named one specifically.
 * @param header - The raw `Content-Type` header.
 * @returns The bare MIME type, or undefined when missing or generic.
 */
function specificHeaderType(header: string | null | undefined): string | undefined {
  const type = header?.split(';')[0].trim().toLowerCase();
  return type && !GENERIC_TYPES.has(type) ? type : undefined;
}

/**
 * Decide the content type of a downloaded file.
 * @param bytes - The file contents.
 * @param headerType - The response `Content-Type` header, if any.
 * @param names - File names, titles or URLs that may end in an extension, most trustworthy first.
 * @returns The best available MIME type; {@link UNKNOWN_CONTENT_TYPE} when nothing identifies it.
 */
export function resolveContentType(
  bytes: Uint8Array,
  headerType: string | null | undefined,
  names: (string | undefined)[]
): string {
  return (
    sniffContentType(bytes) ??
    specificHeaderType(headerType) ??
    names.map(contentTypeFromName).find((t) => t !== undefined) ??
    UNKNOWN_CONTENT_TYPE
  );
}

/**
 * A file name for storage, with an extension that matches the content type.
 * @param base - The name without extension.
 * @param contentType - The resolved MIME type.
 * @returns The file name.
 */
export function fileNameFor(base: string, contentType: string): string {
  const extension = TYPE_EXTENSIONS[contentType];
  return extension ? `${base}.${extension}` : base;
}
