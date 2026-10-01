// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Embedding, mocked at the AWS SDK boundary.
 *
 * Two things are worth pinning here and both are silent failures if they
 * break:
 *
 * - **Order.** Titan embeds one string per call and this module issues those
 *   calls concurrently. If the results were collected in completion order
 *   rather than input order, every chunk would be stored with a neighbour's
 *   embedding, retrieval would return confidently wrong documents, and nothing
 *   anywhere would raise an error.
 * - **Concurrency.** The batch is 100 as a unit of work but is NOT one request,
 *   because Bedrock has no batch endpoint. The bound on in-flight calls is what
 *   stops a long document from drawing throttling.
 */

const send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = (...args: unknown[]): unknown => send(...args);
  },
  InvokeModelCommand: class {
    input: unknown;
    /** @param input - The command input. */
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const { embedText, embedTexts, EMBED_BATCH_SIZE, EMBED_CONCURRENCY, EMBEDDING_MODEL, __resetBedrockClient } =
  await import('./bedrock.ts');
const { EMBEDDING_DIMENSIONS } = await import('./schema.ts');

/**
 * A Titan response body carrying a recognisable vector.
 * @param seed - First element, so a vector can be traced to its input.
 * @returns What the SDK would hand back.
 */
function titanResponse(seed: number): { body: Uint8Array } {
  const embedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
  embedding[0] = seed;
  return { body: new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 4 })) };
}

/**
 * Read the `inputText` out of a recorded command.
 * @param call - The recorded call index.
 * @returns The text that was embedded.
 */
function sentText(call: number): string {
  const command = send.mock.calls[call][0] as { input: { body: string } };
  return (JSON.parse(command.input.body) as { inputText: string }).inputText;
}

describe('embedText', () => {
  beforeEach(() => {
    send.mockReset();
    __resetBedrockClient();
  });

  test('asks Titan for exactly the dimensions the column is declared at', async () => {
    send.mockResolvedValue(titanResponse(1));
    await embedText('chest pain');

    const command = send.mock.calls[0][0] as { input: { modelId: string; body: string } };
    expect(command.input.modelId).toBe(EMBEDDING_MODEL);
    const body = JSON.parse(command.input.body) as Record<string, unknown>;
    expect(body.inputText).toBe('chest pain');
    expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(body.normalize).toBe(true);
  });

  test('is Titan, not OpenAI — 1024 dims, no gateway', () => {
    expect(EMBEDDING_MODEL).toBe('amazon.titan-embed-text-v2:0');
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
  });

  test('rejects a vector of the wrong width before it reaches the insert', async () => {
    // Otherwise this surfaces as a Postgres error about one row, a long way
    // from the model that caused it.
    send.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1, 2, 3] })) });
    await expect(embedText('hi')).rejects.toThrow(/returned 3 dimensions, expected 1024/);
  });

  test('rejects a response with no embedding at all', async () => {
    send.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ message: 'nope' })) });
    await expect(embedText('hi')).rejects.toThrow(/returned no embedding/);
  });

  test('refuses empty input rather than storing a zero vector', async () => {
    // A zero vector is equidistant from everything, so it wins or loses
    // rankings arbitrarily. Better to fail the chunk.
    await expect(embedText('   ')).rejects.toThrow(/Cannot embed empty text/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('embedTexts', () => {
  beforeEach(() => {
    send.mockReset();
    __resetBedrockClient();
  });

  test('returns nothing for no input, without calling Bedrock', async () => {
    expect(await embedTexts([])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  test('issues one call per text, because Titan has no batch endpoint', async () => {
    // This is the documented divergence from the production implementation,
    // which batched 100 inputs into a single OpenAI request.
    let seed = 0;
    send.mockImplementation(async () => titanResponse(++seed));
    await embedTexts(['a', 'b', 'c']);
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('preserves input order even when calls complete out of order', async () => {
    // The whole correctness of the index rests on this. Responses are resolved
    // in reverse order of dispatch to make the failure mode reachable.
    const pending: { text: string; resolve: (value: unknown) => void }[] = [];
    send.mockImplementation(
      (command: { input: { body: string } }) =>
        new Promise((resolve) => {
          pending.push({ text: (JSON.parse(command.input.body) as { inputText: string }).inputText, resolve });
        })
    );

    const texts = ['first', 'second', 'third', 'fourth'];
    const promise = embedTexts(texts);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    // Resolve last-dispatched first, each vector tagged with its own index.
    for (const entry of [...pending].reverse()) {
      entry.resolve(titanResponse(texts.indexOf(entry.text)));
    }

    const embeddings = await promise;
    expect(embeddings.map((embedding) => embedding[0])).toEqual([0, 1, 2, 3]);
  });

  test('keeps at most EMBED_CONCURRENCY calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    send.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      inFlight--;
      return titanResponse(1);
    });

    await embedTexts(new Array(40).fill('clinical text'));
    expect(peak).toBeLessThanOrEqual(EMBED_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  test('keeps the proven batch size of 100 as the unit of work', () => {
    // Carried from the production implementation. There it was one request;
    // here it is 100 calls collected together. The number is kept so the
    // failure attribution boundary is the same.
    expect(EMBED_BATCH_SIZE).toBe(100);
  });

  test('spans more than one batch without losing or reordering anything', async () => {
    const total = EMBED_BATCH_SIZE + 25;
    const texts = Array.from({ length: total }, (_unused, i) => `chunk ${i}`);
    send.mockImplementation(async (command: { input: { body: string } }) => {
      const text = (JSON.parse(command.input.body) as { inputText: string }).inputText;
      return titanResponse(Number(text.split(' ')[1]));
    });

    const embeddings = await embedTexts(texts);
    expect(embeddings).toHaveLength(total);
    expect(embeddings.map((embedding) => embedding[0])).toEqual(texts.map((_unused, i) => i));
    expect(send).toHaveBeenCalledTimes(total);
  });

  test('a failing input fails the whole call rather than silently shortening the result', async () => {
    // Production dropped empty inputs, which made the output array shorter
    // than the input and left the caller to notice. Here each vector has to
    // line up with a chunk row, so a short array would mis-file every chunk
    // after the gap.
    send.mockRejectedValue(new Error('ThrottlingException'));
    await expect(embedTexts(['a', 'b'])).rejects.toThrow(/Throttling/);
  });

  test('truncates an oversized chunk rather than failing the document', async () => {
    send.mockResolvedValue(titanResponse(1));
    await embedText('z'.repeat(60_000));
    expect(sentText(0).length).toBe(30_000);
  });
});
