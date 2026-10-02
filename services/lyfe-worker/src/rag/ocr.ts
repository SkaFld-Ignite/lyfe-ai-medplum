// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { AnalyzeDocumentCommand, TextractClient } from '@aws-sdk/client-textract';

/**
 * OCR, via Textract's synchronous `AnalyzeDocument`.
 *
 * Ported from the production implementation, with one behaviour added that the
 * original did not need: **this worker assumes it might not be allowed to call
 * Textract at all.**
 *
 * The AWS credentials on the Railway service were provisioned for Bedrock. That
 * Bedrock works says nothing about whether the same IAM user holds
 * `textract:AnalyzeDocument`, and the first time anyone finds out is at runtime.
 * The wrong way to find out is 734 PDFs each retried six times against
 * `AccessDeniedException`, which costs an hour and reports as "RAG is broken".
 *
 * So the first permission failure latches {@link ocrUnavailableReason}, and from
 * then on every OCR call refuses immediately. The ingest treats that refusal as
 * "this document is not text-extractable" and carries on with the formats that
 * are — the 280 C-CDA XML documents, the plain text, and the PDFs with a real
 * text layer, which between them are most of the corpus. Degraded, visibly, and
 * recorded per document so the gap is countable rather than mysterious.
 */

/**
 * Textract's synchronous size ceiling.
 *
 * 10 MB, and not negotiable on this API. Above it Textract requires
 * `StartDocumentAnalysis`, which reads from S3 and polls — a different pipeline
 * needing a bucket this service does not have. A document over the limit is
 * reported as skipped with the size in the message.
 */
const SYNC_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Set once a Textract call fails for a reason retrying cannot fix.
 *
 * Module-level and deliberately sticky: the point is that the second document
 * does not repeat the first one's discovery.
 */
let ocrUnavailableReason: string | undefined;

/** Raised when OCR cannot run, as distinct from OCR running and finding nothing. */
export class OcrUnavailableError extends Error {
  /** @param message - Why OCR cannot run. */
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

let client: TextractClient | undefined;

/**
 * The shared Textract client.
 * @returns The client.
 */
function getClient(): TextractClient {
  client ??= new TextractClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return client;
}

/**
 * Whether OCR has been established as unavailable.
 * @returns The latched reason, or undefined while OCR is believed to work.
 */
export function getOcrUnavailableReason(): string | undefined {
  return ocrUnavailableReason;
}

/**
 * Does this error mean "you may never call Textract", rather than "not now"?
 *
 * Matched on the SDK's error name rather than the message, because these are
 * the names the SDK sets and they do not vary with wording. `ThrottlingException`
 * and `ProvisionedThroughputExceededException` are deliberately absent — those
 * are transient and must stay retryable.
 * @param err - The thrown error.
 * @returns True when the failure is a permission or configuration problem.
 */
function isPermanentOcrFailure(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  if (
    [
      'AccessDeniedException',
      'UnrecognizedClientException',
      'InvalidSignatureException',
      'AuthFailure',
      'CredentialsProviderError',
      'UnauthorizedException',
    ].includes(name)
  ) {
    return true;
  }
  // The region not having Textract, or the endpoint not resolving, is also
  // permanent for this deployment — and surfaces as a plain Error.
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /could not load credentials|security token.*invalid|is not authorized to perform/.test(message);
}

/**
 * Does this error mean "not now", rather than "not ever"?
 *
 * The counterpart to {@link isPermanentOcrFailure}, and it exists because the
 * pair was only half-implemented. `ThrottlingException` and
 * `ProvisionedThroughputExceededException` are deliberately excluded from the
 * permanent list so they stay retryable — but nothing downstream recognised
 * them, because the ingest classified failures by matching the error *message*
 * and Textract's throttle message is `Rate exceeded`, which contains neither
 * "throttl" nor "429". So the one class of failure the OCR layer took care to
 * mark retryable was the one recorded as permanently failed.
 *
 * Matched on `name` and on `$metadata.httpStatusCode`, both of which the AWS
 * SDK sets on every service error, rather than on prose that varies by service
 * and by release.
 * @param err - The thrown error.
 * @returns True when a retry is the right response.
 */
export function isTransientAwsFailure(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  if (
    [
      'ThrottlingException',
      'ThrottledException',
      'ProvisionedThroughputExceededException',
      'TooManyRequestsException',
      'LimitExceededException',
      'RequestLimitExceeded',
      'ServiceUnavailableException',
      'ServiceUnavailable',
      'InternalServerError',
      'InternalServerException',
      'ModelTimeoutException',
      'ModelNotReadyException',
      'RequestTimeout',
      'RequestTimeoutException',
      'TimeoutError',
    ].includes(name)
  ) {
    return true;
  }
  // The SDK's own retry classification, when the service set one.
  if ((err as { $retryable?: unknown })?.$retryable) {
    return true;
  }
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

export interface OcrResult {
  /** Text from LINE blocks, in reading order. */
  text: string;
  /** Mean word-level confidence, 0–1. */
  confidence: number;
  /** Pages Textract reported. */
  pageCount: number;
}

/**
 * OCR one document's bytes.
 *
 * `FeatureTypes: ['FORMS', 'TABLES']` is kept from the production
 * implementation — not because the form and table structures are stored here
 * (they are not; only the text is embedded), but because those flags are what
 * turn on handwriting recognition. Dropping to `DetectDocumentText` would be
 * cheaper and would stop reading handwritten notes, which on a clinical corpus
 * is the wrong trade.
 * @param bytes - The document, PDF or image, one page for a PDF.
 * @param label - What is being read, for error messages.
 * @returns The extracted text and confidence.
 */
export async function ocrDocument(bytes: Buffer, label: string): Promise<OcrResult> {
  if (ocrUnavailableReason) {
    throw new OcrUnavailableError(ocrUnavailableReason);
  }
  if (bytes.length > SYNC_SIZE_LIMIT_BYTES) {
    throw new OcrUnavailableError(
      `${label} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over Textract's 10 MB synchronous limit. ` +
        'Larger documents need StartDocumentAnalysis, which reads from S3 — no bucket is provisioned for this worker.'
    );
  }

  let response;
  try {
    response = await getClient().send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: bytes },
        FeatureTypes: ['FORMS', 'TABLES'],
      })
    );
  } catch (err) {
    if (isPermanentOcrFailure(err)) {
      const message = err instanceof Error ? err.message : String(err);
      ocrUnavailableReason =
        `Textract is not available to this worker's IAM identity: ${message}. ` +
        'The AWS credentials on this service were provisioned for Bedrock; textract:AnalyzeDocument appears not ' +
        'to be granted. Scanned PDFs and images will be recorded as skipped and not indexed. Text-extractable ' +
        'documents (C-CDA XML, plain text, PDFs with a text layer) are unaffected.';
      console.error('lyfe-rag OCR disabled:', ocrUnavailableReason);
      throw new OcrUnavailableError(ocrUnavailableReason);
    }
    throw err;
  }

  const blocks = response.Blocks ?? [];

  // LINE blocks, ordered by page then vertical position. Textract returns
  // blocks in no guaranteed order, and reading a clinical form out of order
  // scrambles which value belongs to which label.
  const text = blocks
    .filter((block) => block.BlockType === 'LINE')
    .sort((a, b) => {
      const pageA = a.Page ?? 1;
      const pageB = b.Page ?? 1;
      if (pageA !== pageB) {
        return pageA - pageB;
      }
      return (a.Geometry?.BoundingBox?.Top ?? 0) - (b.Geometry?.BoundingBox?.Top ?? 0);
    })
    .map((block) => block.Text ?? '')
    .filter(Boolean)
    .join('\n');

  const words = blocks.filter((block) => block.BlockType === 'WORD');
  const confidence = words.length
    ? words.reduce((sum, block) => sum + (block.Confidence ?? 0), 0) / words.length / 100
    : 0;

  return {
    text,
    confidence,
    pageCount: blocks.filter((block) => block.BlockType === 'PAGE').length || 1,
  };
}

/** Test seam: clear the latched reason and the memoised client. */
export function __resetOcrState(): void {
  ocrUnavailableReason = undefined;
  client = undefined;
}
