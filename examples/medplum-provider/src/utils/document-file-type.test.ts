// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DocumentReference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { contentTypeFromName, getAttachmentContentType } from './document-file-type';

const doc = (description?: string): DocumentReference => ({
  resourceType: 'DocumentReference',
  status: 'current',
  content: [],
  description,
});

describe('contentTypeFromName', () => {
  test('reads extensions, ignoring case, spaces, queries and fragments', () => {
    expect(contentTypeFromName('08172026 LABCORP RESULTS .pdf')).toBe('application/pdf');
    expect(contentTypeFromName('Scan.TIFF ')).toBe('image/tiff');
    expect(contentTypeFromName('https://s3.example.com/a/b.png?X-Amz-Signature=1#x')).toBe('image/png');
  });

  test('returns undefined without a known extension', () => {
    expect(contentTypeFromName('MONARCH ELIGIBILITY')).toBeUndefined();
    expect(contentTypeFromName('data.bin')).toBeUndefined();
    expect(contentTypeFromName(undefined)).toBeUndefined();
  });
});

describe('getAttachmentContentType', () => {
  test('prefers the stored content type', () => {
    expect(getAttachmentContentType(doc('x.pdf'), { contentType: 'image/png', title: 'y.pdf' })).toBe('image/png');
  });

  test('falls back to the title, then the description, then the url', () => {
    expect(getAttachmentContentType(doc('x.pdf'), { title: 'y.png' })).toBe('image/png');
    expect(getAttachmentContentType(doc('x.pdf'), { title: 'Document' })).toBe('application/pdf');
    expect(getAttachmentContentType(doc(), { url: 'https://h/f.jpg?sig=1' })).toBe('image/jpeg');
  });

  test('returns undefined when nothing identifies the file', () => {
    expect(getAttachmentContentType(doc('MONARCH ELIGIBILITY'), { url: 'https://h/abc' })).toBeUndefined();
    expect(getAttachmentContentType(doc('x.pdf'), undefined)).toBeUndefined();
  });
});
