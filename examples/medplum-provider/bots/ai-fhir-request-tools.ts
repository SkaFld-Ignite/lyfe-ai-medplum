// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The Spaces translator bot.
 *
 * Turns the conversation so far into FHIR requests. It does not execute them — it only says which
 * ones to make, and the Provider UI runs each one under the signed-in user's access policy. That
 * split is the whole security story of Spaces: the bot has no way to reach data the person asking
 * could not have read themselves.
 *
 * The UI calls this on every iteration of its ReAct loop (`processMessage` in
 * `src/utils/spaceMessaging.ts`, capped at 10 iterations) and stops as soon as a turn comes back
 * with no tool calls, treating that turn's `content` as the final answer.
 *
 * All the behaviour an operator tunes lives in the system prompt `Communication`, not here. See
 * `packages/docs/docs/provider/spaces.mdx`.
 *
 * Input (`Parameters`): `messages` (JSON conversation), `model`, `reasoning_effort`.
 * Output (`Parameters`): `content`, `tool_calls` (JSON), `visualize` (boolean).
 */
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Parameters, ParametersParameter } from '@medplum/fhirtypes';
import {
  buildSystemPrompt,
  callAi,
  deriveVisualize,
  describeRequesterScope,
  getBotProjectId,
  loadSystemPrompt,
  normalizeToolCallArguments,
  parseSpacesInput,
  readStringParameter,
} from './shared/spaces-ai.ts';

/**
 * The identifier the Provider UI resolves this bot by, under system
 * `https://www.medplum.com/bots`, and the identifier of its prompt `Communication` under
 * `http://medplum.com/ai-spaces`. The same string names both; see `bots/deploy.ts`.
 */
const BOT_ID = 'ai-fhir-request-tools';

/**
 * The only tool the translator has.
 *
 * `visualize` is a property of the request rather than a tool of its own. That is what the docs
 * mean by the flag being "derived from the tool-call arguments", and it costs the loop nothing: a
 * separate `set_visualization` call would burn a whole extra iteration — one more model round trip
 * per prompt — to communicate one boolean.
 *
 * `strict` is off explicitly, and it has to be. `body` and `visualize` are genuinely optional,
 * which strict mode forbids (it requires every property in `required`, plus
 * `additionalProperties: false`), and the Responses API defaults `strict` to true. `$ai` routes to
 * the Responses API whenever tools are combined with a reasoning effort other than `none`, which
 * is every call from the shipping UI, so leaving it unset means the schema is rejected.
 */
const FHIR_REQUEST_TOOL = {
  type: 'function',
  function: {
    name: 'fhir_request',
    description:
      'Make one FHIR request against this Medplum project. The caller executes it under the ' +
      "signed-in user's access policy and returns the response as this tool's result. Use it for " +
      'every FHIR read and every FHIR write; never answer from memory. To change a resource, GET ' +
      'it first and PUT the complete modified resource back.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'The HTTP method.',
        },
        path: {
          type: 'string',
          description:
            'Path relative to the FHIR base, with no leading slash. For example ' +
            '"Patient?name=Smith&_count=20", "Observation/abc-123", or "Patient/abc-123/$everything".',
        },
        body: {
          type: 'object',
          description: 'The complete resource to send. Required for POST and PUT, omitted otherwise.',
        },
        visualize: {
          type: 'boolean',
          description:
            'True when the answer built from this request should be drawn as a chart rather than ' +
            'only described in prose — values over time, counts across categories, trends.',
        },
      },
      required: ['method', 'path'],
    },
  },
};

/**
 * Searching the text of a patient's scanned documents.
 *
 * The second tool, and the only one that reaches something FHIR search cannot. `fhir_request` can
 * find a `DocumentReference` but not read what is inside its `Binary`: a scanned cardiology letter
 * is a PDF, and the finding in it exists in no structured resource. The lyfe-worker keeps a
 * pgvector index over text extracted from those binaries, and this tool queries it.
 *
 * Executed by the Provider UI exactly as `fhir_request` is — the UI reads the patient under the
 * signed-in user's access policy first, then calls the worker with the user's own token, and the
 * worker scopes the search to the organization that token resolves to. The bot never sees a
 * document and cannot widen the scope of a search it asked for.
 *
 * `strict` is off for the same reason it is off above: `topK` is genuinely optional, which strict
 * mode forbids, and the Responses API defaults `strict` to true.
 */
const SEARCH_DOCUMENTS_TOOL = {
  type: 'function',
  function: {
    name: 'search_documents',
    description:
      "Search the full text of one patient's scanned and uploaded documents — consult letters, " +
      'discharge summaries, imaging and pathology reports, outside records — and get back the ' +
      'passages that match, each naming the DocumentReference it came from. Use it when the ' +
      'answer is written in a document rather than recorded as a structured resource. It reads ' +
      'text, so it cannot count documents, filter them by date or list them: use fhir_request on ' +
      'DocumentReference for that.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          description: 'The Patient resource id, with no "Patient/" prefix.',
        },
        query: {
          type: 'string',
          description:
            'What to look for, in clinical language. Matched by meaning rather than by keyword, ' +
            'so a phrase from the question works better than a single word.',
        },
        topK: {
          type: 'number',
          description: 'How many passages to return. Defaults to 6; more than about 12 rarely helps.',
        },
      },
      required: ['patientId', 'query'],
    },
  },
};

/**
 * Entry point.
 * @param medplum - The bot's Medplum client, used to load the prompt and to call `$ai`.
 * @param event - Carries the `Parameters` input and the requester.
 * @returns `Parameters` with `content`, `tool_calls` and `visualize`.
 */
export async function handler(medplum: MedplumClient, event: BotEvent): Promise<Parameters> {
  const input = parseSpacesInput(event.input);

  // Sequential, not Promise.all. Concurrent Medplum searches inside a bot auto-batch, and the
  // batch flush uses setTimeout, which the vmcontext sandbox does not have: the bot hangs with no
  // error. See CLAUDE.md.
  const projectId = await getBotProjectId(medplum);
  const prompt = await loadSystemPrompt(medplum, BOT_ID, projectId);
  // Whether "my patients" is a filter or means the whole clinic. Sequential, as above.
  const scope = await describeRequesterScope(medplum, event.requester);

  const response = await callAi(medplum, {
    messages: [
      { role: 'system', content: `${buildSystemPrompt(prompt, event.requester)}\n\n${scope}` },
      ...normalizeToolCallArguments(input.messages),
    ],
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    tools: [FHIR_REQUEST_TOOL, SEARCH_DOCUMENTS_TOOL],
  });

  const content = readStringParameter(response, 'content');
  const toolCalls = readStringParameter(response, 'tool_calls');

  const parameter: ParametersParameter[] = [];
  if (content) {
    parameter.push({ name: 'content', valueString: content });
  }
  if (toolCalls) {
    // Passed through verbatim. `$ai` has already normalised the call shape and parsed each
    // `arguments` string, and the UI is written against exactly that shape.
    parameter.push({ name: 'tool_calls', valueString: toolCalls });
  }
  parameter.push({ name: 'visualize', valueBoolean: deriveVisualize(toolCalls) });

  return { resourceType: 'Parameters', parameter };
}
