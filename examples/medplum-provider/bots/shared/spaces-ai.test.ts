// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The parts of the Spaces bots that are a contract with something else, pinned.
 *
 * Each of these is a place where being subtly wrong produces no error at all. A prompt that picks
 * the wrong `Communication` works, with the wrong behaviour. `{{ref}}` left unsubstituted reads as
 * a literal instruction to the model. Tool-call arguments replayed as an object are rejected by
 * OpenAI with a message about `messages[n]`, nowhere near the cause. An SSE frame split across two
 * chunks is dropped silently and the narration loses a word. A missed `visualize` means the chart
 * panel simply never opens. None of them is caught by types, and none of them announces itself.
 */
import type { Communication } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MODEL,
  SSE_DONE,
  SseFrameParser,
  buildAiParameters,
  buildSystemPrompt,
  deriveVisualize,
  formatSseFrame,
  normalizeToolCallArguments,
  parseSpacesInput,
  readSseBody,
  readStringParameter,
  selectPromptCommunication,
  toContentParameters,
} from './spaces-ai.ts';

/**
 * Builds the `Parameters` input the Provider UI posts.
 * @param parameter - The parameters to include.
 * @returns A Parameters resource.
 */
function input(parameter: { name: string; valueString: string }[]): unknown {
  return { resourceType: 'Parameters', parameter };
}

describe('readStringParameter', () => {
  test('reads a value by name', () => {
    expect(readStringParameter(input([{ name: 'model', valueString: 'gpt-5.5' }]), 'model')).toBe('gpt-5.5');
  });

  test('treats an empty string as absent', () => {
    // `sendToBot` always sends `reasoning_effort`, even when the caller left it empty, and $ai
    // rejects an empty one rather than ignoring it.
    expect(
      readStringParameter(input([{ name: 'reasoning_effort', valueString: '' }]), 'reasoning_effort')
    ).toBeUndefined();
  });

  test.each([undefined, null, 'not a resource', {}, { parameter: 'nope' }])('survives %s as input', (value) => {
    expect(readStringParameter(value, 'model')).toBeUndefined();
  });
});

describe('parseSpacesInput', () => {
  const messages = [{ role: 'user', content: 'Find John Smith' }];

  test('reads the conversation, model and reasoning effort', () => {
    const parsed = parseSpacesInput(
      input([
        { name: 'messages', valueString: JSON.stringify(messages) },
        { name: 'model', valueString: 'gpt-5.5' },
        { name: 'reasoning_effort', valueString: 'high' },
      ])
    );
    expect(parsed).toStrictEqual({ messages, model: 'gpt-5.5', reasoningEffort: 'high' });
  });

  test('falls back to the documented default model', () => {
    const parsed = parseSpacesInput(input([{ name: 'messages', valueString: '[]' }]));
    expect(parsed.model).toBe(DEFAULT_MODEL);
    expect(parsed.reasoningEffort).toBeUndefined();
  });

  test('forwards an unrecognised reasoning effort rather than judging it', () => {
    // $ai owns the accepted list and names the bad value in its error. A second copy of that list
    // here would be one more thing to keep in step with the server.
    const parsed = parseSpacesInput(
      input([
        { name: 'messages', valueString: '[]' },
        { name: 'reasoning_effort', valueString: 'ludicrous' },
      ])
    );
    expect(parsed.reasoningEffort).toBe('ludicrous');
  });

  test('drops entries that are not message objects', () => {
    const parsed = parseSpacesInput(input([{ name: 'messages', valueString: '[{"role":"user"},null,"x",[]]' }]));
    expect(parsed.messages).toStrictEqual([{ role: 'user' }]);
  });

  test('rejects a missing, unparseable or non-array conversation', () => {
    expect(() => parseSpacesInput(input([]))).toThrow(/messages is required/);
    expect(() => parseSpacesInput(input([{ name: 'messages', valueString: '{' }]))).toThrow(/not valid JSON/);
    expect(() => parseSpacesInput(input([{ name: 'messages', valueString: '{"role":"user"}' }]))).toThrow(
      /must be an array/
    );
  });
});

describe('selectPromptCommunication', () => {
  const base: Communication = {
    resourceType: 'Communication',
    status: 'completed',
    id: 'base',
    meta: { project: 'medplum-base', lastUpdated: '2026-09-01T00:00:00.000Z' },
  };
  const override: Communication = {
    resourceType: 'Communication',
    status: 'completed',
    id: 'override',
    meta: { project: 'my-project', lastUpdated: '2026-01-01T00:00:00.000Z' },
  };

  test("prefers this project's override even when it is the older of the two", () => {
    // The whole point of the preference rule: an operator takes a prompt over by creating one,
    // without touching the default. Falling back to recency here would ignore their override.
    expect(selectPromptCommunication([base, override], 'my-project')?.id).toBe('override');
  });

  test('falls back to the most recently updated when there is no override', () => {
    expect(selectPromptCommunication([override, base], 'other-project')?.id).toBe('base');
  });

  test('sorts for itself rather than trusting the caller to have passed _sort', () => {
    expect(selectPromptCommunication([override, base], undefined)?.id).toBe('base');
  });

  test('returns undefined when there is nothing to pick', () => {
    expect(selectPromptCommunication([], 'my-project')).toBeUndefined();
  });
});

describe('buildSystemPrompt', () => {
  /**
   * Builds a prompt Communication.
   * @param contents - payload contentStrings, in order.
   * @returns The Communication.
   */
  function prompt(...contents: string[]): Communication {
    return {
      resourceType: 'Communication',
      status: 'completed',
      payload: contents.map((contentString) => ({ contentString })),
    };
  }

  test('returns payload[0] alone when there is no profile-context template', () => {
    expect(buildSystemPrompt(prompt('Be useful.'), { reference: 'Practitioner/abc' })).toBe('Be useful.');
  });

  test('substitutes {{ref}} and appends the context', () => {
    expect(
      buildSystemPrompt(prompt('Be useful.', 'The requester is {{ref}}.'), { reference: 'Practitioner/abc' })
    ).toBe('Be useful.\n\nThe requester is Practitioner/abc.');
  });

  test('substitutes every occurrence, not just the first', () => {
    expect(buildSystemPrompt(prompt('', '{{ref}} and {{ref}}'), { reference: 'Practitioner/abc' })).toBe(
      'Practitioner/abc and Practitioner/abc'
    );
  });

  test('names the gap rather than leaving a dangling sentence when there is no requester', () => {
    // "The requester is ." invites the model to guess who is asking.
    expect(buildSystemPrompt(prompt('Be useful.', 'The requester is {{ref}}.'), undefined)).toBe(
      'Be useful.\n\nThe requester is an unknown requester.'
    );
  });
});

describe('normalizeToolCallArguments', () => {
  test('restores the string form OpenAI requires', () => {
    // $ai hands arguments back parsed and the UI replays them as it received them. Chat completions
    // rejects an object here with a message about `messages[n].tool_calls[m].function.arguments`.
    const [message] = normalizeToolCallArguments([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fhir_request', arguments: { method: 'GET' } } }],
      },
    ]);
    expect(message.tool_calls).toStrictEqual([
      { id: 'c1', type: 'function', function: { name: 'fhir_request', arguments: '{"method":"GET"}' } },
    ]);
  });

  test('leaves arguments that are already a string untouched', () => {
    const original = {
      role: 'assistant',
      tool_calls: [{ id: 'c1', function: { name: 'fhir_request', arguments: '{"method":"GET"}' } }],
    };
    expect(normalizeToolCallArguments([original])[0]).toStrictEqual(original);
  });

  test('turns absent arguments into an empty object, not the string "undefined"', () => {
    const [message] = normalizeToolCallArguments([{ role: 'assistant', tool_calls: [{ id: 'c1', function: {} }] }]);
    expect(message.tool_calls).toStrictEqual([{ id: 'c1', function: { arguments: '{}' } }]);
  });

  test('passes through messages with no tool calls, and malformed calls, unchanged', () => {
    const plain = { role: 'user', content: 'hi' };
    const odd = { role: 'assistant', tool_calls: [null, 'nope', { id: 'c1' }] };
    expect(normalizeToolCallArguments([plain, odd])).toStrictEqual([plain, odd]);
  });
});

describe('deriveVisualize', () => {
  /**
   * Builds one tool call.
   * @param args - The function arguments, in either form.
   * @returns The tool call.
   */
  function call(args: unknown): unknown {
    return { id: 'c1', type: 'function', function: { name: 'fhir_request', arguments: args } };
  }

  test('reads the flag out of parsed arguments', () => {
    expect(deriveVisualize([call({ method: 'GET', path: 'Observation', visualize: true })])).toBe(true);
  });

  test('reads it out of the JSON string $ai returned', () => {
    // This is the shape the bot actually has: the `tool_calls` output parameter, still encoded.
    expect(deriveVisualize(JSON.stringify([call({ visualize: true })]))).toBe(true);
  });

  test('reads it out of arguments $ai could not parse', () => {
    // A truncated call keeps `arguments` as the raw string, which is still worth reading.
    expect(deriveVisualize([call('{"visualize":true}')])).toBe(true);
  });

  test('accepts the string "true", which models do emit', () => {
    expect(deriveVisualize([call({ visualize: 'true' })])).toBe(true);
  });

  test('one true anywhere in the batch is enough', () => {
    expect(deriveVisualize([call({ visualize: false }), call({ visualize: true })])).toBe(true);
  });

  test.each([
    ['no flag', [{ id: 'c1', function: { name: 'fhir_request', arguments: { method: 'GET' } } }]],
    ['explicitly false', [{ id: 'c1', function: { arguments: { visualize: false } } }]],
    ['a truthy non-boolean', [{ id: 'c1', function: { arguments: { visualize: 1 } } }]],
    ['no tool calls', []],
  ])('is false for %s', (_label, calls) => {
    expect(deriveVisualize(calls)).toBe(false);
  });

  test.each([undefined, null, 'not json', '"a string"', '{}', 42])('is false for %s', (value) => {
    expect(deriveVisualize(value)).toBe(false);
  });
});

describe('buildAiParameters', () => {
  test('sends only messages and model when nothing else was asked for', () => {
    // An empty `tools` array is not the same as none: it changes which OpenAI endpoint $ai picks.
    expect(buildAiParameters({ messages: [{ role: 'user' }], model: 'gpt-5.5' })).toStrictEqual({
      resourceType: 'Parameters',
      parameter: [
        { name: 'messages', valueString: '[{"role":"user"}]' },
        { name: 'model', valueString: 'gpt-5.5' },
      ],
    });
  });

  test('includes tools and reasoning effort when they are present', () => {
    const params = buildAiParameters({
      messages: [],
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      tools: [{ type: 'function' }],
    });
    expect(params.parameter?.map((p) => p.name)).toStrictEqual(['messages', 'model', 'tools', 'reasoning_effort']);
  });

  test('omits an empty tools array', () => {
    const params = buildAiParameters({ messages: [], model: 'gpt-5.5', tools: [] });
    expect(params.parameter?.map((p) => p.name)).toStrictEqual(['messages', 'model']);
  });
});

describe('SSE framing', () => {
  test('frames a payload exactly as the UI reader scans for it', () => {
    // `sendToBotStreaming` splits on \n, requires the `data: ` prefix, and JSON-parses the rest.
    expect(formatSseFrame({ content: 'hi' })).toBe('data: {"content":"hi"}\n\n');
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
  });

  test('reads several frames out of one chunk', () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: {"content":"a"}\n\ndata: {"content":"b"}\n\n')).toStrictEqual([
      { content: 'a' },
      { content: 'b' },
    ]);
  });

  test('holds back a line split across chunks', () => {
    // The failure this prevents is a dropped word in the middle of the narration, with no error.
    const parser = new SseFrameParser();
    expect(parser.push('data: {"con')).toStrictEqual([]);
    expect(parser.push('tent":"hello"}\n')).toStrictEqual([{ content: 'hello' }]);
  });

  test('does not emit a frame until its line is terminated', () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: {"content":"a"}')).toStrictEqual([]);
    expect(parser.push('\n')).toStrictEqual([{ content: 'a' }]);
  });

  test('drops [DONE], blank lines, comments and anything that is not a data line', () => {
    const parser = new SseFrameParser();
    expect(parser.push(': keep-alive\n\nevent: ping\ndata: [DONE]\n\n')).toStrictEqual([]);
  });

  test('skips an unparseable frame instead of ending the stream', () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: {oops\ndata: {"content":"a"}\n')).toStrictEqual([{ content: 'a' }]);
  });

  test('carries the other frame kinds $ai emits', () => {
    const parser = new SseFrameParser();
    expect(parser.push('data: {"raw":{"id":"x"}}\ndata: {"error":"boom"}\n')).toStrictEqual([
      { raw: { id: 'x' } },
      { error: 'boom' },
    ]);
  });
});

describe('readSseBody', () => {
  const encoder = new TextEncoder();
  const body = 'data: {"content":"he"}\n\ndata: {"content":"llo"}\n\ndata: [DONE]\n\n';

  test('reads a WHATWG ReadableStream, which is what a browser or Node fetch gives', async () => {
    // Duck-typed on getReader rather than on instanceof: the sandbox has no ReadableStream at all.
    let index = 0;
    const chunks = [encoder.encode(body.slice(0, 15)), encoder.encode(body.slice(15))];
    const stream = {
      getReader: () => ({
        read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
      }),
    };

    const frames: unknown[] = [];
    await readSseBody(stream, (frame) => frames.push(frame));
    expect(frames).toStrictEqual([{ content: 'he' }, { content: 'llo' }]);
  });

  test('reads a Node Readable, which is what node-fetch 2 gives inside a vmcontext bot', async () => {
    const iterable = {
      [Symbol.asyncIterator]: async function* () {
        yield encoder.encode(body.slice(0, 30));
        yield encoder.encode(body.slice(30));
      },
    };

    const frames: unknown[] = [];
    await readSseBody(iterable, (frame) => frames.push(frame));
    expect(frames).toStrictEqual([{ content: 'he' }, { content: 'llo' }]);
  });

  test('reassembles a multi-byte character split across chunks', async () => {
    // `{ stream: true }` on the decoder is what makes this work; without it the character becomes
    // U+FFFD and the frame fails to parse, losing the whole chunk.
    const bytes = encoder.encode('data: {"content":"café"}\n');
    const iterable = {
      [Symbol.asyncIterator]: async function* () {
        yield bytes.slice(0, 21);
        yield bytes.slice(21);
      },
    };

    const frames: unknown[] = [];
    await readSseBody(iterable, (frame) => frames.push(frame));
    expect(frames).toStrictEqual([{ content: 'café' }]);
  });

  test('fails loudly when there is no stream at all', async () => {
    await expect(readSseBody(null, () => undefined)).rejects.toThrow(/no readable body/);
  });
});

describe('toContentParameters', () => {
  test('carries the content the non-streaming reader looks for', () => {
    expect(toContentParameters('hello')).toStrictEqual({
      resourceType: 'Parameters',
      parameter: [{ name: 'content', valueString: 'hello' }],
    });
  });

  test('is a valid empty Parameters when the model said nothing', () => {
    expect(toContentParameters(undefined)).toStrictEqual({ resourceType: 'Parameters', parameter: [] });
  });
});
