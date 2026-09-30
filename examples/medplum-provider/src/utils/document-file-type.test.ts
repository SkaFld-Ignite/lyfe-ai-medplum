// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DocumentReference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { contentTypeFromName, downloadFileName, getAttachmentContentType } from './document-file-type';

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

describe('downloadFileName', () => {
  test('adds the extension a saved file needs to open', () => {
    // A document titled "Untitled document" saved with no extension is on disk
    // and useless: the OS has nothing to open it with.
    expect(downloadFileName('Untitled document', 'application/pdf')).toBe('Untitled document.pdf');
    expect(downloadFileName('Scan', 'image/tiff')).toBe('Scan.tif');
    expect(downloadFileName(undefined, 'text/csv')).toBe('document.csv');
  });

  test('does not double up an extension the title already has', () => {
    expect(downloadFileName('LABCORP RESULTS.pdf', 'application/pdf')).toBe('LABCORP RESULTS.pdf');
    expect(downloadFileName('REPORT.PDF', 'application/pdf')).toBe('REPORT.PDF');
  });

  test('strips characters a file name cannot hold', () => {
    // DrChrono titles arrive with embedded newlines, e.g. "99204 AUTH\r\nEXP".
    expect(downloadFileName('99204 AUTH\r\nEXP 10/19/24', 'application/pdf')).toBe('99204 AUTH EXP 10 19 24.pdf');
  });

  test('leaves the name alone when the type is unknown', () => {
    expect(downloadFileName('mystery', undefined)).toBe('mystery');
    expect(downloadFileName('mystery', 'application/x-weird')).toBe('mystery');
  });
});
