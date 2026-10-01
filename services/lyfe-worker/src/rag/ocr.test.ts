// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * OCR, mocked at the AWS SDK boundary.
 *
 * The behaviour worth pinning is the degradation the brief asked for: the AWS
 * credentials on this service were provisioned for Bedrock, and whether the
 * same IAM identity holds `textract:AnalyzeDocument` is not known until
 * runtime. If it does not, the wrong outcome is 734 PDFs each retried six
 * times against the same AccessDeniedException.
 */

const send = vi.fn();

vi.mock('@aws-sdk/client-textract', () => ({
  TextractClient: class {
    send = (...args: unknown[]): unknown => send(...args);
  },
  AnalyzeDocumentCommand: class {
    input: unknown;
    /** @param input - The command input. */
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const { getOcrUnavailableReason, ocrDocument, OcrUnavailableError, __resetOcrState } = await import('./ocr.ts');

/**
 * An AWS error with a given SDK error name.
 * @param name - The SDK error name.
 * @param message - The message.
 * @returns The error.
 */
function awsError(name: string, message = 'denied'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetOcrState();
});

describe('ocrDocument', () => {
  test('reads LINE blocks in page then top-to-bottom order', async () => {
    // Textract returns blocks in no guaranteed order, and reading a clinical
    // form out of order scrambles which value belongs to which label.
    send.mockResolvedValue({
      Blocks: [
        { BlockType: 'LINE', Text: 'second', Page: 1, Geometry: { BoundingBox: { Top: 0.5 } } },
        { BlockType: 'LINE', Text: 'first', Page: 1, Geometry: { BoundingBox: { Top: 0.1 } } },
        { BlockType: 'LINE', Text: 'next page', Page: 2, Geometry: { BoundingBox: { Top: 0.1 } } },
        { BlockType: 'PAGE' },
        { BlockType: 'PAGE' },
      ],
    });
    const result = await ocrDocument(Buffer.from('bytes'), 'scan.png');
    expect(result.text).toBe('first\nsecond\nnext page');
    expect(result.pageCount).toBe(2);
  });

  test('asks for FORMS and TABLES, which is what enables handwriting OCR', async () => {
    // Dropping to DetectDocumentText would be cheaper and would stop reading
    // handwritten notes, which on a clinical corpus is the wrong trade.
    send.mockResolvedValue({ Blocks: [] });
    await ocrDocument(Buffer.from('bytes'), 'scan.png');
    const command = send.mock.calls[0][0] as { input: { FeatureTypes: string[] } };
    expect(command.input.FeatureTypes).toEqual(['FORMS', 'TABLES']);
  });

  test('averages word confidence onto a 0-1 scale', async () => {
    send.mockResolvedValue({
      Blocks: [
        { BlockType: 'WORD', Confidence: 90 },
        { BlockType: 'WORD', Confidence: 80 },
      ],
    });
    expect((await ocrDocument(Buffer.from('b'), 'd')).confidence).toBeCloseTo(0.85);
  });

  test('refuses a document over the synchronous size limit, without calling AWS', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    await expect(ocrDocument(big, 'huge.pdf')).rejects.toBeInstanceOf(OcrUnavailableError);
    await expect(ocrDocument(big, 'huge.pdf')).rejects.toThrow(/10 MB synchronous limit/);
    expect(send).not.toHaveBeenCalled();
  });

  test('an oversized document does not disable OCR for everything else', async () => {
    await expect(ocrDocument(Buffer.alloc(11 * 1024 * 1024), 'huge.pdf')).rejects.toThrow();
    expect(getOcrUnavailableReason()).toBeUndefined();

    send.mockResolvedValue({ Blocks: [{ BlockType: 'LINE', Text: 'fine' }] });
    expect((await ocrDocument(Buffer.from('small'), 'ok.png')).text).toBe('fine');
  });
});

describe('degradation when Textract is not permitted', () => {
  for (const name of ['AccessDeniedException', 'UnrecognizedClientException', 'InvalidSignatureException']) {
    test(`latches on ${name} so the next document does not rediscover it`, async () => {
      send.mockRejectedValue(awsError(name));
      await expect(ocrDocument(Buffer.from('b'), 'one.png')).rejects.toBeInstanceOf(OcrUnavailableError);
      expect(getOcrUnavailableReason()).toContain('Textract is not available');

      // The second document refuses without reaching AWS at all.
      await expect(ocrDocument(Buffer.from('b'), 'two.png')).rejects.toBeInstanceOf(OcrUnavailableError);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }

  test('says plainly what is missing and what still works', async () => {
    send.mockRejectedValue(
      awsError('AccessDeniedException', 'User is not authorized to perform: textract:AnalyzeDocument')
    );
    await expect(ocrDocument(Buffer.from('b'), 'one.png')).rejects.toThrow(/textract:AnalyzeDocument appears not/);
    const reason = getOcrUnavailableReason() ?? '';
    expect(reason).toContain('recorded as skipped');
    // The point of degrading rather than failing: C-CDA XML and plain text
    // need no OCR, and between them they are most of the corpus.
    expect(reason).toContain('C-CDA XML, plain text');
  });

  test('does NOT latch on throttling, which is transient and must stay retryable', async () => {
    send.mockRejectedValue(awsError('ThrottlingException', 'Rate exceeded'));
    await expect(ocrDocument(Buffer.from('b'), 'one.png')).rejects.toThrow(/Rate exceeded/);
    expect(getOcrUnavailableReason()).toBeUndefined();

    send.mockResolvedValue({ Blocks: [{ BlockType: 'LINE', Text: 'recovered' }] });
    expect((await ocrDocument(Buffer.from('b'), 'two.png')).text).toBe('recovered');
  });

  test('does NOT latch on an unsupported format, which is one document’s problem', async () => {
    send.mockRejectedValue(awsError('UnsupportedDocumentException', 'unsupported document format'));
    await expect(ocrDocument(Buffer.from('b'), 'one.tif')).rejects.not.toBeInstanceOf(OcrUnavailableError);
    expect(getOcrUnavailableReason()).toBeUndefined();
  });

  test('latches on a credentials failure that arrives as a plain Error', async () => {
    send.mockRejectedValue(new Error('Could not load credentials from any providers'));
    await expect(ocrDocument(Buffer.from('b'), 'one.png')).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(getOcrUnavailableReason()).toBeDefined();
  });
});
