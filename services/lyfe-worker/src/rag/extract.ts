// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ocrDocument, OcrUnavailableError } from './ocr.ts';
import { extractPdfText } from './pdf.ts';
import { extractTiffText, TiffDecodeError } from './tiff.ts';

/**
 * Turning a document's bytes into the text that gets indexed.
 *
 * Content-type dispatch, the metadata header, the chunker and the NUL strip,
 * all ported from the production implementation
 * (`lib/services/document-extraction-service.ts`). The constants are its
 * constants; they were tuned against this corpus and there is no reason to
 * re-derive them.
 *
 * ## The corpus this has to survive
 *
 * Measured over 1,200 of the 2,823 `DocumentReference`s:
 *
 * | contentType     | count | path                                  |
 * | --------------- | ----- | ------------------------------------- |
 * | application/pdf | 734   | text layer, else per-page OCR         |
 * | XML (C-CDA)     | 280   | tag strip, free                       |
 * | *absent*        | 140   | magic-byte sniff, then as above       |
 * | image/jpeg      | 26    | OCR                                   |
 * | HL7 v2          | 12    | read as text                          |
 * | text/plain      | 10    | read as text                          |
 * | image/tiff      | 7     | per-page PNG conversion, then OCR     |
 * | image/png       | 2     | OCR                                   |
 * | text/csv        | 1     | read as text                          |
 *
 * The 140 with no `contentType` are why sniffing is not optional. A seventh of
 * the corpus arrives unlabelled, and guessing from the attachment's filename
 * would be guessing from a field that is often also absent.
 */

/** ~800 tokens of content with ~100 tokens of overlap; chars ≈ tokens × 4. */
export const CHUNK_CHARS = 3200;

/** Overlap between adjacent chunks, so a fact spanning a boundary survives. */
export const CHUNK_OVERLAP = 400;

/** Version stamp written to `document_chunks.extractor`, for audits. */
export const EXTRACTOR_VERSION = 'bedrock-textract-v1.2026-10';

/** Which extractor produced the text. Stored so a cost audit can tell free from billable. */
export type ExtractorPath =
  | 'xml-strip'
  | 'html-strip'
  | 'text-utf8'
  | 'pdf-digital'
  | 'pdf-ocr'
  | 'pdf-mixed'
  | 'image-ocr'
  // Distinct from image-ocr so a cost audit can separate the TIFF pages, which
  // carry a conversion step and are billed per page like any other scan.
  | 'tiff-ocr'
  | 'unknown-utf8';

export interface ExtractedText {
  text: string;
  path: ExtractorPath;
  pageCount: number;
  confidence: number;
  /** Pages billed to Textract. 0 on every free path. */
  ocrPages: number;
}

/**
 * Raised when a document cannot be turned into text, and retrying will not help.
 *
 * Distinct from a thrown `Error`, which the ingest retries. A skip is recorded
 * against the document with its reason and the run carries on — the whole point
 * of the degradation requirement. Today it covers two cases:
 *
 * - **OCR unavailable.** Textract permissions missing, or a document over the
 *   10 MB synchronous limit.
 * - **A TIFF that will not decode**, or whose every page failed. TIFF itself is
 *   no longer a blanket skip: `tiff.ts` converts each page to PNG in pure
 *   JavaScript, because Textract's synchronous API rejects raw TIFF and the
 *   `sharp` that production used for this ships native binaries the worker has
 *   deliberately stayed free of.
 */
export class ExtractSkipped extends Error {
  /** @param message - Why this document cannot be indexed. */
  constructor(message: string) {
    super(message);
    this.name = 'ExtractSkipped';
  }
}

/** The FHIR-derived fields that become the indexed header. */
export interface DocumentMetadata {
  title: string | null;
  documentType: string | null;
  /** ISO date, `YYYY-MM-DD` or a full timestamp. */
  documentDate: string | null;
  source: string | null;
}

/**
 * Build the header prepended to every document before chunking.
 *
 * This is the single highest-value line in the pipeline and it is easy to
 * mistake for decoration. Many clinical PDFs — radiology orders, consent forms,
 * prior authorisations — hold their entire clinical meaning in the *title*
 * while the body is a generic template that never repeats it. "FIBROSCAN
 * RADIOLOGY ORDER" is the document; the body is boilerplate.
 *
 * Without the header, asking "is there a fibroscan order?" embeds a query that
 * matches nothing in the indexed body, and the model answers "no" about a
 * document that is sitting right there. Prepending the metadata puts the title
 * inside the embedded text, so the document is retrievable by the name a human
 * would call it.
 * @param meta - The document's FHIR metadata.
 * @returns The header block, or an empty string when there is no metadata.
 */
export function buildMetadataHeader(meta: DocumentMetadata): string {
  const parts: string[] = [];
  if (meta.title) {
    parts.push(`TITLE: ${meta.title.trim()}`);
  }
  if (meta.documentType) {
    parts.push(`DOCUMENT TYPE: ${meta.documentType.trim()}`);
  }
  if (meta.documentDate) {
    parts.push(`DOCUMENT DATE: ${meta.documentDate.slice(0, 10)}`);
  }
  if (meta.source) {
    parts.push(`SOURCE: ${meta.source}`);
  }
  return parts.length > 0 ? `[DOCUMENT METADATA]\n${parts.join('\n')}\n[END METADATA]` : '';
}

export interface Chunk {
  index: number;
  text: string;
  tokenEstimate: number;
}

/**
 * Split text into overlapping windows, preferring sentence boundaries.
 *
 * Two passes, and the second is not redundant:
 *
 * 1. Accumulate sentences until the window would exceed {@link CHUNK_CHARS},
 *    then emit and carry the last {@link CHUNK_OVERLAP} characters forward. A
 *    naive character window slices mid-sentence and the embedding of
 *    "…patient denies chest" means something other than the sentence it came
 *    from.
 * 2. Hard-cap every emitted chunk at {@link CHUNK_CHARS}. C-CDA XML stripped of
 *    its tags has almost no sentence-ending punctuation, so pass one can
 *    produce a single "sentence" of 100k characters — past the embedding
 *    model's input ceiling. This is the safety net that makes the ceiling
 *    unreachable, and it is the reason 280 C-CDA documents index at all.
 * @param text - The full document text, header included.
 * @returns Chunks in document order.
 */
export function chunkText(text: string): Chunk[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  // Sentence split that keeps terminal punctuation attached and only breaks
  // where the next sentence plausibly starts — a capital or a digit. Splitting
  // on every period would break "Dr. Chen" and "1.5 mg".
  const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-Z0-9])/g);
  const windows: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > CHUNK_CHARS && current.length > 0) {
      windows.push(current.trim());
      current = `${current.slice(-CHUNK_OVERLAP)} ${sentence}`;
    } else {
      current = current.length ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim().length > 0) {
    windows.push(current.trim());
  }

  const chunks: Chunk[] = [];
  for (const window of windows) {
    if (window.length <= CHUNK_CHARS) {
      chunks.push(toChunk(chunks.length, window));
      continue;
    }
    for (let offset = 0; offset < window.length; offset += CHUNK_CHARS - CHUNK_OVERLAP) {
      chunks.push(toChunk(chunks.length, window.slice(offset, offset + CHUNK_CHARS)));
      if (offset + CHUNK_CHARS >= window.length) {
        break;
      }
    }
  }
  return chunks;
}

/**
 * Build one chunk.
 * @param index - Its position in the document.
 * @param text - Its text.
 * @returns The chunk.
 */
function toChunk(index: number, text: string): Chunk {
  // chars/4 — the same approximation the chunk size itself is derived from.
  // Stored for cost reporting, never used to make a decision.
  return { index, text, tokenEstimate: Math.round(text.length / 4) };
}

/**
 * Strip NUL bytes.
 *
 * Postgres `text` rejects `0x00` with error 22021, "invalid byte sequence for
 * encoding UTF8: 0x00". OCR output, PDF text layers and the decode-as-UTF-8
 * fallback can all contain them. Stripped once here, before chunking, so every
 * chunk derived from this string is covered by the same pass.
 * @param text - The text to clean.
 * @returns The text without NUL bytes.
 */
export function stripNullBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x00/g, '');
}

/**
 * Turn bytes into text, choosing the extractor from the content type.
 *
 * The declared `contentType` is a hint, not an instruction: 140 of 1,200
 * documents have none, and a wrong label is worse than no label. Every branch
 * is therefore `declared type OR magic bytes`, so a PDF labelled
 * `application/octet-stream` still goes to the PDF path.
 * @param bytes - The document.
 * @param contentType - The declared content type, when there is one.
 * @param label - What this document is, for error messages.
 * @returns The extracted text and which path produced it.
 */
export async function extractText(bytes: Buffer, contentType: string | null, label: string): Promise<ExtractedText> {
  const declared = (contentType ?? '').toLowerCase().trim();

  // XML before everything else. C-CDA is 280 documents and its payload is
  // plain text wrapped in tags — no OCR, no cost, and the richest clinical
  // content in the corpus.
  if (declared.includes('xml') || sniffXml(bytes)) {
    return asText(stripMarkup(bytes.toString('utf-8')), 'xml-strip');
  }
  if (declared.includes('html') || sniffHtml(bytes)) {
    return asText(stripMarkup(bytes.toString('utf-8')), 'html-strip');
  }
  // Covers text/plain, text/csv, and the 12 HL7 v2 messages — which arrive as
  // `x-application/hl7-v2+er7` or similar and are pipe-delimited text. Indexed
  // raw rather than parsed: the segment text is what a question would match,
  // and an HL7 parser here would be a second mapping layer to keep correct.
  if (declared.startsWith('text/') || declared.includes('hl7') || declared === 'application/json') {
    return asText(bytes.toString('utf-8'), 'text-utf8');
  }

  if (declared === 'application/pdf' || sniffPdf(bytes)) {
    const result = await extractPdfText(bytes, label);
    return {
      text: result.text,
      path: result.path,
      pageCount: result.pageCount,
      confidence: result.confidence,
      ocrPages: result.ocrPages,
    };
  }

  // TIFF is checked before the general image branch because it cannot go
  // straight to Textract — each page is converted to PNG first. See tiff.ts.
  if (declared === 'image/tiff' || sniffTiff(bytes)) {
    try {
      const result = await extractTiffText(bytes, label);
      return {
        text: result.text,
        path: 'tiff-ocr',
        pageCount: result.pageCount,
        confidence: result.confidence,
        ocrPages: result.ocrPages,
      };
    } catch (err) {
      // A TIFF that cannot be decoded, or that OCR cannot reach, is a skip the
      // ingest records against the document — not a throw it retries, because
      // neither condition improves on a second attempt.
      if (err instanceof TiffDecodeError || err instanceof OcrUnavailableError) {
        throw new ExtractSkipped(err.message);
      }
      throw err;
    }
  }

  if (declared.startsWith('image/') || sniffPng(bytes) || sniffJpeg(bytes)) {
    try {
      const result = await ocrDocument(bytes, label);
      return {
        text: result.text,
        path: 'image-ocr',
        pageCount: result.pageCount,
        confidence: result.confidence,
        ocrPages: result.pageCount || 1,
      };
    } catch (err) {
      if (err instanceof OcrUnavailableError) {
        throw new ExtractSkipped(err.message);
      }
      throw err;
    }
  }

  // Last resort for the unlabelled remainder whose magic bytes matched nothing.
  // Decoding binary as UTF-8 yields noise, which is why the caller drops a
  // document whose extracted text is too short to be real.
  return asText(bytes.toString('utf-8'), 'unknown-utf8');
}

/**
 * Wrap plain text in the common result shape.
 * @param text - The text.
 * @param path - Which extractor produced it.
 * @returns The result.
 */
function asText(text: string, path: ExtractorPath): ExtractedText {
  // confidence 1 because the text is exact, not recognised. The ingest records
  // it as null for free paths so a quality audit is not fooled by this
  // sentinel into thinking OCR was perfect.
  return { text: text.trim(), path, pageCount: 1, confidence: 1, ocrPages: 0 };
}

/**
 * Strip XML or HTML markup down to its text.
 *
 * One function for both, as production had it: C-CDA and HTML need the same
 * treatment, and keeping them as one implementation means they cannot drift.
 * @param markup - The raw document.
 * @returns The text content.
 */
export function stripMarkup(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Magic-byte sniffers. Each reads only the first few bytes, which is all a
// format signature occupies.

/**
 * @param bytes - The document.
 * @returns True when it opens with an XML declaration.
 */
function sniffXml(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('utf-8').trim().startsWith('<?xml');
}

/**
 * @param bytes - The document.
 * @returns True when an HTML element appears in the first 256 bytes.
 */
function sniffHtml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString('utf-8').toLowerCase();
  return head.includes('<html') || head.includes('<!doctype html');
}

/**
 * @param bytes - The document.
 * @returns True for `%PDF`.
 */
function sniffPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString('ascii') === '%PDF';
}

/**
 * @param bytes - The document.
 * @returns True for the PNG signature.
 */
function sniffPng(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString('hex') === '89504e47';
}

/**
 * @param bytes - The document.
 * @returns True for a JPEG SOI marker.
 */
function sniffJpeg(bytes: Buffer): boolean {
  return bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
}

/**
 * @param bytes - The document.
 * @returns True for little- or big-endian TIFF.
 */
function sniffTiff(bytes: Buffer): boolean {
  const signature = bytes.subarray(0, 4).toString('hex');
  return signature === '49492a00' || signature === '4d4d002a';
}
