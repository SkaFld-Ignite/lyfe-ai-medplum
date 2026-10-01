// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { PDFDocument as PdfLibDocument } from 'pdf-lib';
import { ocrDocument, OcrUnavailableError } from './ocr.ts';

/**
 * PDF text extraction: cheapest path first.
 *
 * PDFs are 734 of the 1,200 sampled documents, so this path decides whether the
 * index is mostly free or mostly a Textract bill.
 *
 * 1. **Native text.** Most clinical PDFs — orders, intake forms, anything
 *    generated rather than scanned — carry a real text layer. Reading it costs
 *    nothing and is exact.
 * 2. **Per-page OCR.** Below
 *    {@link DIGITAL_TEXT_YIELD_THRESHOLD_CHARS_PER_PAGE} characters per page the
 *    PDF is a scan wearing a PDF container, and the text layer is empty or
 *    decorative. Each page is split out as its own single-page PDF and sent to
 *    Textract, because Textract's synchronous API accepts one page at a time.
 *
 * Both constants are taken unchanged from the production implementation
 * (`lib/integrations/pdf/pdf-extractor.ts`), where they were tuned against this
 * same corpus.
 *
 * ## Deviation from production: which PDF libraries
 *
 * Production used `pdf-parse` for the text layer, with a prominent warning that
 * importing it eagerly crashes any route that touches it — `pdfjs-dist`
 * references `DOMMatrix` at module load, which does not exist in Node — so it
 * had to be dynamically imported to keep it out of the eager graph.
 *
 * This uses `unpdf` instead, which exists to solve exactly that: a DOM-free
 * pdf.js build for server runtimes. The footgun is removed rather than worked
 * around, and it is a tenth the install size. `pdf-lib` is kept for page
 * splitting, as production had it, because it is pure JavaScript and nothing
 * else splits a PDF.
 */

/**
 * Characters per page below which the PDF is treated as a scan.
 *
 * 80, from production. Worth knowing why a threshold is needed at all rather
 * than "is the text layer empty": scanned PDFs frequently carry a *little*
 * text — a header stamp, a fax banner, a page number — so "length > 0" sends
 * image-only documents down the free path and indexes three words of a ten-page
 * report.
 */
export const DIGITAL_TEXT_YIELD_THRESHOLD_CHARS_PER_PAGE = 80;

/**
 * Cap on Textract pages per document.
 *
 * 50, from production, where the note was cost: Textract is billed per page, so
 * one stray 500-page PDF is a surprise on the invoice. The cap also keeps a
 * single document inside the Inngest step budget, which matters more here —
 * 50 pages at OCR_CONCURRENCY 4 is a few minutes, 500 would blow the 12-minute
 * ceiling and kill the step.
 */
export const MAX_OCR_PAGES_PER_DOCUMENT = 50;

/** Textract calls in flight per document. From production. */
const OCR_CONCURRENCY = 4;

/** How much native text counts as worth keeping alongside OCR output. */
const MIXED_PATH_MIN_DIGITAL_CHARS = 40;

export type PdfPath = 'pdf-digital' | 'pdf-ocr' | 'pdf-mixed';

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  confidence: number;
  path: PdfPath;
  /** Pages that went to Textract. 0 on the digital path. */
  ocrPages: number;
  /** Pages that failed individually; the rest of the document still returns. */
  pageErrors?: { page: number; error: string }[];
}

/**
 * Extract text from a PDF.
 * @param bytes - The whole PDF.
 * @param label - What this document is, for error messages.
 * @returns The text, plus which path produced it.
 */
export async function extractPdfText(bytes: Buffer, label: string): Promise<PdfExtractResult> {
  // Both libraries are imported dynamically and ONCE per document, here at the
  // top rather than at each use. Dynamically because neither is needed unless
  // a PDF actually arrives, and keeping them out of the eager import graph is
  // what the production implementation had to do to avoid loading pdf.js into
  // every route. Once, because `extractSinglePage` runs per page — a 50-page
  // scan was issuing 50 `await import('pdf-lib')` calls, which Node resolves
  // from cache but which still schedules 50 microtask round trips for no
  // reason, and makes the page workers racy under a module mock.
  const { extractText } = await import('unpdf');
  const { PDFDocument } = await import('pdf-lib');

  let digitalText = '';
  let pageCount = 0;
  try {
    const result = await extractText(new Uint8Array(bytes), { mergePages: true });
    digitalText = (result.text ?? '').trim();
    pageCount = result.totalPages ?? 0;
  } catch {
    // Encrypted, truncated, or otherwise unreadable by pdf.js. Page count comes
    // from pdf-lib below and the document goes down the OCR path, which often
    // succeeds where the text layer could not be parsed.
  }

  if (pageCount === 0) {
    try {
      const document = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
      pageCount = document.getPageCount();
    } catch (err) {
      throw new Error(`Could not read PDF ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (pageCount === 0) {
    throw new Error(`PDF ${label} has 0 pages`);
  }

  if (digitalText.length / pageCount >= DIGITAL_TEXT_YIELD_THRESHOLD_CHARS_PER_PAGE) {
    return { text: digitalText, pageCount, confidence: 1, path: 'pdf-digital', ocrPages: 0 };
  }

  // ---- The text layer was thin. OCR the pages.
  const pagesToOcr = Math.min(pageCount, MAX_OCR_PAGES_PER_DOCUMENT);
  const perPage: string[] = new Array(pagesToOcr).fill('');
  const pageErrors: { page: number; error: string }[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let unavailable: OcrUnavailableError | undefined;

  let nextPage = 0;
  const workers = Array.from({ length: Math.min(OCR_CONCURRENCY, pagesToOcr) }, async () => {
    for (;;) {
      const page = nextPage++;
      if (page >= pagesToOcr || unavailable) {
        return;
      }
      try {
        const single = await extractSinglePage(PDFDocument, bytes, page);
        const result = await ocrDocument(single, `${label} page ${page + 1}`);
        perPage[page] = result.text.trim();
        confidenceSum += result.confidence;
        confidenceCount++;
      } catch (err) {
        if (err instanceof OcrUnavailableError) {
          // Every remaining page would fail the same way. Recorded once and the
          // workers wind down, rather than fifty identical entries.
          unavailable = err;
          return;
        }
        pageErrors.push({ page: page + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  await Promise.all(workers);

  if (unavailable && confidenceCount === 0) {
    // Nothing was read and nothing can be. If the text layer held anything at
    // all it is better than nothing; otherwise the caller records a skip.
    if (digitalText.length === 0) {
      throw unavailable;
    }
  }

  const ocrText = perPage.filter((text) => text.length > 0).join('\n\n');
  const truncated =
    pageCount > MAX_OCR_PAGES_PER_DOCUMENT
      ? `\n\n[Note: only the first ${MAX_OCR_PAGES_PER_DOCUMENT} of ${pageCount} pages were read. ` +
        'The remaining pages are not searchable.]'
      : '';
  const keepDigital = digitalText.length > MIXED_PATH_MIN_DIGITAL_CHARS;
  const text = `${keepDigital ? `${digitalText}\n\n${ocrText}` : ocrText}${truncated}`.trim();

  return {
    text,
    pageCount,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
    path: keepDigital ? 'pdf-mixed' : 'pdf-ocr',
    ocrPages: confidenceCount,
    ...(pageErrors.length > 0 ? { pageErrors } : {}),
  };
}

/**
 * Copy one page out of a PDF into a fresh single-page PDF.
 *
 * Needed because Textract's synchronous `AnalyzeDocument` accepts a one-page
 * PDF and nothing longer. The multi-page path is `StartDocumentAnalysis`, which
 * reads from S3 — no bucket is provisioned for this worker, so splitting here
 * is how a 20-page scan gets read at all.
 * @param PDFDocument - pdf-lib's document class, loaded once by the caller.
 * @param bytes - The source PDF.
 * @param pageIndex - Zero-based page to extract.
 * @returns A single-page PDF.
 */
async function extractSinglePage(
  PDFDocument: typeof PdfLibDocument,
  bytes: Buffer,
  pageIndex: number
): Promise<Buffer> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
  const destination = await PDFDocument.create();
  const [page] = await destination.copyPages(source, [pageIndex]);
  destination.addPage(page);
  // `useObjectStreams: false` keeps the output a plain cross-reference table.
  // Textract has been seen to reject object-stream PDFs as malformed.
  return Buffer.from(await destination.save({ useObjectStreams: false }));
}
