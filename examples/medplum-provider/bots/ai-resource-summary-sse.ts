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
  collectCitableSources,
  formatSourceList,
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
 * The message that tells the model what each `[doc:Sn]` marker means.
 *
 * States the upper bound explicitly. A model given a list of three and asked to cite thoroughly
 * will reach for a fourth; the UI drops an unresolvable marker, so that costs a citation rather
 * than correctness, but it is cheap to prevent.
 * @param count - How many sources there are.
 * @param sourceList - The rendered `Sn = Type/id` lines.
 * @returns The system message content.
 */
function sourceListMessage(count: number, sourceList: string): string {
  return [
    'The sources you may cite, numbered. [doc:S1] is the first in this list, [doc:S2] the second,',
    `and so on. There are ${count}: S1 to S${count}, and nothing beyond S${count} exists.`,
    '',
    sourceList,
  ].join('\n');
}

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

  // The numbering behind every [doc:Sn] the prompt asks for. Computed here rather than left to the
  // model, because an off-by-one does not fail — it attributes a clinical statement to the wrong
  // record, and the reader opens it and believes it. See `collectCitableSources`.
  const sources = collectCitableSources(input.messages);
  const sourceList = formatSourceList(sources);

  const request = {
    messages: [
      { role: 'system', content: buildSystemPrompt(prompt, event.requester) },
      ...normalizeToolCallArguments(input.messages),
      // Appended last so it is the most recent thing the model read before answering. Omitted
      // entirely when nothing was fetched, rather than sent empty: an empty list invites the model
      // to cite anyway, and the upper bound is stated for the same reason.
      ...(sourceList ? [{ role: 'system', content: sourceListMessage(sources.length, sourceList) }] : []),
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
