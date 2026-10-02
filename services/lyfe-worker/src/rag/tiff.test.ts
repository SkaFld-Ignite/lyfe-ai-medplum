// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as OcrModule from './ocr.ts';

/**
 * TIFF conversion and OCR.
 *
 * The fixtures are **real TIFFs**, encoded here with the same library that
 * decodes them. A hand-rolled byte stub would prove only that the mocks line
 * up; what needs proving is that a TIFF goes in and valid PNG comes out, since
 * the entire reason this module exists is that Textract rejects the TIFF.
 *
 * Textract itself is mocked. It is a billable network call, and what matters
 * here is which bytes reach it and how the pages are assembled — not Textract's
 * own recognition.
 */

const ocrDocument = vi.fn();

vi.mock('./ocr.ts', async () => {
  const actual = await vi.importActual<typeof OcrModule>('./ocr.ts');
  return { ...actual, ocrDocument: (...args: unknown[]) => ocrDocument(...args) };
});

const { extractTiffText, tiffPageToPng, TiffDecodeError } = await import('./tiff.ts');
const UTIF = await import('utif2');
const { PNG } = await import('pngjs');

/** PNG's 8-byte file signature. */
const PNG_SIGNATURE = '89504e470d0a1a0a';

/**
 * Build a real single-page TIFF of a solid colour.
 * @param width - Image width.
 * @param height - Image height.
 * @param rgb - The fill colour.
 * @returns TIFF bytes.
 */
function makeTiff(width: number, height: number, rgb: [number, number, number] = [10, 20, 30]): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return Buffer.from(UTIF.encodeImage(rgba, width, height));
}

/**
 * Build a real multi-page TIFF by concatenating the IFDs of several encodes.
 * @param pages - How many pages.
 * @returns TIFF bytes with that many pages.
 */
function makeMultiPageTiff(pages: number): Buffer {
  const ifds = [];
  for (let page = 0; page < pages; page++) {
    const single = makeTiff(4, 4, [page * 10, 0, 0]);
    ifds.push(...UTIF.decode(single));
  }
  return Buffer.from(UTIF.encode(ifds));
}

beforeEach(() => {
  vi.clearAllMocks();
  ocrDocument.mockResolvedValue({ text: 'page text', confidence: 0.9, pageCount: 1 });
});

describe('tiffPageToPng', () => {
  test('produces real PNG bytes at the source dimensions', async () => {
    const png = await tiffPageToPng(makeTiff(8, 5), 0);

    // The signature is the point: Textract accepts PNG and rejects TIFF, so
    // "it returned a Buffer" is not the assertion that matters.
    expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
    const decoded = PNG.sync.read(png);
    expect([decoded.width, decoded.height]).toEqual([8, 5]);
  });

  test('refuses a page index the TIFF does not have', async () => {
    await expect(tiffPageToPng(makeTiff(4, 4), 3)).rejects.toBeInstanceOf(TiffDecodeError);
  });
});

describe('extractTiffText', () => {
  test('converts before OCR — Textract never sees TIFF bytes', async () => {
    await extractTiffText(makeTiff(8, 8), 'fax.tif');

    expect(ocrDocument).toHaveBeenCalledTimes(1);
    const [bytes] = ocrDocument.mock.calls[0] as [Buffer];
    expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
  });

  test('reads every page of a multi-page fax, in page order', async () => {
    // Multi-page is the common shape for clinical TIFF, and reading only the
    // first page would index the cover sheet and silently drop the report.
    ocrDocument.mockImplementation(async (_bytes: Buffer, label: string) => ({
      text: `text of ${label}`,
      confidence: 0.9,
      pageCount: 1,
    }));

    const result = await extractTiffText(makeMultiPageTiff(3), 'fax.tif');

    expect(result.pageCount).toBe(3);
    expect(result.ocrPages).toBe(3);
    expect(result.text).toBe('text of fax.tif page 1\n\ntext of fax.tif page 2\n\ntext of fax.tif page 3');
  });

  test('averages confidence across the pages it read', async () => {
    let call = 0;
    ocrDocument.mockImplementation(async () => ({ text: 'x', confidence: call++ === 0 ? 1 : 0.5, pageCount: 1 }));

    const result = await extractTiffText(makeMultiPageTiff(2), 'fax.tif');

    expect(result.confidence).toBeCloseTo(0.75);
  });

  test('one failing page does not lose the rest of the document', async () => {
    ocrDocument.mockImplementation(async (_bytes: Buffer, label: string) => {
      if (label.endsWith('page 2')) {
        throw new Error('Textract had a moment');
      }
      return { text: `ok ${label.slice(-1)}`, confidence: 0.9, pageCount: 1 };
    });

    const result = await extractTiffText(makeMultiPageTiff(3), 'fax.tif');

    expect(result.text).toBe('ok 1\n\nok 3');
    expect(result.ocrPages).toBe(2);
    expect(result.pageErrors).toEqual([{ page: 2, error: 'Textract had a moment' }]);
  });

  test('an OCR outage stops immediately rather than repeating per page', async () => {
    const { OcrUnavailableError } = await import('./ocr.ts');
    ocrDocument.mockRejectedValue(new OcrUnavailableError('textract:AnalyzeDocument is not granted'));

    // Unlike a PDF there is no text layer to fall back on, so this is the whole
    // document — and every remaining page would fail identically, so the
    // workers must wind down instead of making 20 more billable attempts.
    await expect(extractTiffText(makeMultiPageTiff(20), 'fax.tif')).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(ocrDocument.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test('a TIFF that yields no text at all is a skip, not an empty document', async () => {
    // An empty chunk set would index nothing while reporting success, which is
    // the failure mode that makes a gap invisible.
    ocrDocument.mockResolvedValue({ text: '   ', confidence: 0.9, pageCount: 1 });

    await expect(extractTiffText(makeTiff(4, 4), 'blank.tif')).rejects.toBeInstanceOf(TiffDecodeError);
  });

  test('rejects bytes that are not a TIFF', async () => {
    await expect(extractTiffText(Buffer.from('not a tiff at all'), 'junk.tif')).rejects.toBeInstanceOf(TiffDecodeError);
    expect(ocrDocument).not.toHaveBeenCalled();
  });

  test('caps pages so a long fax cannot blow the step budget, and says so', async () => {
    // 50 pages at concurrency 4 is minutes; the Inngest step ceiling is 12.
    const result = await extractTiffText(makeMultiPageTiff(55), 'long-fax.tif');

    expect(result.pageCount).toBe(55);
    expect(result.ocrPages).toBe(50);
    expect(ocrDocument).toHaveBeenCalledTimes(50);
    // The truncation has to be visible in the indexed text — a clinician asking
    // about page 52 deserves to know it was never read.
    expect(result.text).toContain('only the first 50 of 55 pages were read');
  });
});
