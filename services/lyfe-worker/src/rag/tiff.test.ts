// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as OcrModule from './ocr.ts';

/**
 * TIFF conversion and OCR.
 *
 * Textract itself is mocked. It is a billable network call, and what matters
 * here is which bytes reach it and how the pages are assembled — not Textract's
 * own recognition.
 *
 * ## Two kinds of fixture, because one kind was not enough
 *
 * {@link makeTiff} builds TIFFs with `utif2`, the library that then decodes
 * them. Those cover the page *assembly* — ordering, the cap, per-page failure —
 * which is what they are good at, and they are kept for that.
 *
 * What they cannot cover is whether the decoder handles what arrives. A
 * `utif2` round trip proves `utif2` agrees with itself, and it agreed with
 * itself all the way through a production run that failed on 45 of one
 * patient's 45 TIFFs. So `__fixtures__/` holds TIFFs written by **libtiff**,
 * via ImageMagick and `tiffcp`, in the compressions the real corpus measured:
 *
 * | compression              | photometric | bits | of the 45 |
 * | ------------------------ | ----------- | ---- | --------- |
 * | CCITT Group 4 (T.6) fax  | WhiteIsZero | 1    | 34        |
 * | LZW                      | RGB         | 8    | 11        |
 *
 * Those two account for all 45. The fixtures assert their own tags, so
 * regenerating one with a different encoder fails here rather than silently
 * putting the round trip back.
 *
 * And {@link describe}`('module interop')` runs the module in a **child Node
 * process**, because the bug it guards cannot be reproduced in this one: Vite
 * synthesizes named exports for CommonJS and Node does not, so every test in
 * this file passed while production could not call `UTIF.decode` at all.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

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

/**
 * Read a fixture written by libtiff, not by `utif2`.
 * @param name - File name inside `__fixtures__`.
 * @returns The TIFF bytes.
 */
function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

/**
 * Count the dark pixels on each row of a decoded PNG.
 *
 * The assertion that matters is *where the ink landed*. "It returned a PNG"
 * passes for an all-white page, and an all-white page is exactly what a decoder
 * that silently mishandles a compression tends to produce.
 * @param png - PNG bytes.
 * @returns Dark pixels per row, top to bottom.
 */
function darkPixelsPerRow(png: Buffer): number[] {
  const image = PNG.sync.read(png);
  const rows: number[] = [];
  for (let y = 0; y < image.height; y++) {
    let dark = 0;
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4] < 128) {
        dark++;
      }
    }
    rows.push(dark);
  }
  return rows;
}

describe('the compressions the real corpus actually contains', () => {
  // Every fixture here is 64x32: white, a full-width black bar across rows
  // 8–15, and a 16px black square at rows 20–27. Encoded by libtiff, so the
  // bitstream is the one a fax machine or a scanner emits.
  const BAR_AND_SQUARE = [
    ...Array(8).fill(0),
    ...Array(8).fill(64),
    ...Array(4).fill(0),
    ...Array(8).fill(16),
    ...Array(4).fill(0),
  ];

  test('CCITT Group 4 bilevel fax — 34 of the 45 — decodes to the right ink', async () => {
    const png = await tiffPageToPng(fixture('ccitt-g4-bilevel.tif'), 0);

    expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
    expect(darkPixelsPerRow(png)).toEqual(BAR_AND_SQUARE);
  });

  test('LZW RGB scan — the other 11 — decodes to the right ink', async () => {
    const png = await tiffPageToPng(fixture('lzw-rgb.tif'), 0);

    expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
    expect(darkPixelsPerRow(png)).toEqual(BAR_AND_SQUARE);
  });

  test('a multi-page Group 4 fax yields a different page per index', async () => {
    const bytes = fixture('ccitt-g4-bilevel-2page.tif');

    // Page 1 is barred at the top, page 2 at the bottom. If the page index were
    // ignored — the shape of bug that indexes a cover sheet 10 times — these
    // would be equal.
    expect(darkPixelsPerRow(await tiffPageToPng(bytes, 0))).toEqual([...Array(8).fill(64), ...Array(24).fill(0)]);
    expect(darkPixelsPerRow(await tiffPageToPng(bytes, 1))).toEqual([...Array(24).fill(0), ...Array(8).fill(64)]);
  });

  test('the fixtures are still in the compressions they are here to represent', () => {
    // Guards the fixtures themselves. Regenerating one through `utif2`, or
    // through an encoder that defaults to no compression, would put the round
    // trip back and nothing above would notice.
    // Tags: 259 compression, 262 photometric, 258 bits/sample, 277 samples/pixel.
    const profile = (tiff: Buffer, page = 0): (number | undefined)[] => {
      const ifd = UTIF.decode(tiff)[page] as unknown as Record<string, number[] | undefined>;
      return ['t259', 't262', 't258', 't277'].map((tag) => ifd[tag]?.[0]);
    };

    expect(profile(fixture('ccitt-g4-bilevel.tif'))).toEqual([4, 0, 1, 1]);
    expect(profile(fixture('lzw-rgb.tif'))).toEqual([5, 2, 8, 3]);

    const twoPage = fixture('ccitt-g4-bilevel-2page.tif');
    expect([profile(twoPage, 0)[0], profile(twoPage, 1)[0]]).toEqual([4, 4]);
  });
});

describe('module interop', () => {
  /**
   * This suite is the one that would have caught the production failure, and it
   * has to leave this process to do it.
   *
   * `utif2` is CommonJS. Vite synthesizes named exports for CommonJS, so inside
   * Vitest `(await import('utif2')).decode` is a function. Node does not, so
   * under the Railway start command — `node node_modules/tsx/dist/cli.mjs …` —
   * the same expression is `undefined`. Every test above passed against a
   * worker that could not decode a single TIFF.
   *
   * So the check runs the real module under plain Node, through `tsx`, exactly
   * as the service does. Nothing is mocked and Textract is never reached:
   * `tiffPageToPng` stops at the PNG.
   */
  const run = promisify(execFile);

  test('converts a Group 4 fax under Node’s own ESM loader, not just Vite’s', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tiff-interop-'));
    const script = path.join(dir, 'convert.mjs');
    writeFileSync(
      script,
      [
        'const { tiffPageToPng } = await import(process.argv[2]);',
        "const { readFileSync } = await import('node:fs');",
        'const png = await tiffPageToPng(readFileSync(process.argv[3]), 0);',
        "console.log(JSON.stringify({ signature: png.subarray(0, 8).toString('hex'), bytes: png.length }));",
      ].join('\n')
    );

    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', script, path.join(FIXTURES, '..', 'tiff.ts'), path.join(FIXTURES, 'ccitt-g4-bilevel.tif')],
      { cwd: path.dirname(FIXTURES) }
    );

    // Before the fix this child exits non-zero on
    // `TypeError: UTIF.decode is not a function`, which `promisify(execFile)`
    // turns into a rejection — so the assertion never runs and the test fails.
    expect(JSON.parse(stdout.trim())).toMatchObject({ signature: PNG_SIGNATURE });
  }, 60_000);
});
