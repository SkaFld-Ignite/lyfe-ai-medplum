// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { getDownloadReason, getPreviewKind } from './preview-kind';

describe('choosing a preview', () => {
  test('only PDF goes in the iframe', () => {
    expect(getPreviewKind('application/pdf')).toBe('framed');
    expect(getPreviewKind('image/png')).toBe('image');
    expect(getPreviewKind('image/jpeg')).toBe('image');
  });

  test('text is drawn as text, never framed', () => {
    // Chrome downloads a text/* iframe rather than displaying it, so framing
    // these rendered an empty panel with no error — which is what an HL7
    // result and a CSV both did.
    expect(getPreviewKind('text/plain')).toBe('text');
    expect(getPreviewKind('application/json')).toBe('text');
    expect(getPreviewKind('text/html')).toBe('text');
    expect(getPreviewKind('text/csv')).toBe('csv');
  });

  test('reads a C-CDA as a document, not as source', () => {
    // The commonest thing in the pilot chart by a wide margin: 279 of 398
    // documents on the first patient are XML.
    expect(getPreviewKind('application/xml')).toBe('xml');
    expect(getPreviewKind('text/xml')).toBe('xml');
  });

  test('TIFF is decoded rather than handed to the browser', () => {
    // No browser decodes TIFF, but fax gateways and imaging systems emit it,
    // so it must not fall through to an <img> that renders nothing.
    expect(getPreviewKind('image/tiff')).toBe('tiff');
    expect(getPreviewKind('image/tif')).toBe('tiff');
  });

  test('Office formats get their own decoders', () => {
    expect(getPreviewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(getPreviewKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(getPreviewKind('application/vnd.ms-excel')).toBe('spreadsheet');
  });

  test('a content type with parameters is still matched', () => {
    // Servers routinely send `text/plain; charset=utf-8`; matching on the whole
    // string would send it to the download card.
    expect(getPreviewKind('text/plain; charset=utf-8')).toBe('text');
    expect(getPreviewKind('APPLICATION/PDF')).toBe('framed');
  });

  test('anything else is offered for download rather than faked', () => {
    expect(getPreviewKind(undefined)).toBe('download');
    expect(getPreviewKind('application/msword')).toBe('download');
    expect(getPreviewKind('application/zip')).toBe('download');
    expect(getPreviewKind('application/octet-stream')).toBe('download');
  });
});

describe('explaining a download', () => {
  test('names the format and says what to do', () => {
    expect(getDownloadReason('application/msword')).toContain('.doc');
    expect(getDownloadReason('application/zip')).toContain('application/zip');
    expect(getDownloadReason(undefined)).toContain('without a type');
  });

  test('never blames the reader', () => {
    for (const type of [undefined, 'application/msword', 'application/zip', 'application/octet-stream']) {
      const reason = getDownloadReason(type);
      expect(reason).toMatch(/Download it to open it/);
      expect(reason).not.toMatch(/error|invalid|failed/i);
    }
  });
});
