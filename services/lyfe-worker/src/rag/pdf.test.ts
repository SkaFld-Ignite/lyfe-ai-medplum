// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as OcrModule from './ocr.ts';

/**
 * The PDF path, with pdf.js, pdf-lib and Textract all mocked.
 *
 * PDFs are 734 of the 1,200 sampled documents, so the digital/OCR decision is
 * what sets both the index's coverage and its cost. The threshold is the
 * interesting part: "is the text layer empty" is the obvious test and it is
 * wrong, because scanned PDFs routinely carry a fax banner or a page number,
 * which would send an image-only ten-page report down the free path to be
 * indexed as three words.
 */

const ocrDocument = vi.fn();
const extractTextFromPdf = vi.fn();
const copyPages = vi.fn();
const getPageCount = vi.fn();

vi.mock('./ocr.ts', async () => {
  const actual = await vi.importActual<typeof OcrModule>('./ocr.ts');
  return { ...actual, ocrDocument: (...args: unknown[]) => ocrDocument(...args) };
});

vi.mock('unpdf', () => ({ extractText: (...args: unknown[]) => extractTextFromPdf(...args) }));

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: async () => ({ getPageCount: () => getPageCount() as number }),
    create: async () => ({
      copyPages: async (...args: unknown[]) => {
        copyPages(...args);
        return [{}];
      },
      addPage: () => undefined,
      save: async () => new Uint8Array([1, 2, 3]),
    }),
  },
}));

const { DIGITAL_TEXT_YIELD_THRESHOLD_CHARS_PER_PAGE, extractPdfText, MAX_OCR_PAGES_PER_DOCUMENT } =
  await import('./pdf.ts');
const { OcrUnavailableError } = await import('./ocr.ts');

const bytes = Buffer.from('%PDF-1.7 pretend');

beforeEach(() => {
  vi.clearAllMocks();
  getPageCount.mockReturnValue(1);
  ocrDocument.mockResolvedValue({ text: 'ocr text', confidence: 0.95, pageCount: 1 });
});

describe('the digital / OCR decision', () => {
  test('keeps the free path when the text layer is rich enough', async () => {
    extractTextFromPdf.mockResolvedValue({ text: 'a'.repeat(500), totalPages: 2 });
    const result = await extractPdfText(bytes, 'order.pdf');
    expect(result.path).toBe('pdf-digital');
    expect(result.ocrPages).toBe(0);
    expect(ocrDocument).not.toHaveBeenCalled();
  });

  test('OCRs when the yield is below the threshold, which is how a scan is spotted', async () => {
    // A ten-page scan carrying only a fax banner. "text layer is non-empty"
    // would wrongly accept this.
    extractTextFromPdf.mockResolvedValue({ text: 'FAX 03/14', totalPages: 10 });
    const result = await extractPdfText(bytes, 'scan.pdf');
    expect(result.path).toBe('pdf-ocr');
    expect(ocrDocument).toHaveBeenCalledTimes(10);
  });

  test('uses exactly the production threshold of 80 chars per page', async () => {
    expect(DIGITAL_TEXT_YIELD_THRESHOLD_CHARS_PER_PAGE).toBe(80);

    extractTextFromPdf.mockResolvedValue({ text: 'a'.repeat(80), totalPages: 1 });
    expect((await extractPdfText(bytes, 'at.pdf')).path).toBe('pdf-digital');

    vi.clearAllMocks();
    getPageCount.mockReturnValue(1);
    ocrDocument.mockResolvedValue({ text: 'ocr', confidence: 0.9, pageCount: 1 });
    // 79 chars is below the threshold, so OCR runs. It is also more than the
    // 40 chars worth keeping, so the result is `pdf-mixed` rather than
    // `pdf-ocr` — the digital text is kept alongside the OCR output. What is
    // asserted is that OCR happened at all.
    extractTextFromPdf.mockResolvedValue({ text: 'a'.repeat(79), totalPages: 1 });
    const below = await extractPdfText(bytes, 'below.pdf');
    expect(below.path).toBe('pdf-mixed');
    expect(ocrDocument).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    getPageCount.mockReturnValue(1);
    ocrDocument.mockResolvedValue({ text: 'ocr', confidence: 0.9, pageCount: 1 });
    // A text layer too thin to be worth keeping at all is the pure OCR path.
    extractTextFromPdf.mockResolvedValue({ text: 'p. 1', totalPages: 1 });
    expect((await extractPdfText(bytes, 'scan.pdf')).path).toBe('pdf-ocr');
  });

  test('keeps a substantial text layer alongside OCR output as the mixed path', async () => {
    // Part-digital, part-scanned documents are common; throwing the digital
    // half away loses text that was free and exact.
    extractTextFromPdf.mockResolvedValue({ text: 'b'.repeat(100), totalPages: 10 });
    const result = await extractPdfText(bytes, 'mixed.pdf');
    expect(result.path).toBe('pdf-mixed');
    expect(result.text).toContain('b'.repeat(100));
    expect(result.text).toContain('ocr text');
  });
});

describe('page splitting', () => {
  test('sends one page at a time, because sync Textract accepts only one', async () => {
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 3 });
    await extractPdfText(bytes, 'scan.pdf');
    expect(copyPages).toHaveBeenCalledTimes(3);
    expect(copyPages.mock.calls.map((call) => call[1])).toEqual([[0], [1], [2]]);
  });

  test('caps OCR at the production limit and says so in the text', async () => {
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 120 });
    const result = await extractPdfText(bytes, 'huge.pdf');
    expect(MAX_OCR_PAGES_PER_DOCUMENT).toBe(50);
    expect(ocrDocument).toHaveBeenCalledTimes(50);
    expect(result.pageCount).toBe(120);
    // The note is indexed with the text, so a reader of a retrieved chunk can
    // tell "not in the document" from "not in the first 50 pages".
    expect(result.text).toContain('only the first 50 of 120 pages were read');
  });

  test('bounds concurrent Textract calls', async () => {
    let inFlight = 0;
    let peak = 0;
    ocrDocument.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      inFlight--;
      return { text: 'page', confidence: 0.9, pageCount: 1 };
    });
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 20 });
    await extractPdfText(bytes, 'scan.pdf');
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('failure handling', () => {
  test('a page that fails does not lose the rest of the document', async () => {
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 3 });
    let call = 0;
    ocrDocument.mockImplementation(async () => {
      call++;
      if (call === 2) {
        throw new Error('page is blank');
      }
      return { text: `page ${call}`, confidence: 0.9, pageCount: 1 };
    });

    const result = await extractPdfText(bytes, 'scan.pdf');
    expect(result.pageErrors).toHaveLength(1);
    expect(result.text).toContain('page');
    expect(result.ocrPages).toBe(2);
  });

  test('an OCR outage stops the remaining pages rather than repeating itself 50 times', async () => {
    // Every remaining page would fail identically. Discovering that once is
    // the point of latching it.
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 50 });
    ocrDocument.mockRejectedValue(new OcrUnavailableError('textract:AnalyzeDocument is not granted'));
    await expect(extractPdfText(bytes, 'scan.pdf')).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(ocrDocument.mock.calls.length).toBeLessThan(10);
  });

  test('an OCR outage still returns whatever the text layer held', async () => {
    extractTextFromPdf.mockResolvedValue({ text: 'c'.repeat(100), totalPages: 10 });
    ocrDocument.mockRejectedValue(new OcrUnavailableError('not granted'));
    const result = await extractPdfText(bytes, 'scan.pdf');
    expect(result.text).toContain('c'.repeat(100));
  });

  test('falls back to pdf-lib for the page count when pdf.js cannot open the file', async () => {
    extractTextFromPdf.mockRejectedValue(new Error('InvalidPDFException'));
    getPageCount.mockReturnValue(2);
    const result = await extractPdfText(bytes, 'encrypted.pdf');
    expect(result.pageCount).toBe(2);
    expect(result.path).toBe('pdf-ocr');
  });

  test('reports a PDF neither library can open', async () => {
    extractTextFromPdf.mockRejectedValue(new Error('InvalidPDFException'));
    getPageCount.mockImplementation(() => {
      throw new Error('xref table is broken');
    });
    await expect(extractPdfText(bytes, 'broken.pdf')).rejects.toThrow(/Could not read PDF broken.pdf/);
  });

  test('reports a PDF with no pages', async () => {
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 0 });
    getPageCount.mockReturnValue(0);
    await expect(extractPdfText(bytes, 'empty.pdf')).rejects.toThrow(/has 0 pages/);
  });

  test('reports an unopenable PDF as its own class, so the caller can skip it', async () => {
    // A thrown `Error` is something the caller retries; this is something it
    // should record and move past. The distinction was only in the wording.
    const { PdfUnreadableError } = await import('./pdf.ts');
    extractTextFromPdf.mockRejectedValue(new Error('InvalidPDFException'));
    getPageCount.mockImplementation(() => {
      throw new Error('xref table is broken');
    });
    await expect(extractPdfText(bytes, 'broken.pdf')).rejects.toBeInstanceOf(PdfUnreadableError);
  });

  test('a scan whose every page was throttled raises the throttle, not an empty document', async () => {
    // Nine pages of a ten-page scan throttling leaves the one page that was
    // read, which is fine. *Every* page throttling used to return an empty
    // string, which the ingest then recorded as "extracted 0 characters" — the
    // same phrase it uses for a genuinely blank page. A rate limit reported as
    // an unreadable document, and the slice that should have been rescheduled
    // carried on.
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 4 });
    ocrDocument.mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));
    await expect(extractPdfText(bytes, 'scan.pdf')).rejects.toMatchObject({ name: 'ThrottlingException' });
  });

  test('but a partly-read scan still returns, because a page is better than nothing', async () => {
    extractTextFromPdf.mockResolvedValue({ text: '', totalPages: 4 });
    let call = 0;
    ocrDocument.mockImplementation(async () => {
      call++;
      if (call > 1) {
        throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      }
      return { text: 'Impression: no acute findings.', confidence: 0.9, pageCount: 1 };
    });
    const result = await extractPdfText(bytes, 'scan.pdf');
    expect(result.text).toContain('no acute findings');
    expect(result.pageErrors).toHaveLength(3);
  });
});
