// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The summary bot's two paths.
 *
 * The streaming one is the riskiest thing in the Spaces wiring: it is the only place the bot writes
 * raw bytes onto an HTTP response, and every way of getting it wrong is silent. Headers committed
 * before the upstream call means a rejection can never be reported as an error. A missing `[DONE]`
 * leaves the browser reading a stream that never ends. A frame written in the wrong shape is simply
 * skipped by the reader and the narration arrives empty.
 *
 * The buffered path is not a fallback nobody takes: `sendToBotStreaming` switches to it on the
 * response content type, so it runs wherever `streamingEnabled` is off or the runtime cannot stream.
 */
import type { BotEvent, BotResponseStream, MedplumClient } from '@medplum/core';
import type { Communication, Parameters } from '@medplum/fhirtypes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { handler } from './ai-resource-summary-sse.ts';

const PROMPT: Communication = {
  resourceType: 'Communication',
  status: 'completed',
  id: 'prompt-2',
  meta: { project: 'project-1' },
  payload: [{ contentString: 'Summarize clearly.' }],
};

let posts: Parameters[];

/**
 * A Medplum client stubbed down to what the bot touches.
 * @returns The stub, typed as a MedplumClient.
 */
function stubClient(): MedplumClient {
  return {
    get: async () => ({ project: { id: 'project-1' } }),
    searchResources: async () => [PROMPT],
    fhirUrl: (...path: string[]) => new URL(`https://example.com/fhir/R4/${path.join('/')}`),
    getAccessToken: () => 'test-token',
    post: async (_url: string, body: Parameters) => {
      posts.push(body);
      return { resourceType: 'Parameters', parameter: [{ name: 'content', valueString: 'Buffered answer.' }] };
    },
  } as unknown as MedplumClient;
}

/** Records everything written to the response, plus when the headers were committed. */
interface RecordingStream {
  readonly stream: BotResponseStream;
  readonly writes: string[];
  readonly started: { statusCode: number; headers: Record<string, string> }[];
}

/**
 * A BotResponseStream that records rather than writing to a socket.
 * @returns The stream and its recordings.
 */
function recordingStream(): RecordingStream {
  const writes: string[] = [];
  const started: { statusCode: number; headers: Record<string, string> }[] = [];
  const stream = {
    startStreaming: (statusCode: number, headers: Record<string, string>) => started.push({ statusCode, headers }),
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as BotResponseStream;
  return { stream, writes, started };
}

/**
 * The bot event the Provider UI produces.
 * @param responseStream - The response stream, when the caller asked for SSE.
 * @param messages - The conversation, defaulting to a single question with no tool responses.
 * @returns A BotEvent.
 */
function event(
  responseStream?: BotResponseStream,
  messages: unknown[] = [{ role: 'user', content: 'summarize' }]
): BotEvent {
  return {
    bot: { reference: 'Bot/1' },
    contentType: 'application/fhir+json',
    secrets: {},
    requester: { reference: 'Practitioner/abc-123' },
    responseStream,
    input: {
      resourceType: 'Parameters',
      parameter: [
        { name: 'messages', valueString: JSON.stringify(messages) },
        { name: 'model', valueString: 'gpt-5.5' },
        { name: 'reasoning_effort', valueString: 'high' },
      ],
    },
  };
}

/**
 * Stubs global fetch with an SSE response built from the given body.
 * @param body - The raw SSE body, split into however many chunks.
 * @param ok - Whether the response is a success.
 * @param status - The HTTP status.
 */
function stubSseFetch(body: string[], ok = true, status = 200): void {
  const encoder = new TextEncoder();
  vi.stubGlobal('fetch', async () => {
    let index = 0;
    return {
      ok,
      status,
      text: async () => 'upstream said no',
      body: {
        getReader: () => ({
          read: async () =>
            index < body.length ? { done: false, value: encoder.encode(body[index++]) } : { done: true },
        }),
      },
    };
  });
}

beforeEach(() => {
  posts = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streaming', () => {
  test('commits SSE headers, forwards each content frame, and terminates with [DONE]', async () => {
    stubSseFetch(['data: {"content":"Mar"}\n\n', 'data: {"content":"ia is 42."}\n\ndata: [DONE]\n\n']);
    const recording = recordingStream();

    const result = await handler(stubClient(), event(recording.stream));

    // Nothing is returned: the HTTP response is already finished, and `executeHandler` ends it on
    // `res.headersSent` without looking at a value.
    expect(result).toBeUndefined();
    expect(recording.started).toStrictEqual([
      {
        statusCode: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      },
    ]);
    expect(recording.writes).toStrictEqual([
      'data: {"content":"Mar"}\n\n',
      'data: {"content":"ia is 42."}\n\n',
      'data: [DONE]\n\n',
    ]);
  });

  test('re-frames one content key per frame, dropping the raw and tool_calls frames $ai also sends', async () => {
    stubSseFetch([
      'data: {"raw":{"id":"chunk-1"}}\n\ndata: {"content":"ok"}\n\ndata: {"tool_calls":[]}\n\ndata: [DONE]\n\n',
    ]);
    const recording = recordingStream();

    await handler(stubClient(), event(recording.stream));
    expect(recording.writes).toStrictEqual(['data: {"content":"ok"}\n\n', 'data: [DONE]\n\n']);
  });

  test('passes a mid-stream error on, and still terminates', async () => {
    // By this point the 200 is long gone, so in-band is the only way to report it at all.
    stubSseFetch(['data: {"content":"part"}\n\ndata: {"error":"OpenAI API error: 500"}\n\ndata: [DONE]\n\n']);
    const recording = recordingStream();

    await handler(stubClient(), event(recording.stream));
    expect(recording.writes).toStrictEqual([
      'data: {"content":"part"}\n\n',
      'data: {"error":"OpenAI API error: 500"}\n\n',
      'data: [DONE]\n\n',
    ]);
  });

  test('fails as an HTTP error when $ai rejects the request, without having committed a 200', async () => {
    // The whole point of checking `response.ok` before `startStreaming`: a 400 from $ai (no API key,
    // `ai` feature off, bad reasoning effort) has to reach the browser as a failure, not as an
    // empty but apparently successful stream.
    stubSseFetch([], false, 400);
    const recording = recordingStream();

    await expect(handler(stubClient(), event(recording.stream))).rejects.toThrow(/\$ai returned 400/);
    expect(recording.started).toStrictEqual([]);
    expect(recording.writes).toStrictEqual([]);
  });

  test('terminates the stream even when the read fails halfway through', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let first = true;
          return {
            read: async () => {
              if (first) {
                first = false;
                return { done: false, value: encoder.encode('data: {"content":"half"}\n\n') };
              }
              throw new Error('socket reset');
            },
          };
        },
      },
    }));
    const recording = recordingStream();

    await expect(handler(stubClient(), event(recording.stream))).rejects.toThrow('socket reset');
    expect(recording.writes).toStrictEqual(['data: {"content":"half"}\n\n', 'data: [DONE]\n\n']);
  });
});

describe('buffered', () => {
  test('returns Parameters with content when the caller did not ask for a stream', async () => {
    const result = await handler(stubClient(), event(undefined));
    expect(result).toStrictEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'content', valueString: 'Buffered answer.' }],
    });
  });

  test('sends the system prompt and no tools', async () => {
    // No tools is what keeps this bot on $ai's chat-completions path, which is the only one that
    // streams. A tool declaration here would silently move it to the Responses API.
    await handler(stubClient(), event(undefined));

    const sent = JSON.parse(posts[0].parameter?.find((p) => p.name === 'messages')?.valueString as string);
    expect(sent[0]).toStrictEqual({ role: 'system', content: 'Summarize clearly.' });
    expect(posts[0].parameter?.find((p) => p.name === 'tools')).toBeUndefined();
  });
});

describe('the source list it gives the model', () => {
  /**
   * A tool response carrying a search bundle.
   * @param refs - `Type/id` strings to turn into bundle entries.
   * @returns The tool message.
   */
  function toolMessage(refs: string[]): unknown {
    return {
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: refs.map((ref) => {
          const [resourceType, id] = ref.split('/');
          return { resource: { resourceType, id } };
        }),
      }),
    };
  }

  /**
   * The messages the bot sent to $ai on the buffered path.
   * @returns The parsed conversation.
   */
  function sentMessages(): Record<string, unknown>[] {
    return JSON.parse(posts[0].parameter?.find((p) => p.name === 'messages')?.valueString as string);
  }

  test('numbers the sources the way the UI resolves [doc:Sn], as a trailing system turn', async () => {
    // Without this the model has to reproduce the UI's dedup ordering by eye. An off-by-one here
    // does not fail — it points a clinical claim at the wrong record.
    await handler(
      stubClient(),
      event(undefined, [
        { role: 'user', content: 'her recent labs?' },
        toolMessage(['Observation/o1', 'Observation/o2']),
        toolMessage(['Patient/p1']),
      ])
    );

    const messages = sentMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toContain('S1 = Observation/o1');
    expect(last.content).toContain('S2 = Observation/o2');
    expect(last.content).toContain('S3 = Patient/p1');
  });

  test('states the upper bound, so the model does not reach for a source that does not exist', async () => {
    await handler(stubClient(), event(undefined, [toolMessage(['Patient/p1'])]));

    const messages = sentMessages();
    expect(messages[messages.length - 1].content).toContain('nothing beyond S1 exists');
  });

  test('is omitted entirely when nothing was fetched', async () => {
    // An empty list would invite a citation anyway. The prompt covers the uncitable case in prose.
    await handler(stubClient(), event(undefined));

    const messages = sentMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toStrictEqual({ role: 'user', content: 'summarize' });
  });

  test('is sent on the streaming path too, not only the buffered one', async () => {
    // A hand-rolled fetch stub rather than `stubSseFetch`, because this one has to capture the
    // request body: on the streaming path the bot bypasses `medplum.post`.
    const bodies: string[] = [];
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      let done = false;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (done) {
                return { done: true };
              }
              done = true;
              return { done: false, value: encoder.encode('data: {"content":"ok"}\n\ndata: [DONE]\n\n') };
            },
          }),
        },
      };
    });

    await handler(stubClient(), event(recordingStream().stream, [toolMessage(['Patient/p1'])]));

    const sent = JSON.parse(bodies[0]);
    const messages = JSON.parse(sent.parameter.find((p: { name: string }) => p.name === 'messages').valueString);
    expect(messages[messages.length - 1].content).toContain('S1 = Patient/p1');
  });
});
