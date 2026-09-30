// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import {
  UNKNOWN_CONTENT_TYPE,
  contentTypeFromName,
  fileNameFor,
  resolveContentType,
  sniffContentType,
} from './file-type';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sniffContentType', () => {
  test.each([
    ['PDF', ascii('%PDF-1.7\n'), 'application/pdf'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00), 'image/png'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['GIF', ascii('GIF89a'), 'image/gif'],
    ['TIFF (little-endian)', bytes(0x49, 0x49, 0x2a, 0x00), 'image/tiff'],
    ['TIFF (big-endian)', bytes(0x4d, 0x4d, 0x00, 0x2a), 'image/tiff'],
    ['WebP', ascii('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    ['RTF', ascii('{\\rtf1\\ansi'), 'application/rtf'],
  ])('%s', (_name, input, expected) => {
    expect(sniffContentType(input)).toBe(expected);
  });

  test('returns undefined for unknown or too-short content', () => {
    expect(sniffContentType(ascii('hello world'))).toBeUndefined();
    expect(sniffContentType(bytes(0x25, 0x50))).toBeUndefined();
    expect(sniffContentType(bytes())).toBeUndefined();
  });
});

describe('contentTypeFromName', () => {
  test('reads the extension of names and URLs', () => {
    expect(contentTypeFromName('08172026 LABCORP RESULTS .pdf')).toBe('application/pdf');
    expect(contentTypeFromName('scan.JPEG')).toBe('image/jpeg');
    expect(contentTypeFromName('https://s3.example.com/docs/abc.tif?X-Amz-Signature=1#page=2')).toBe('image/tiff');
  });

  test('returns undefined without a known extension', () => {
    expect(contentTypeFromName('MONARCH ELIGIBILITY')).toBeUndefined();
    expect(contentTypeFromName('99213 APPROVAL AUTH exp 3/7/27 FOR D')).toBeUndefined();
    expect(contentTypeFromName('archive.xyz')).toBeUndefined();
    expect(contentTypeFromName(undefined)).toBeUndefined();
  });
});

describe('resolveContentType', () => {
  test('trusts the bytes over a misleading header or name', () => {
    expect(resolveContentType(ascii('%PDF-1.4'), 'application/octet-stream', ['photo.png'])).toBe('application/pdf');
  });

  test('uses a specific header when the bytes are not recognised', () => {
    expect(resolveContentType(ascii('plain words'), 'text/plain; charset=utf-8', [])).toBe('text/plain');
  });

  test('ignores generic headers and falls back to the first name with an extension', () => {
    expect(
      resolveContentType(ascii('??'), 'binary/octet-stream', ['MONARCH ELIGIBILITY', 'https://x/y/z.docx?sig=1'])
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  test('falls back to octet-stream when nothing identifies the file', () => {
    expect(resolveContentType(ascii('??'), null, ['no extension'])).toBe(UNKNOWN_CONTENT_TYPE);
  });
});

describe('fileNameFor', () => {
  test('adds the extension for known types only', () => {
    expect(fileNameFor('drchrono-document-12', 'application/pdf')).toBe('drchrono-document-12.pdf');
    expect(fileNameFor('drchrono-document-12', UNKNOWN_CONTENT_TYPE)).toBe('drchrono-document-12');
  });
});
