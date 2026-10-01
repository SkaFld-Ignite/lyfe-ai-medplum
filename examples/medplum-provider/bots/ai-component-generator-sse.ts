// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The Spaces visualizer bot.
 *
 * Writes a self-contained `function Chart()` React component for whatever the loop just fetched.
 * Only invoked when the translator set `visualize=true` at least once, and only when the loop
 * actually collected resources.
 *
 * The component is returned inside a fenced code block, which is not cosmetic: the UI pulls it out
 * with `StreamingCodeExtractor` in `src/utils/spaceMessaging.ts`, which looks for an opening
 * ```` ```jsx ```` / ```` ```tsx ```` / ```` ```js ```` / bare ```` ``` ```` fence and reads to the
 * closing one. Prose outside the fence is discarded, and a component emitted with no fence at all
 * is dropped entirely and the chart panel stays empty.
 *
 * Input (`Parameters`): `messages` (JSON conversation), `model`, `reasoning_effort`, and `fhirData`
 * — a JSON array of the resources the loop resolved, which the UI collects separately because the
 * tool responses in the history are search bundles rather than the resources themselves.
 * Output: the fenced code block, as SSE `{ "content": "..." }` frames terminated by `[DONE]`, or as
 * `Parameters` with a single `content` when not streaming.
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Parameters } from '@medplum/fhirtypes';
import {
  buildSystemPrompt,
  callAi,
  getBotProjectId,
  loadSystemPrompt,
  normalizeToolCallArguments,
  parseSpacesInput,
  readStringParameter,
  streamAiToResponse,
  toContentParameters,
} from './shared/spaces-ai.ts';

/**
 * The identifier the Provider UI resolves this bot by, under system
 * `https://www.medplum.com/bots`, and the identifier of its prompt `Communication` under
 * `http://medplum.com/ai-spaces`.
 */
const BOT_ID = 'ai-component-generator-sse';

/**
 * Entry point.
 * @param medplum - The bot's Medplum client, used to load the prompt and to call `$ai`.
 * @param event - Carries the `Parameters` input, the requester, and the response stream when the
 * caller asked for SSE.
 * @returns `Parameters` with `content`, or undefined when the answer was already streamed.
 */
export async function handler(medplum: MedplumClient, event: BotEvent): Promise<Parameters | undefined> {
  const input = parseSpacesInput(event.input);
  const fhirData = readStringParameter(event.input, 'fhirData');

  // Sequential, not Promise.all: concurrent searches inside a bot auto-batch and the flush needs
  // setTimeout, which the vmcontext sandbox lacks. See CLAUDE.md.
  const projectId = await getBotProjectId(medplum);
  const prompt = await loadSystemPrompt(medplum, BOT_ID, projectId);

  const request = {
    messages: [
      { role: 'system', content: buildSystemPrompt(prompt, event.requester) },
      ...normalizeToolCallArguments(input.messages),
      // Appended last, as a system turn rather than a user turn: this is context the platform
      // supplied, not something the person typed, and it arrives after the conversation it belongs
      // to. Forwarded as the JSON string it came in as — re-parsing and re-serialising it would
      // only risk changing it.
      ...(fhirData
        ? [{ role: 'system', content: `The resolved FHIR resources to chart, as a JSON array:\n${fhirData}` }]
        : []),
    ],
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };

  if (event.responseStream) {
    await streamAiToResponse(medplum, request, event.responseStream);
    // The HTTP response is already finished; `executeHandler` ends it without reading a value.
    return undefined;
  }

  return toContentParameters(readStringParameter(await callAi(medplum, request), 'content'));
}
