// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The Spaces summary bot.
 *
 * Narrates what the translator's loop actually fetched. The UI invokes it once the loop has
 * finished and only when at least one tool response is in the conversation, so the resources being
 * described are always already in the history — this bot makes no FHIR requests of its own and is
 * given no tools, which is also what keeps it on the streaming path.
 *
 * It streams when the caller asked for a stream, and answers in one piece when it did not. Both
 * matter: `sendToBotStreaming` in `src/utils/spaceMessaging.ts` inspects the response's
 * `Content-Type` and falls back to reading a buffered `Parameters` when it is not
 * `text/event-stream`, so the buffered path is what runs wherever the bot runtime cannot stream,
 * rather than being dead code.
 *
 * Input (`Parameters`): `messages` (JSON conversation), `model`, `reasoning_effort`.
 * Output: `content`, as SSE `{ "content": "..." }` frames terminated by `[DONE]`, or as
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
const BOT_ID = 'ai-resource-summary-sse';

/**
 * Entry point.
 * @param medplum - The bot's Medplum client, used to load the prompt and to call `$ai`.
 * @param event - Carries the `Parameters` input, the requester, and the response stream when the
 * caller asked for SSE.
 * @returns `Parameters` with `content`, or undefined when the answer was already streamed.
 */
export async function handler(medplum: MedplumClient, event: BotEvent): Promise<Parameters | undefined> {
  const input = parseSpacesInput(event.input);

  // Sequential, not Promise.all: concurrent searches inside a bot auto-batch and the flush needs
  // setTimeout, which the vmcontext sandbox lacks. See CLAUDE.md.
  const projectId = await getBotProjectId(medplum);
  const prompt = await loadSystemPrompt(medplum, BOT_ID, projectId);

  const request = {
    messages: [
      { role: 'system', content: buildSystemPrompt(prompt, event.requester) },
      ...normalizeToolCallArguments(input.messages),
    ],
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };

  if (event.responseStream) {
    await streamAiToResponse(medplum, request, event.responseStream);
    // The HTTP response is already finished. `executeHandler` sees `res.headersSent` and ends it
    // without looking at a return value.
    return undefined;
  }

  return toContentParameters(readStringParameter(await callAi(medplum, request), 'content'));
}
