// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ocrDocument, OcrUnavailableError } from './ocr.ts';
import { MAX_OCR_PAGES_PER_DOCUMENT } from './pdf.ts';

/**
 * TIFF text extraction, by converting each page to PNG first.
 *
 * Textract's synchronous `AnalyzeDocument` rejects raw TIFF with "unsupported
 * document format", whatever AWS's docs say in places. Production solved this
 * with `sharp`, which ships platform-specific native binaries. This worker has
 * deliberately stayed free of those — `unpdf` instead of `pdfjs-dist`, `pdf-lib`
 * for page splitting — so the same objection applies and the answer is a
 * pure-JavaScript decoder rather than a compiled one:
 *
 * - `utif2` decodes TIFF, including every IFD. That matters more than it looks:
 *   clinical TIFFs are overwhelmingly multi-page faxes, and reading only the
 *   first page would index the cover sheet and silently drop the report.
 * - `pngjs` encodes the RGBA back out as PNG, which Textract does accept.
 *
 * Neither has a native binary, so the deploy is unchanged.
 *
 * The OCR loop below is the one in {@link extractPdfText}, deliberately: same
 * concurrency, same page cap, same "one page failing does not lose the
 * document" behaviour. A second shape here would be a second thing to keep
 * correct.
 */

/** Textract calls in flight per document. Matches the PDF path. */
const OCR_CONCURRENCY = 4;

/**
 * Textract's synchronous size ceiling, applied to the *converted* page.
 *
 * A TIFF page is compressed; its PNG is re-compressed from raw RGBA and can
 * land either side of the limit. Checking here rather than letting `ocrDocument`
 * raise means the message names the page and its converted size, which is what
 * tells you whether the document needs the async pipeline or was simply odd.
 */
const SYNC_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

/** Raised when the TIFF cannot be decoded at all. The caller records a skip. */
export class TiffDecodeError extends Error {
  /** @param message - Why the TIFF could not be read. */
  constructor(message: string) {
    super(message);
    this.name = 'TiffDecodeError';
  }
}

export interface TiffExtractResult {
  text: string;
  /** Pages in the TIFF, before the OCR cap is applied. */
  pageCount: number;
  confidence: number;
  /** Pages billed to Textract. */
  ocrPages: number;
  /** Pages that failed individually; the rest of the document still returns. */
  pageErrors?: { page: number; error: string }[];
}

/**
 * Decode one TIFF page to PNG bytes.
 *
 * Exported for the tests, which need to assert the conversion independently of
 * Textract being reachable.
 * @param bytes - The whole TIFF.
 * @param pageIndex - Zero-based page.
 * @returns PNG bytes for that page.
 */
export async function tiffPageToPng(bytes: Buffer, pageIndex: number): Promise<Buffer> {
  const UTIF = await import('utif2');
  const { PNG } = await import('pngjs');

  const pages = UTIF.decode(bytes);
  const page = pages[pageIndex];
  if (!page) {
    throw new TiffDecodeError(`TIFF has no page ${pageIndex + 1}`);
  }

  UTIF.decodeImage(bytes, page);
  const rgba = UTIF.toRGBA8(page);
  const { width, height } = page;
  if (!width || !height) {
    throw new TiffDecodeError(`TIFF page ${pageIndex + 1} decoded to ${width}x${height}`);
  }

  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  return PNG.sync.write(png);
}

/**
 * Extract text from a TIFF.
 * @param bytes - The whole TIFF.
 * @param label - What this document is, for error messages.
 * @returns The text, plus how much of it was billed.
 */
export async function extractTiffText(bytes: Buffer, label: string): Promise<TiffExtractResult> {
  const UTIF = await import('utif2');

  let pageCount: number;
  try {
    pageCount = UTIF.decode(bytes).length;
  } catch (err) {
    throw new TiffDecodeError(`Could not read TIFF ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pageCount === 0) {
    throw new TiffDecodeError(`TIFF ${label} has 0 pages`);
  }

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
        const png = await tiffPageToPng(bytes, page);
        if (png.length > SYNC_SIZE_LIMIT_BYTES) {
          pageErrors.push({
            page: page + 1,
            error:
              `converts to ${(png.length / 1024 / 1024).toFixed(1)} MB of PNG, over Textract's 10 MB ` +
              'synchronous limit',
          });
          continue;
        }
        const result = await ocrDocument(png, `${label} page ${page + 1}`);
        perPage[page] = result.text.trim();
        confidenceSum += result.confidence;
        confidenceCount++;
      } catch (err) {
        if (err instanceof OcrUnavailableError) {
          // Every remaining page would fail identically. Recorded once and the
          // workers wind down, rather than fifty copies of the same line.
          unavailable = err;
          return;
        }
        pageErrors.push({ page: page + 1, error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  await Promise.all(workers);

  // Nothing was read and nothing can be. Unlike a PDF there is no text layer to
  // fall back on, so this is a skip rather than a thin result.
  if (unavailable && confidenceCount === 0) {
    throw unavailable;
  }

  const text = perPage.filter((page) => page.length > 0).join('\n\n');
  if (text.length === 0) {
    throw new TiffDecodeError(
      `TIFF ${label} produced no text across ${pagesToOcr} page(s)` +
        (pageErrors.length > 0 ? `: ${pageErrors.map((e) => `page ${e.page}: ${e.error}`).join('; ')}` : '')
    );
  }

  const truncated =
    pageCount > MAX_OCR_PAGES_PER_DOCUMENT
      ? `\n\n[Note: only the first ${MAX_OCR_PAGES_PER_DOCUMENT} of ${pageCount} pages were read. ` +
        'The remaining pages are not searchable.]'
      : '';

  return {
    text: `${text}${truncated}`.trim(),
    pageCount,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
    ocrPages: confidenceCount,
    ...(pageErrors.length > 0 ? { pageErrors } : {}),
  };
}
