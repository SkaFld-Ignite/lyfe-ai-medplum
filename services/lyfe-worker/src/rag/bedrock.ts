// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EMBEDDING_DIMENSIONS } from './schema.ts';

/**
 * Embeddings, via Bedrock.
 *
 * ## Why Bedrock and not what production uses
 *
 * The production Next.js app embeds with OpenAI `text-embedding-3-small` at
 * 1536 dimensions, routed through the Vercel AI Gateway. That path does not
 * exist here and should not be recreated: it needs a gateway key this service
 * does not have, and adding an OpenAI dependency to get embeddings when the
 * worker already holds AWS credentials would be a new vendor for no new
 * capability.
 *
 * Medplum's own `$ai` operation is not an option either. It has no embeddings
 * endpoint at all — it proxies chat completions — and it is gated behind a
 * project feature flag plus an API key that has not been issued.
 *
 * So: Bedrock, with the credentials already on the Railway service.
 *
 * ## Titan embeds one string per call
 *
 * This is the one place the production implementation does not port across, and
 * it is worth being precise about why.
 *
 * OpenAI's embeddings endpoint accepts an array and returns an array, so
 * `embedTexts` there batched 100 inputs into **one** HTTP request. Bedrock's
 * `InvokeModel` has no array form: the Titan request body is a single
 * `inputText`, and `amazon.titan-embed-text-v2:0` returns a single `embedding`.
 * There is no batch API to call.
 *
 * {@link EMBED_BATCH_SIZE} is therefore kept at 100 — the proven number — but
 * it now means something different. It is the number of embeddings in flight as
 * a unit of work, issued as 100 individual calls with
 * {@link EMBED_CONCURRENCY} of them outstanding at a time. The batch boundary
 * is still where ordering is re-established and where a failure is attributed,
 * which is what the number was really doing in the original.
 *
 * ## Order matters more than it looks
 *
 * A chunk's embedding is stored against that chunk's text. If the returned
 * vectors were reordered, every chunk would carry a neighbour's meaning and
 * retrieval would return confidently wrong documents — silently, with no error
 * anywhere. So results are written back into a pre-sized array by index rather
 * than pushed, and the final length is asserted against the input.
 */

/** The embedding model. Verified answering from this worker's credentials. */
export const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';

/** The chat model, named here so the one place that knows model ids is this one. */
export const CHAT_MODEL = 'global.anthropic.claude-sonnet-4-6';

/**
 * Embeddings per unit of work.
 *
 * 100, carried over from the production implementation. There it was one
 * request; here it is 100 requests whose results are collected together. See
 * the note above on why the number is kept and what it now means.
 */
export const EMBED_BATCH_SIZE = 100;

/**
 * How many Titan calls are outstanding at once.
 *
 * Bedrock's on-demand quota for Titan embeddings is per-account and shared with
 * everything else using it. 8 keeps a 100-chunk batch to roughly a dozen round
 * trips without being the reason something else in the account gets throttled.
 */
export const EMBED_CONCURRENCY = 8;

/**
 * Titan V2's documented input ceiling, in characters.
 *
 * The model's limit is 8,192 tokens; at the ~4 chars-per-token ratio the
 * chunker already assumes, that is ~32k characters. The cap is set below it and
 * applied as a truncation rather than an error: a chunk this large means the
 * chunker's hard cap did not hold, and losing the tail of one oversized chunk
 * is better than failing a document over it.
 */
const MAX_INPUT_CHARS = 30_000;

let client: BedrockRuntimeClient | undefined;

/**
 * The shared Bedrock client.
 *
 * Credentials are left to the SDK's default provider chain, which reads
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from the environment — already
 * set on the Railway service. Not read explicitly, so that an instance role or
 * a session token works without a code change.
 * @returns The client.
 */
function getClient(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return client;
}

/** Titan V2's response body. */
interface TitanEmbeddingResponse {
  embedding?: number[];
  inputTextTokenCount?: number;
}

/**
 * Embed one string.
 *
 * `normalize: true` is requested because the retrieval query ranks with `<=>`,
 * pgvector's cosine distance. Cosine is scale-invariant so normalising is not
 * strictly required for correctness, but asking the model for unit vectors
 * keeps the stored values comparable with anything that later uses inner
 * product, and costs nothing.
 * @param text - The text to embed.
 * @returns A 1024-dimension embedding.
 */
export async function embedText(text: string): Promise<number[]> {
  const input = text.trim().slice(0, MAX_INPUT_CHARS);
  if (!input) {
    throw new Error('Cannot embed empty text');
  }

  const response = await getClient().send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: input, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body)) as TitanEmbeddingResponse;
  const embedding = body.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(`${EMBEDDING_MODEL} returned no embedding`);
  }
  // Checked rather than trusted. The column is `vector(1024)`; a mismatch
  // surfaces at insert time as a Postgres error about one row, which is a long
  // way from the model that caused it.
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${EMBEDDING_MODEL} returned ${embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
        'The document_chunks.embedding column is fixed at that width.'
    );
  }
  return embedding;
}

/**
 * Embed many strings, preserving order.
 *
 * Batched at {@link EMBED_BATCH_SIZE} with {@link EMBED_CONCURRENCY} calls in
 * flight. Unlike the production version this does **not** drop empty inputs:
 * dropping them there made the returned array shorter than the input and the
 * caller compared lengths to catch it. Here each chunk's vector has to line up
 * with that chunk's row, so an input that cannot be embedded is a failure of
 * the whole call rather than a silent shortening.
 * @param texts - The texts, in the order their rows will be written.
 * @returns One embedding per input, in the same order.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const out: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const end = Math.min(start + EMBED_BATCH_SIZE, texts.length);
    let next = start;
    // A fixed pool of workers pulling from a shared cursor, rather than
    // `Promise.all` over the whole batch — which would open 100 connections to
    // Bedrock at once and draw throttling that looks like a model error.
    const workers = Array.from({ length: Math.min(EMBED_CONCURRENCY, end - start) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= end) {
          return;
        }
        out[index] = await embedText(texts[index]);
      }
    });
    await Promise.all(workers);
  }

  if (out.some((embedding) => !embedding)) {
    throw new Error(`Embedding returned ${out.filter(Boolean).length} of ${texts.length} vectors`);
  }
  return out;
}

/** Test seam: drop the memoised client so a mock can take its place. */
export function __resetBedrockClient(): void {
  client = undefined;
}
