// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * What the visualizer bot does that the summary bot does not: the `fhirData` input.
 *
 * The UI collects the resolved resources separately from the conversation, because the tool
 * responses in the history are search bundles rather than the resources themselves. If that input is
 * dropped the model still answers — it writes a chart out of whatever it can infer from the
 * transcript, which looks like a working feature producing wrong numbers.
 *
 * The streaming mechanics are shared with the summary bot and covered in its test.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication, Parameters } from '@medplum/fhirtypes';
import { beforeEach, describe, expect, test } from 'vitest';
import { handler } from './ai-component-generator-sse.ts';

const PROMPT: Communication = {
  resourceType: 'Communication',
  status: 'completed',
  id: 'prompt-3',
  meta: { project: 'project-1' },
  payload: [{ contentString: 'Write a Chart() component.' }],
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
    post: async (_url: string, body: Parameters) => {
      posts.push(body);
      return {
        resourceType: 'Parameters',
        parameter: [{ name: 'content', valueString: '```jsx\nfunction Chart() {}\n```' }],
      };
    },
  } as unknown as MedplumClient;
}

/**
 * The bot event the Provider UI produces, with no response stream so the buffered path runs.
 * @param fhirData - The resolved resources, JSON encoded, or undefined to omit the parameter.
 * @returns A BotEvent.
 */
function event(fhirData?: string): BotEvent {
  const parameter: { name: string; valueString: string }[] = [
    { name: 'messages', valueString: JSON.stringify([{ role: 'user', content: 'chart her A1c' }]) },
    { name: 'model', valueString: 'gpt-5.5' },
    { name: 'reasoning_effort', valueString: 'high' },
  ];
  if (fhirData !== undefined) {
    parameter.push({ name: 'fhirData', valueString: fhirData });
  }
  return {
    bot: { reference: 'Bot/1' },
    contentType: 'application/fhir+json',
    secrets: {},
    requester: { reference: 'Practitioner/abc-123' },
    input: { resourceType: 'Parameters', parameter },
  };
}

/**
 * The messages the bot sent to $ai.
 * @returns The parsed conversation.
 */
function sentMessages(): Record<string, unknown>[] {
  return JSON.parse(posts[0].parameter?.find((p) => p.name === 'messages')?.valueString as string);
}

beforeEach(() => {
  posts = [];
});

describe('fhirData', () => {
  test('is appended after the conversation, verbatim', async () => {
    // Forwarded as the string it arrived as. Re-parsing and re-serialising it could only change it.
    const fhirData = JSON.stringify([{ resourceType: 'Observation', id: 'o1', valueQuantity: { value: 6.4 } }]);
    await handler(stubClient(), event(fhirData));

    const messages = sentMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toStrictEqual({ role: 'user', content: 'chart her A1c' });
    expect(messages[2]).toStrictEqual({
      role: 'system',
      content: `The resolved FHIR resources to chart, as a JSON array:\n${fhirData}`,
    });
  });

  test('is omitted entirely when the caller sent none, rather than sent as an empty array', async () => {
    await handler(stubClient(), event(undefined));

    const messages = sentMessages();
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => String(m.content).includes('resolved FHIR resources'))).toBe(false);
  });
});

describe('the buffered answer', () => {
  test('carries the fenced code block through unchanged', async () => {
    // The fence is load-bearing: `StreamingCodeExtractor` discards everything outside it, and drops
    // the whole answer when there is no fence at all.
    const result = await handler(stubClient(), event(undefined));
    expect(result?.parameter?.[0]).toStrictEqual({
      name: 'content',
      valueString: '```jsx\nfunction Chart() {}\n```',
    });
  });
});
