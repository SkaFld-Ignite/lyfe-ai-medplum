// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The translator bot's two contracts, end to end.
 *
 * Outward, to `$ai`: the system prompt has to be the first message, the tool schema has to be one
 * the Responses API will accept, and the replayed history has to be in chat-completions form.
 * Inward, to `sendToBot` in `src/utils/spaceMessaging.ts`: `content`, `tool_calls` and `visualize`,
 * by those names, in a `Parameters`.
 *
 * Stubbed at the Medplum client, which is the boundary — nothing inside the bot is mocked, so these
 * exercise the real prompt resolution, the real request assembly and the real output shape.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication, Parameters } from '@medplum/fhirtypes';
import { beforeEach, describe, expect, test } from 'vitest';
import { handler } from './ai-fhir-request-tools.ts';

const PROMPT: Communication = {
  resourceType: 'Communication',
  status: 'completed',
  id: 'prompt-1',
  meta: { project: 'project-1' },
  identifier: [{ system: 'http://medplum.com/ai-spaces', value: 'ai-fhir-request-tools' }],
  payload: [{ contentString: 'Use the tool.' }, { contentString: 'The requester is {{ref}}.' }],
};

let searches: { resourceType: string; query: unknown }[];
let posts: { url: string; body: Parameters }[];
let aiResponse: Parameters;
let prompts: Communication[];

/**
 * A Medplum client stubbed down to what the bot actually touches.
 * @returns The stub, typed as a MedplumClient.
 */
function stubClient(): MedplumClient {
  return {
    get: async (path: string) => {
      if (path !== 'auth/me') {
        throw new Error(`unexpected GET ${path}`);
      }
      return { project: { id: 'project-1' } };
    },
    searchResources: async (resourceType: string, query: unknown) => {
      searches.push({ resourceType, query });
      return prompts;
    },
    fhirUrl: (...path: string[]) => new URL(`https://example.com/fhir/R4/${path.join('/')}`),
    post: async (url: string, body: Parameters) => {
      posts.push({ url: url.toString(), body });
      return aiResponse;
    },
  } as unknown as MedplumClient;
}

/**
 * The bot event the Provider UI produces.
 * @param messages - The conversation history.
 * @returns A BotEvent.
 */
function event(messages: unknown[]): BotEvent {
  return {
    bot: { reference: 'Bot/1' },
    contentType: 'application/fhir+json',
    secrets: {},
    requester: { reference: 'Practitioner/abc-123' },
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
 * Reads one parameter out of a Parameters resource.
 * @param params - The resource.
 * @param name - The parameter name.
 * @returns The parameter, if present.
 */
function param(params: Parameters, name: string): Record<string, unknown> | undefined {
  return params.parameter?.find((p) => p.name === name) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  searches = [];
  posts = [];
  prompts = [PROMPT];
  aiResponse = { resourceType: 'Parameters', parameter: [] };
});

describe('the request it sends to $ai', () => {
  test('leads with the system prompt, with the requester substituted in', async () => {
    await handler(stubClient(), event([{ role: 'user', content: 'Find John Smith' }]));

    const sent = JSON.parse(param(posts[0].body, 'messages')?.valueString as string);
    expect(sent[0]).toStrictEqual({
      role: 'system',
      content: 'Use the tool.\n\nThe requester is Practitioner/abc-123.',
    });
    expect(sent[1]).toStrictEqual({ role: 'user', content: 'Find John Smith' });
  });

  test('searches for the prompt under the ai-spaces system, newest first', async () => {
    await handler(stubClient(), event([]));
    expect(searches).toStrictEqual([
      {
        resourceType: 'Communication',
        query: { identifier: 'http://medplum.com/ai-spaces|ai-fhir-request-tools', _sort: '-_lastUpdated' },
      },
    ]);
  });

  test('declares exactly two tools: fhir_request and search_documents', async () => {
    await handler(stubClient(), event([]));

    const tools = JSON.parse(param(posts[0].body, 'tools')?.valueString as string);
    expect(tools.map((tool: { function: { name: string } }) => tool.function.name)).toStrictEqual([
      'fhir_request',
      'search_documents',
    ]);
    expect(tools[0].function.parameters.required).toStrictEqual(['method', 'path']);
    expect(tools[0].function.parameters.properties.visualize.type).toBe('boolean');
  });

  test.each([0, 1])('tool %i has strict off', async (index) => {
    // Not cosmetic. $ai routes tools + a reasoning effort to the Responses API, which defaults
    // `strict` to true and then rejects a schema with optional properties — and both tools have
    // one: `body` and `visualize` on the first, `topK` on the second.
    await handler(stubClient(), event([]));
    const tools = JSON.parse(param(posts[0].body, 'tools')?.valueString as string);
    expect(tools[index].function.strict).toBe(false);
  });

  test('the document tool takes a patient and a query, and nothing that widens the scope', async () => {
    // The clinic is resolved from the caller's own token by the worker. A tool parameter the model
    // could fill in with an organization would be a way to ask for another clinic's documents, so
    // the absence of one is the thing worth pinning.
    await handler(stubClient(), event([]));
    const search = JSON.parse(param(posts[0].body, 'tools')?.valueString as string)[1].function;
    expect(search.parameters.required).toStrictEqual(['patientId', 'query']);
    expect(Object.keys(search.parameters.properties).sort()).toStrictEqual(['patientId', 'query', 'topK']);
    // Easy to confuse with a DocumentReference search; they answer different questions.
    expect(search.description).toMatch(/cannot count documents/i);
  });

  test('forwards the model and reasoning effort it was given', async () => {
    await handler(stubClient(), event([]));
    expect(param(posts[0].body, 'model')?.valueString).toBe('gpt-5.5');
    expect(param(posts[0].body, 'reasoning_effort')?.valueString).toBe('high');
  });

  test('re-stringifies tool-call arguments in the replayed history', async () => {
    // $ai returns them parsed and the UI replays them as received; chat completions needs a string.
    await handler(
      stubClient(),
      event([
        { role: 'user', content: 'and the vitals?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'fhir_request', arguments: { method: 'GET' } } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{}' },
      ])
    );

    const sent = JSON.parse(param(posts[0].body, 'messages')?.valueString as string);
    expect(sent[2].tool_calls[0].function.arguments).toBe('{"method":"GET"}');
  });

  test('posts to the $ai operation', async () => {
    await handler(stubClient(), event([]));
    expect(posts[0].url).toBe('https://example.com/fhir/R4/$ai');
  });
});

describe('the response it returns', () => {
  test('passes content and tool_calls through under the names the UI reads', async () => {
    const toolCalls = [
      { id: 'c1', type: 'function', function: { name: 'fhir_request', arguments: { method: 'GET', path: 'Patient' } } },
    ];
    aiResponse = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'content', valueString: 'Looking that up.' },
        { name: 'tool_calls', valueString: JSON.stringify(toolCalls) },
        { name: 'provider', valueString: 'openai' },
      ],
    };

    const result = await handler(stubClient(), event([]));
    expect(param(result, 'content')?.valueString).toBe('Looking that up.');
    // Verbatim: $ai has already normalised the shape the UI is written against.
    expect(JSON.parse(param(result, 'tool_calls')?.valueString as string)).toStrictEqual(toolCalls);
    // `provider` and `raw` are not forwarded; the UI has no use for them.
    expect(param(result, 'provider')).toBeUndefined();
  });

  test('reports visualize when a tool call asked for a chart', async () => {
    aiResponse = {
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'tool_calls',
          valueString: JSON.stringify([
            { id: 'c1', function: { name: 'fhir_request', arguments: { method: 'GET', path: 'Observation' } } },
            {
              id: 'c2',
              function: { name: 'fhir_request', arguments: { method: 'GET', path: 'Patient', visualize: true } },
            },
          ]),
        },
      ],
    };

    expect(param(await handler(stubClient(), event([])), 'visualize')?.valueBoolean).toBe(true);
  });

  test('always reports visualize, so the UI never has to guess', async () => {
    expect(param(await handler(stubClient(), event([])), 'visualize')?.valueBoolean).toBe(false);
  });

  test('omits content and tool_calls rather than sending them empty', async () => {
    // The loop treats "no tool calls" as "the model is done", so an empty array here would end it
    // one iteration early with nothing to say.
    const result = await handler(stubClient(), event([]));
    expect(result.parameter?.map((p) => p.name)).toStrictEqual(['visualize']);
  });
});

describe('when the prompt is missing', () => {
  test('names the bot whose prompt has to be authored', async () => {
    prompts = [];
    await expect(handler(stubClient(), event([]))).rejects.toThrow(
      'ai-fhir-request-tools system prompt is not available'
    );
  });

  test('treats a Communication with no payload as missing', async () => {
    prompts = [{ ...PROMPT, payload: undefined }];
    await expect(handler(stubClient(), event([]))).rejects.toThrow(/system prompt is not available/);
  });
});
