// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as OcrModule from './ocr.ts';
import type * as PdfModule from './pdf.ts';
import type * as TiffModule from './tiff.ts';

/**
 * The extraction half of the RAG pipeline.
 *
 * What is pinned here is what the index's quality actually rests on: that a
 * chunk never exceeds the embedding model's input, that consecutive chunks
 * overlap so a fact on a boundary survives, that the metadata header is in the
 * embedded text, and that dispatch picks the right extractor when the declared
 * content type is absent or wrong — which it is for 140 of the 1,200 sampled
 * documents.
 */

const ocrDocument = vi.fn();
const extractPdfText = vi.fn();
const extractTiffText = vi.fn();

vi.mock('./ocr.ts', async () => {
  const actual = await vi.importActual<typeof OcrModule>('./ocr.ts');
  return { ...actual, ocrDocument: (...args: unknown[]) => ocrDocument(...args) };
});

// `PdfUnreadableError` is kept real, like `TiffDecodeError` below, because the
// dispatch checks it with `instanceof` and a stub class would let the test pass
// against an implementation that checks for something else.
vi.mock('./pdf.ts', async () => {
  const actual = await vi.importActual<typeof PdfModule>('./pdf.ts');
  return {
    extractPdfText: (...args: unknown[]) => extractPdfText(...args),
    PdfUnreadableError: actual.PdfUnreadableError,
    DIGITAL_TEXT_YIELD_THRESHOLD_CHARS_PER_PAGE: 80,
    MAX_OCR_PAGES_PER_DOCUMENT: 50,
  };
});

// `TiffDecodeError` is kept real so the dispatch tests can throw the error the
// production code actually checks with `instanceof`.
vi.mock('./tiff.ts', async () => {
  const actual = await vi.importActual<typeof TiffModule>('./tiff.ts');
  return { ...actual, extractTiffText: (...args: unknown[]) => extractTiffText(...args) };
});

const {
  buildMetadataHeader,
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  chunkText,
  ExtractSkipped,
  extractText,
  stripMarkup,
  stripNullBytes,
} = await import('./extract.ts');

describe('chunkText', () => {
  test('returns nothing for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  test('keeps a short document in one chunk', () => {
    const chunks = chunkText('Patient denies chest pain. Vitals stable.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toBe('Patient denies chest pain. Vitals stable.');
  });

  test('never emits a chunk longer than CHUNK_CHARS', () => {
    // Realistic prose: many sentences, each far shorter than the window, so
    // the sentence pass does the splitting.
    const text = Array.from({ length: 400 }, (_, i) => `Observation number ${i} was recorded today.`).join(' ');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  test('hard-caps a single punctuation-free blob, which is what C-CDA looks like stripped', () => {
    // 280 of the sampled documents are C-CDA. Stripped of tags they have
    // almost no sentence-ending punctuation, so the sentence pass yields ONE
    // enormous "sentence". Without the second pass this would be a single
    // 100k-character chunk, well past the embedding model's input ceiling.
    const blob = 'x'.repeat(100_000);
    const chunks = chunkText(blob);
    expect(chunks.length).toBeGreaterThan(30);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
    }
  });

  test('consecutive hard-capped chunks overlap by CHUNK_OVERLAP characters', () => {
    // The overlap is the reason a fact spanning a boundary is still findable.
    // Asserted on the character path because its stride is exact.
    const blob = 'abcdefghij'.repeat(2000);
    const chunks = chunkText(blob);
    expect(chunks.length).toBeGreaterThan(2);
    const tail = chunks[0].text.slice(-CHUNK_OVERLAP);
    expect(chunks[1].text.startsWith(tail)).toBe(true);
  });

  test('carries overlap across a sentence boundary too', () => {
    const sentence = `${'word '.repeat(100)}end.`;
    const chunks = chunkText(Array.from({ length: 20 }, () => sentence).join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk opens with the tail of the first, not with fresh text.
    const previousTail = chunks[0].text.slice(-CHUNK_OVERLAP).trim();
    expect(chunks[1].text.startsWith(previousTail.slice(0, 40))).toBe(true);
  });

  test('indexes chunks consecutively from zero', () => {
    const chunks = chunkText('y'.repeat(20_000));
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_chunk, i) => i));
  });

  test('does not split on a period inside an abbreviation or a dose', () => {
    const text = 'Dr. Chen prescribed 1.5 mg daily.';
    expect(chunkText(text)).toHaveLength(1);
  });

  test('estimates tokens at four characters each', () => {
    const [chunk] = chunkText('a'.repeat(400));
    expect(chunk.tokenEstimate).toBe(100);
  });
});

describe('buildMetadataHeader', () => {
  test('puts the title in the indexed text, which is the whole point', () => {
    // A radiology order's clinical meaning is its title; the body is a generic
    // template that never repeats it. Without this header the document is
    // unfindable by the name a human would search for.
    const header = buildMetadataHeader({
      title: 'FIBROSCAN RADIOLOGY ORDER',
      documentType: 'Radiology order',
      documentDate: '2026-03-14T09:30:00Z',
      source: 'MEDPLUM',
    });
    expect(header).toContain('[DOCUMENT METADATA]');
    expect(header).toContain('TITLE: FIBROSCAN RADIOLOGY ORDER');
    expect(header).toContain('DOCUMENT TYPE: Radiology order');
    expect(header).toContain('SOURCE: MEDPLUM');
    expect(header).toContain('[END METADATA]');
  });

  test('truncates a FHIR instant to its date part', () => {
    const header = buildMetadataHeader({
      title: null,
      documentType: null,
      documentDate: '2026-03-14T09:30:00.123Z',
      source: null,
    });
    expect(header).toContain('DOCUMENT DATE: 2026-03-14');
    expect(header).not.toContain('09:30');
  });

  test('omits absent fields rather than writing empty labels', () => {
    const header = buildMetadataHeader({
      title: 'Discharge summary',
      documentType: null,
      documentDate: null,
      source: null,
    });
    expect(header).toBe('[DOCUMENT METADATA]\nTITLE: Discharge summary\n[END METADATA]');
  });

  test('is empty when there is no metadata at all, so nothing is prepended', () => {
    expect(buildMetadataHeader({ title: null, documentType: null, documentDate: null, source: null })).toBe('');
  });

  test('the header survives into the first chunk', () => {
    const header = buildMetadataHeader({
      title: 'FIBROSCAN RADIOLOGY ORDER',
      documentType: null,
      documentDate: null,
      source: null,
    });
    const chunks = chunkText(`${header}\n\nGeneric consent form body text.`);
    expect(chunks[0].text).toContain('FIBROSCAN RADIOLOGY ORDER');
  });
});

describe('stripNullBytes', () => {
  test('removes NUL, which Postgres text columns reject with error 22021', () => {
    expect(stripNullBytes('before\u0000after')).toBe('beforeafter');
  });
});

describe('stripMarkup', () => {
  test('pulls the text out of C-CDA, unwrapping CDATA and decoding entities', () => {
    const ccda =
      '<?xml version="1.0"?><ClinicalDocument><!-- a comment -->' +
      '<title>Discharge Summary</title><text><![CDATA[Blood pressure 120/80]]></text>' +
      '<note>Smith &amp; Jones &lt;clinic&gt;</note></ClinicalDocument>';
    const text = stripMarkup(ccda);
    expect(text).toContain('Discharge Summary');
    expect(text).toContain('Blood pressure 120/80');
    // Entities are decoded AFTER tags are stripped, so `&lt;clinic&gt;` ends
    // up as literal angle brackets in the indexed text. That is intentional
    // and harmless — this text is embedded, never rendered as markup — but it
    // means "contains no `<`" is the wrong way to assert tags are gone.
    expect(text).toContain('Smith & Jones <clinic>');
    expect(text).not.toContain('<ClinicalDocument');
    expect(text).not.toContain('<title>');
    expect(text).not.toContain('a comment');
  });

  test('decodes numeric entities', () => {
    expect(stripMarkup('<p>caf&#233;</p>')).toBe('café');
  });
});

describe('extractText dispatch', () => {
  beforeEach(() => {
    // Call counts are assertions here — "did this reach Textract" is how the
    // free paths are told from the billable ones — so they must not carry
    // over between tests.
    vi.clearAllMocks();
  });

  /**
   * @param text - Body to wrap.
   * @returns The bytes.
   */
  function bytes(text: string): Buffer {
    return Buffer.from(text, 'utf-8');
  }

  test('routes a declared XML content type to the free tag strip', async () => {
    const result = await extractText(bytes('<root><a>hello</a></root>'), 'application/xml', 'doc');
    expect(result.path).toBe('xml-strip');
    expect(result.text).toBe('hello');
    // The free paths must report zero OCR pages, or a cost audit reads them as
    // billable Textract work.
    expect(result.ocrPages).toBe(0);
    expect(ocrDocument).not.toHaveBeenCalled();
  });

  test('sniffs XML when contentType is absent — 140 of 1,200 documents have none', async () => {
    const result = await extractText(bytes('<?xml version="1.0"?><ClinicalDocument>hi</ClinicalDocument>'), null, 'd');
    expect(result.path).toBe('xml-strip');
  });

  test('sniffs HTML', async () => {
    const result = await extractText(bytes('<!DOCTYPE html><html><body>note</body></html>'), null, 'd');
    expect(result.path).toBe('html-strip');
    expect(result.text).toBe('note');
  });

  test('reads text/plain as text', async () => {
    const result = await extractText(bytes('plain clinical note'), 'text/plain', 'd');
    expect(result.path).toBe('text-utf8');
    expect(result.text).toBe('plain clinical note');
  });

  test('reads an HL7 v2 message as text rather than parsing it', async () => {
    const hl7 = 'MSH|^~\\&|LAB|HOSP|||202603140930||ORU^R01|1|P|2.5\rOBX|1|NM|GLU||98|mg/dL';
    const result = await extractText(bytes(hl7), 'x-application/hl7-v2+er7', 'd');
    expect(result.path).toBe('text-utf8');
    expect(result.text).toContain('GLU');
  });

  test('reads CSV as text', async () => {
    const result = await extractText(bytes('date,value\n2026-01-01,5'), 'text/csv', 'd');
    expect(result.path).toBe('text-utf8');
  });

  test('sniffs a PDF by magic bytes even when mislabelled as octet-stream', async () => {
    extractPdfText.mockResolvedValue({
      text: 'pdf body',
      pageCount: 3,
      confidence: 1,
      path: 'pdf-digital',
      ocrPages: 0,
    });
    const result = await extractText(Buffer.from('%PDF-1.7\nbody'), 'application/octet-stream', 'd');
    expect(result.path).toBe('pdf-digital');
    expect(result.pageCount).toBe(3);
    expect(extractPdfText).toHaveBeenCalled();
  });

  test('sends a PNG to OCR', async () => {
    ocrDocument.mockResolvedValue({ text: 'scanned words', confidence: 0.94, pageCount: 1 });
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]);
    const result = await extractText(png, null, 'd');
    expect(result.path).toBe('image-ocr');
    expect(result.text).toBe('scanned words');
    expect(result.ocrPages).toBe(1);
  });

  test('sends a JPEG to OCR', async () => {
    ocrDocument.mockResolvedValue({ text: 'jpeg words', confidence: 0.9, pageCount: 1 });
    const jpeg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from('rest')]);
    expect((await extractText(jpeg, 'image/jpeg', 'd')).path).toBe('image-ocr');
  });

  test('sends TIFF down the conversion path, not straight to Textract', async () => {
    // Textract's synchronous API rejects raw TIFF with "unsupported document
    // format", so a TIFF has to reach OCR as PNG. Pinned here as dispatch; the
    // conversion itself is tiff.test.ts's subject.
    extractTiffText.mockResolvedValue({ text: 'fax words', pageCount: 2, confidence: 0.9, ocrPages: 2 });
    const tiff = Buffer.concat([Buffer.from('49492a00', 'hex'), Buffer.from('rest')]);
    const result = await extractText(tiff, 'image/tiff', 'scan.tif');
    expect(result.path).toBe('tiff-ocr');
    expect(result.text).toBe('fax words');
    expect(result.ocrPages).toBe(2);
    // The raw TIFF must never be handed to Textract.
    expect(ocrDocument).not.toHaveBeenCalled();
  });

  test('detects TIFF by magic bytes when the content type is absent', async () => {
    extractTiffText.mockResolvedValue({ text: 'big-endian fax', pageCount: 1, confidence: 0.8, ocrPages: 1 });
    // 4d4d002a is big-endian TIFF. A seventh of the corpus arrives unlabelled,
    // so sniffing has to cover both byte orders.
    const tiff = Buffer.concat([Buffer.from('4d4d002a', 'hex'), Buffer.from('rest')]);
    expect((await extractText(tiff, null, 'scan.tif')).path).toBe('tiff-ocr');
  });

  test('turns an undecodable TIFF into a skip, so the run carries on', async () => {
    const { TiffDecodeError } = await import('./tiff.ts');
    extractTiffText.mockRejectedValue(new TiffDecodeError('uncommon compression'));
    const tiff = Buffer.concat([Buffer.from('49492a00', 'hex'), Buffer.from('rest')]);
    await expect(extractText(tiff, 'image/tiff', 'scan.tif')).rejects.toBeInstanceOf(ExtractSkipped);
  });

  test('a TIFF whose OCR is unavailable is a skip, not a retried throw', async () => {
    const { OcrUnavailableError } = await import('./ocr.ts');
    extractTiffText.mockRejectedValue(new OcrUnavailableError('textract:AnalyzeDocument is not granted'));
    const tiff = Buffer.concat([Buffer.from('49492a00', 'hex'), Buffer.from('rest')]);
    await expect(extractText(tiff, 'image/tiff', 'scan.tif')).rejects.toBeInstanceOf(ExtractSkipped);
  });

  test('turns an OCR outage into a skip, not a crash', async () => {
    const { OcrUnavailableError } = await import('./ocr.ts');
    ocrDocument.mockRejectedValue(new OcrUnavailableError('textract:AnalyzeDocument is not granted'));
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]);
    // A skip, so the run records this document and carries on with the C-CDA
    // and plain-text documents that need no OCR at all.
    await expect(extractText(png, 'image/png', 'd')).rejects.toBeInstanceOf(ExtractSkipped);
  });

  // The PDF branch was the one extractor that did not translate its permanent
  // failures into `ExtractSkipped`, so the identical condition — Textract out of
  // reach — was recorded as `skipped` for a TIFF two tests above and as `failed`
  // for a PDF. PDFs are 734 of the 1,200 sampled documents, which is how that
  // asymmetry became most of a batch's unexplained failures.
  test('a scanned PDF whose OCR is unavailable is a skip, exactly as a TIFF is', async () => {
    const { OcrUnavailableError } = await import('./ocr.ts');
    extractPdfText.mockRejectedValue(new OcrUnavailableError('textract:AnalyzeDocument is not granted'));
    await expect(extractText(bytes('%PDF-1.7 scan'), 'application/pdf', 'referral.pdf')).rejects.toBeInstanceOf(
      ExtractSkipped
    );
  });

  test('names the reason on the skip, so a count can be broken down afterwards', async () => {
    const { OcrUnavailableError } = await import('./ocr.ts');
    extractPdfText.mockRejectedValue(new OcrUnavailableError('textract:AnalyzeDocument is not granted'));
    await expect(extractText(bytes('%PDF-1.7 scan'), 'application/pdf', 'referral.pdf')).rejects.toMatchObject({
      code: 'ocr-unavailable',
    });
  });

  test('a PDF that will not open is a skip with its own reason, not a failure', async () => {
    // Encrypted or truncated. Permanent: the next attempt reads the same bytes.
    const { PdfUnreadableError } = await import('./pdf.ts');
    extractPdfText.mockRejectedValue(new PdfUnreadableError('Could not read PDF chart.pdf: xref table is broken'));
    await expect(extractText(bytes('%PDF-1.7 broken'), 'application/pdf', 'chart.pdf')).rejects.toMatchObject({
      name: 'ExtractSkipped',
      code: 'pdf-unreadable',
    });
  });

  test('a throttled PDF still escapes, because that one is the run’s problem', async () => {
    // The counterpart to the two above: translating *everything* the PDF path
    // throws into a skip would file a Textract rate limit as a document nobody
    // can read, which is the mirror image of the bug being fixed.
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    extractPdfText.mockRejectedValue(throttled);
    await expect(extractText(bytes('%PDF-1.7 scan'), 'application/pdf', 'referral.pdf')).rejects.not.toBeInstanceOf(
      ExtractSkipped
    );
  });

  test('falls back to a UTF-8 decode when nothing matches', async () => {
    const result = await extractText(bytes('bare words, no signature'), null, 'd');
    expect(result.path).toBe('unknown-utf8');
  });
});
