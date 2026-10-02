// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared plumbing for the three Spaces bots.
 *
 * The bots themselves are deliberately thin: each one loads its operator-authored system prompt
 * from a `Communication`, forwards the conversation to the server-side `$ai` operation, and hands
 * the answer back in the exact `Parameters` shape the Provider UI reads. Everything that is the
 * same across all three — prompt resolution, the `$ai` call, SSE framing — lives here so the bots
 * read as the contract they implement rather than as transport code.
 *
 * The contract itself is not invented here. It is fixed by `src/utils/spaceMessaging.ts`
 * (`sendToBot`, `sendToBotStreaming`) on the calling side and by
 * `packages/server/src/fhir/operations/ai.ts` on the serving side, and documented in
 * `packages/docs/docs/provider/spaces.mdx`.
 */
import type { BotResponseStream, MedplumClient } from '@medplum/core';
import type { Communication, Parameters, ParametersParameter, Reference } from '@medplum/fhirtypes';

/**
 * Identifier system for the operator-authored system-prompt `Communication` resources.
 *
 * Note that it is *not* the same system the bots themselves are found under
 * (`https://www.medplum.com/bots`), and it is `http`, not `https`. Both are load-bearing strings
 * copied from `packages/docs/docs/provider/spaces.mdx`; a drift in either silently turns into
 * "system prompt is not available" on every turn.
 */
export const SPACES_PROMPT_SYSTEM = 'http://medplum.com/ai-spaces';

/**
 * The model `$ai` is asked for when the caller does not name one.
 *
 * The shipping Provider UI always sends a model from its dropdown, so this only applies to a
 * direct invocation. `spaces.mdx` documents the default as `gpt-4`.
 */
export const DEFAULT_MODEL = 'gpt-4';

/** One parsed `data:` payload from an SSE stream. */
export type SseFrame = Record<string, unknown>;

/**
 * One entry of the conversation history, in OpenAI chat-completions form.
 *
 * Left as an open record on purpose. The history is built by the browser, persisted as JSON on a
 * `Communication`, and forwarded to the provider verbatim; restating OpenAI's message schema here
 * would only create a second definition to keep in sync, and `$ai` already treats messages as
 * opaque for the same reason.
 */
export type ChatMessage = Record<string, unknown>;

/** The inputs every Spaces bot takes, read out of the `Parameters` the UI posts. */
export interface SpacesInput {
  readonly messages: ChatMessage[];
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** What to ask `$ai` for. */
export interface AiRequest {
  readonly messages: readonly ChatMessage[];
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly tools?: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one `valueString` out of a `Parameters` input.
 *
 * An empty string is reported as absent: every caller of this treats "" and "not sent" the same
 * way, and `$ai` rejects an empty `model` rather than falling back to its default.
 * @param input - The bot's input, expected to be a `Parameters` resource.
 * @param name - The parameter name to read.
 * @returns The string value, or undefined when it is missing or empty.
 */
export function readStringParameter(input: unknown, name: string): string | undefined {
  const parameter = isRecord(input) ? input.parameter : undefined;
  if (!Array.isArray(parameter)) {
    return undefined;
  }
  const found = parameter.find((p) => isRecord(p) && p.name === name);
  const value = isRecord(found) ? found.valueString : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the inputs shared by all three bots.
 *
 * `reasoning_effort` is forwarded as given rather than validated here. `$ai` owns the list of
 * accepted values and rejects an unknown one with a message that names it, so checking it twice
 * would only add a second list to keep in step with the server's.
 * @param input - The bot's input, expected to be a `Parameters` resource.
 * @returns The conversation, the model, and the reasoning effort if one was sent.
 * @throws If `messages` is missing, is not JSON, or is not an array.
 */
export function parseSpacesInput(input: unknown): SpacesInput {
  const raw = readStringParameter(input, 'messages');
  if (!raw) {
    throw new Error('messages is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('messages is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('messages must be an array');
  }

  return {
    messages: parsed.filter(isRecord),
    model: readStringParameter(input, 'model') ?? DEFAULT_MODEL,
    reasoningEffort: readStringParameter(input, 'reasoning_effort'),
  };
}

/**
 * The project the bot is running in.
 *
 * `MedplumClient.getProject()` reads a login this client never performed — a `vmcontext` bot is
 * handed a bare access token, nothing else — so the project has to come from the server. Failure
 * is swallowed rather than thrown: without the project id the prompt lookup falls back to the most
 * recently updated match, which is a less specific answer, not a broken one.
 * @param medplum - The bot's Medplum client.
 * @returns The project id, or undefined if it could not be determined.
 */
export async function getBotProjectId(medplum: MedplumClient): Promise<string | undefined> {
  try {
    const session: { project?: { id?: string } } | undefined = await medplum.get('auth/me');
    return session?.project?.id;
  } catch {
    return undefined;
  }
}

/**
 * Picks which system-prompt `Communication` to use out of the matches for one identifier.
 *
 * A plain search can return two: the default base prompt a Spaces-enabled deployment ships, and
 * this project's own override carrying the same identifier. Prefer the override — the match whose
 * `meta.project` is the current project — and otherwise take the most recently updated one. That
 * preference rule is the documented behaviour, and it is what lets an operator take over a prompt
 * by creating a resource rather than by editing the default in place.
 * @param candidates - Every `Communication` matching the identifier.
 * @param projectId - The project the bot is running in, if known.
 * @returns The prompt to use, or undefined when there are no candidates.
 */
export function selectPromptCommunication(
  candidates: readonly Communication[],
  projectId: string | undefined
): Communication | undefined {
  if (projectId) {
    const owned = candidates.find((candidate) => candidate.meta?.project === projectId);
    if (owned) {
      return owned;
    }
  }
  // Sorted here as well as in the search. A pure function that depends on its caller having
  // passed `_sort` is a trap for the next caller.
  return [...candidates].sort((a, b) => (b.meta?.lastUpdated ?? '').localeCompare(a.meta?.lastUpdated ?? ''))[0];
}

/**
 * Loads one bot's system-prompt `Communication`.
 * @param medplum - The bot's Medplum client.
 * @param value - The bot identifier value, which is also the prompt's identifier value.
 * @param projectId - The project the bot is running in, if known.
 * @returns The prompt resource.
 * @throws If no match carries a prompt, which is the one failure an operator has to act on.
 */
export async function loadSystemPrompt(
  medplum: MedplumClient,
  value: string,
  projectId: string | undefined
): Promise<Communication> {
  const candidates = await medplum.searchResources('Communication', {
    identifier: `${SPACES_PROMPT_SYSTEM}|${value}`,
    _sort: '-_lastUpdated',
  });

  const chosen = selectPromptCommunication(candidates, projectId);
  if (!chosen?.payload?.[0]?.contentString) {
    throw new Error(`${value} system prompt is not available`);
  }
  return chosen;
}

/**
 * Builds the system message content for one bot.
 *
 * `payload[0]` is the prompt. `payload[1]`, when present, is a profile-context template whose
 * `{{ref}}` placeholder is replaced with the requester's reference string and appended. Only the
 * translator ships one — it is the only bot whose behaviour depends on who is asking.
 * @param prompt - The prompt `Communication`.
 * @param requester - Who invoked the bot, as `BotEvent.requester` reports it.
 * @returns The system message content.
 */
export function buildSystemPrompt(prompt: Communication, requester: Reference | undefined): string {
  const base = prompt.payload?.[0]?.contentString ?? '';
  const template = prompt.payload?.[1]?.contentString;
  const today = currentDateLine();
  if (!template) {
    return base ? `${base}\n\n${today}` : today;
  }
  // No reference should not blank the placeholder: a prompt reading "The requester is ." invites
  // the model to guess, where "an unknown requester" tells it not to.
  const context = template.replaceAll('{{ref}}', requester?.reference ?? 'an unknown requester');
  return [base, context, today].filter(Boolean).join('\n\n');
}

/** What to tell the model when the requester holds no appointments of their own. */
const CLINIC_WIDE_SCOPE =
  'The requester is NOT a scheduling provider \u2014 no appointment lists them as the practitioner. ' +
  'When they say "my patients", "my schedule" or "my appointments" they mean the clinic\'s, so do ' +
  'NOT filter by practitioner: a practitioner filter here returns nothing. Their access policy ' +
  'already limits every search to their own clinic.';

/**
 * Say whether the person asking actually has a schedule of their own.
 *
 * "Show me my patients this week" means two different things depending on who
 * asks, and getting it wrong is not a small error -- it is an empty answer.
 *
 * A clinic's providers come across from DrChrono and are the `actor` on their
 * own appointments, so for them "my patients" is a real filter. An
 * administrator, an owner, or anyone whose Medplum login was never linked to a
 * DrChrono provider is the `actor` on nothing. Filtering by them returns zero
 * rows out of a full week, and the model -- reasonably -- keeps trying other
 * parameter names until the agent loop runs out of iterations. That is exactly
 * what happened: 43 appointments in the week, 0 once filtered by the requester.
 *
 * So it is answered from the data rather than guessed: one count. It also
 * self-corrects -- link an account to a provider later and the same code starts
 * filtering, with nothing to remember to change.
 *
 * The clinic boundary is never at stake. The caller's AccessPolicy already
 * scopes every search to their organization; this only decides whether to
 * narrow further inside what they can already see.
 * @param medplum - Bot-scoped Medplum client.
 * @param requester - Who is asking.
 * @returns A sentence for the system prompt.
 */
export async function describeRequesterScope(
  medplum: MedplumClient,
  requester: Reference | undefined
): Promise<string> {
  const reference = requester?.reference;
  if (!reference?.startsWith('Practitioner/')) {
    // A non-practitioner caller has no schedule by definition; narrowing to it
    // would hide the entire clinic.
    return CLINIC_WIDE_SCOPE;
  }
  // `_summary=count` so this costs a count, not a page of appointments.
  //
  // try/catch, not just `.catch` — the call itself can throw synchronously if
  // the client does not expose `search`, and this must never be the reason a
  // chat turn fails. Any doubt resolves to the clinic, because the wrong way to
  // be wrong is to tell someone they have no patients.
  let own = 0;
  try {
    const bundle = await medplum.search('Appointment', `actor=${encodeURIComponent(reference)}&_summary=count`);
    own = bundle.total ?? 0;
  } catch {
    return CLINIC_WIDE_SCOPE;
  }

  return own > 0
    ? 'The requester IS a scheduling provider in this clinic. When they say "my patients", "my ' +
        `schedule" or "my appointments", filter by that practitioner, e.g. actor=${reference}.`
    : CLINIC_WIDE_SCOPE;
}

/**
 * Tell the model what day it is.
 *
 * Without this the model answers date-relative questions from its training prior.
 * Asked for "this week" it searched `date=ge2025-07-14&date=le2025-07-20` — more
 * than a year out — found nothing, tried a different search, found nothing again,
 * and burned the agent loop's whole iteration budget before giving up and
 * printing a raw unexecuted tool call into the conversation. Every symptom of
 * that — the wrong results, the slowness, the leaked tool call — was this one
 * missing line.
 *
 * Written as an ISO date plus the weekday because a model reasoning about "this
 * week" needs to know which day of the week today is, and deriving that from an
 * ISO string is exactly the sort of arithmetic it gets wrong.
 * @returns A line naming today's date for the system prompt.
 */
function currentDateLine(): string {
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return (
    `Today is ${weekday}, ${iso} (UTC). Resolve every relative date — "today", "this week", ` +
    `"last month", "recent" — against that date, never against your training data.`
  );
}

/**
 * Restores the string form of tool-call arguments in a replayed conversation.
 *
 * `$ai` hands tool calls back with `arguments` already parsed into an object, and the Provider UI
 * stores and replays them exactly as it received them. OpenAI's chat-completions schema requires a
 * string there, so replaying that history verbatim is rejected with
 * `Invalid type for 'messages[n].tool_calls[m].function.arguments'`. `$ai`'s Responses-API path
 * re-stringifies them itself; its chat-completions path forwards messages untouched, and which of
 * the two answers depends on whether the request carries tools — so the fix has to be here, on
 * every request, rather than in one bot.
 * @param messages - The conversation as the caller sent it.
 * @returns The same conversation with every tool call's arguments as a string.
 */
export function normalizeToolCallArguments(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) {
      return message;
    }
    return {
      ...message,
      tool_calls: toolCalls.map((call) => {
        if (!isRecord(call) || !isRecord(call.function) || typeof call.function.arguments === 'string') {
          return call;
        }
        return { ...call, function: { ...call.function, arguments: JSON.stringify(call.function.arguments ?? {}) } };
      }),
    };
  });
}

/**
 * Reads tool-call arguments, whichever form they arrived in.
 *
 * `$ai` parses them, but hands over the raw JSON string unchanged when it could not — a truncated
 * stream or a malformed call — so both have to be handled.
 * @param args - The `function.arguments` value.
 * @returns The arguments as a record, or undefined if they are neither.
 */
function readToolCallArguments(args: unknown): Record<string, unknown> | undefined {
  if (isRecord(args)) {
    return args;
  }
  if (typeof args !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reference string for one resource out of a tool response.
 *
 * A deliberate mirror of `getReferenceString` from `@medplum/core`, down to preferring an existing
 * `reference` property over `resourceType/id`, because the numbering it feeds has to agree with the
 * UI's exactly. Not imported, because the bot sees tool responses as parsed JSON rather than as
 * typed resources, and the real function's overloads reject that.
 * @param value - A resource, as it appears inside a tool response.
 * @returns The reference string, or undefined when the resource has no identity.
 */
function referenceStringOf(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.reference === 'string' && value.reference !== '') {
    return value.reference;
  }
  const { resourceType, id } = value;
  if (typeof resourceType === 'string' && resourceType !== '' && typeof id === 'string' && id !== '') {
    return `${resourceType}/${id}`;
  }
  return undefined;
}

/**
 * The sources a `[doc:Sn]` citation can point at, numbered the way the UI numbers them.
 *
 * This exists because the model cannot be asked to work the numbering out for itself. `Sn` is a
 * 1-based index into the `resources` array the UI attaches to the finished message, and the UI
 * builds that array *after* the summary bot has run, by walking every tool response in order,
 * taking each bundle entry's resource, and de-duplicating. A model asked to reproduce that over a
 * few hundred bundle entries will occasionally be off by one — and an off-by-one here does not
 * fail, it silently attributes a clinical statement to the wrong record, which is the one outcome
 * worse than no citation at all. So the bot computes the list and tells the model the numbers.
 *
 * It is therefore a mirror of `extractResourceRefs` and the `[...new Set(...)]` in
 * `processMessage` (`src/utils/spaceMessaging.ts`), and has to stay one: if that ordering or
 * de-duplication changes, every citation silently shifts. The test for this function is the
 * tripwire.
 *
 * `search_documents` results are in the same numbering rather than a namespace of their own. A
 * chunk in the RAG index is keyed by the `DocumentReference.id` it was extracted from, so a
 * document hit already has a FHIR identity, and the UI pushes `DocumentReference/<id>` per hit in
 * hit order — see `toDocumentSearchToolResult` in `src/utils/spaceMessaging.ts`. Reading the
 * reference each hit already carries, rather than rebuilding it from an id here, is what keeps the
 * two sides to one line each: there is no second copy of the rule for one of them to get wrong.
 *
 * Tool responses that carry no resource — an error payload, a `set_visualization`
 * acknowledgement, an empty bundle, a document search that matched nothing — contribute nothing,
 * which is also what the UI does.
 * @param messages - The conversation, including the tool responses the loop collected.
 * @returns The citable references, in citation order, de-duplicated.
 */
export function collectCitableSources(messages: readonly ChatMessage[]): string[] {
  const refs: string[] = [];

  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') {
      continue;
    }

    let result: unknown;
    try {
      result = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!isRecord(result)) {
      continue;
    }

    // Document search, matched on its own wrapper key rather than on the shape of what is inside
    // it, so it can never be confused with a FHIR resource that happens to carry a `hits` field.
    if (isRecord(result.documentSearch)) {
      const hits = result.documentSearch.hits;
      if (Array.isArray(hits)) {
        for (const hit of hits) {
          const ref = referenceStringOf(hit);
          if (ref) {
            refs.push(ref);
          }
        }
      }
      continue;
    }

    // The UI branches on `resourceType === 'Bundle' && entry`, so a bundle with no `entry` at all
    // falls through to being cited as itself. Mirrored, including that.
    if (result.resourceType === 'Bundle' && result.entry) {
      if (Array.isArray(result.entry)) {
        for (const entry of result.entry) {
          const ref = referenceStringOf(isRecord(entry) ? entry.resource : undefined);
          if (ref) {
            refs.push(ref);
          }
        }
      }
      continue;
    }

    const ref = referenceStringOf(result);
    if (ref) {
      refs.push(ref);
    }
  }

  return [...new Set(refs)];
}

/**
 * Renders the numbered source list the model cites against.
 * @param refs - The citable references, in order, from {@link collectCitableSources}.
 * @returns One `Sn = Type/id` line per source, or undefined when there is nothing citable.
 */
export function formatSourceList(refs: readonly string[]): string | undefined {
  if (refs.length === 0) {
    return undefined;
  }
  return refs.map((ref, index) => `S${index + 1} = ${ref}`).join('\n');
}

/**
 * Whether the answer should be rendered as a chart.
 *
 * The translator reports this as a `visualize` argument on a tool call rather than as a separate
 * output — what `spaces.mdx` means by "derived from the tool-call arguments" — so one `true`
 * anywhere in the batch is enough. The string `'true'` counts because models do emit a boolean as
 * a string often enough that treating it as "no chart" reads as a bug to the user.
 * @param toolCalls - The tool calls, as an array or as the JSON string `$ai` returned.
 * @returns True if any tool call asked for a visualization.
 */
export function deriveVisualize(toolCalls: unknown): boolean {
  let calls: unknown = toolCalls;
  if (typeof calls === 'string') {
    try {
      calls = JSON.parse(calls);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(calls)) {
    return false;
  }
  return calls.some((call) => {
    const fn = isRecord(call) ? call.function : undefined;
    const args = readToolCallArguments(isRecord(fn) ? fn.arguments : undefined);
    return args?.visualize === true || args?.visualize === 'true';
  });
}

/**
 * Builds the `Parameters` body for `$ai`.
 *
 * Optional inputs are omitted rather than sent empty, and that matters in both directions: `$ai`
 * rejects an unrecognised `reasoning_effort` outright, and an empty `tools` array would change
 * which OpenAI endpoint it picks for a bot that has no tools.
 * @param request - What to ask for.
 * @returns The `Parameters` resource to POST to `$ai`.
 */
export function buildAiParameters(request: AiRequest): Parameters {
  const parameter: ParametersParameter[] = [
    { name: 'messages', valueString: JSON.stringify(request.messages) },
    { name: 'model', valueString: request.model },
  ];
  if (request.tools && request.tools.length > 0) {
    parameter.push({ name: 'tools', valueString: JSON.stringify(request.tools) });
  }
  if (request.reasoningEffort) {
    parameter.push({ name: 'reasoning_effort', valueString: request.reasoningEffort });
  }
  return { resourceType: 'Parameters', parameter };
}

/**
 * The URL of the `$ai` operation.
 *
 * System scoped, so it hangs off the FHIR base rather than a resource type. The bot reaches it
 * with its own access token, like any other operation.
 * @param medplum - The bot's Medplum client.
 * @returns The absolute URL.
 */
function aiUrl(medplum: MedplumClient): string {
  return medplum.fhirUrl('$ai').toString();
}

/**
 * Calls `$ai` and returns its `Parameters` response.
 * @param medplum - The bot's Medplum client.
 * @param request - What to ask for.
 * @returns The `$ai` response.
 */
export async function callAi(medplum: MedplumClient, request: AiRequest): Promise<Parameters> {
  const response: Parameters = await medplum.post(aiUrl(medplum), buildAiParameters(request));
  return response;
}

/**
 * Incremental reader for an SSE `data:` stream.
 *
 * A chunk can split a line anywhere, so the trailing fragment is held back until a newline
 * arrives. `[DONE]` is dropped — it closes the stream rather than carrying a payload — and a frame
 * that does not parse is skipped rather than ending the read, which is how `$ai` itself treats a
 * bad frame from OpenAI.
 */
export class SseFrameParser {
  private buffer = '';

  /**
   * Feeds the next piece of the stream in.
   * @param text - Decoded text, which may begin or end mid-line.
   * @returns Every complete frame the text completed, in order.
   */
  push(text: string): SseFrame[] {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    const frames: SseFrame[] = [];
    for (const line of lines) {
      const frame = parseSseLine(line);
      if (frame) {
        frames.push(frame);
      }
    }
    return frames;
  }
}

/**
 * Parses one line of an SSE stream.
 * @param line - A single line, without its newline.
 * @returns The payload, or undefined for a comment, a blank line, `[DONE]`, or unparseable JSON.
 */
function parseSseLine(line: string): SseFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return undefined;
  }
  const data = trimmed.slice('data:'.length).trim();
  if (!data || data === '[DONE]') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Frames one SSE payload the way the Provider UI's reader expects to find it.
 * @param frame - The payload.
 * @returns The `data:` line, newline-terminated.
 */
export function formatSseFrame(frame: SseFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** Closes an SSE stream. The UI's reader skips it rather than treating it as content. */
export const SSE_DONE = 'data: [DONE]\n\n';

function isWebReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof (value as ReadableStream<Uint8Array> | null | undefined)?.getReader === 'function';
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | null | undefined)?.[Symbol.asyncIterator] === 'function';
}

/**
 * Reads an SSE response body, whichever kind of stream it turns out to be.
 *
 * Under the browser's and Node's built-in `fetch` a body is a WHATWG `ReadableStream`; the
 * `vmcontext` sandbox's `fetch` is node-fetch 2, whose body is a Node `Readable`. The sandbox also
 * has no `TextDecoderStream` — it is given `TextDecoder` and `TextEncoder` and nothing else — so
 * decoding is done by hand, with `{ stream: true }` so a multi-byte character split across chunks
 * survives.
 * @param body - The response body.
 * @param onFrame - Called with each parsed frame, in order.
 * @throws If the body is neither kind of stream, which means there is nothing to read.
 */
export async function readSseBody(body: unknown, onFrame: (frame: SseFrame) => void): Promise<void> {
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();

  const emit = (chunk: unknown): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    for (const frame of parser.push(text)) {
      onFrame(frame);
    }
  };

  if (isWebReadableStream(body)) {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      emit(value);
    }
    return;
  }

  if (isAsyncIterable(body)) {
    for await (const chunk of body) {
      emit(chunk);
    }
    return;
  }

  throw new Error('AI response had no readable body');
}

/**
 * Flushes a response that compression middleware would otherwise sit on.
 *
 * `BotResponseStream` does not declare `flush` — Express only grows one when `compression` is
 * mounted — but `$ai`'s own SSE handler calls it, which is evidence that it is mounted here.
 * Without it a gzipped stream arrives in one lump at the end, which is the difference between
 * word-by-word narration and a long blank pause followed by everything at once.
 * @param stream - The bot's response stream.
 */
function flush(stream: BotResponseStream): void {
  (stream as BotResponseStream & { flush?: () => void }).flush?.();
}

/** What a streamed call produced, for the bot's own record. */
export interface StreamAiResult {
  readonly content: string;
}

/**
 * Streams `$ai` straight through to the bot's own SSE response.
 *
 * Only `content` frames are forwarded. `$ai` also emits one `raw` frame per upstream chunk and at
 * most one `tool_calls` frame; the UI's reader looks for `content` and ignores everything else, and
 * neither is of any use to a narration or a chart, so forwarding them would only add bytes to
 * every stream.
 * @param medplum - The bot's Medplum client.
 * @param request - What to ask for.
 * @param stream - The bot's response stream, from `BotEvent.responseStream`.
 * @returns Everything the model said.
 * @throws If `$ai` rejected the request — raised before any header is committed, so it can still
 * become an HTTP error.
 */
export async function streamAiToResponse(
  medplum: MedplumClient,
  request: AiRequest,
  stream: BotResponseStream
): Promise<StreamAiResult> {
  const response = await fetch(aiUrl(medplum), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${medplum.getAccessToken()}`,
      'Content-Type': 'application/fhir+json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(buildAiParameters(request)),
  });

  // Checked before `startStreaming`, deliberately. `$ai` only switches to SSE once it has accepted
  // the request, so a rejection is still an ordinary JSON error at this point; after the 200 is on
  // the wire the same failure can no longer be reported as one.
  if (!response.ok) {
    throw new Error(`$ai returned ${response.status}: ${await response.text()}`);
  }

  stream.startStreaming(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let content = '';
  try {
    await readSseBody(response.body, (frame) => {
      if (typeof frame.content === 'string' && frame.content !== '') {
        content += frame.content;
        stream.write(formatSseFrame({ content: frame.content }));
        flush(stream);
      } else if (typeof frame.error === 'string') {
        // `$ai` reports a mid-stream failure in-band for the same reason this does: the status
        // line is long gone. Passing it on at least leaves a record in the browser.
        stream.write(formatSseFrame({ error: frame.error }));
        flush(stream);
      }
    });
  } finally {
    // Always terminate. The reader runs until `[DONE]` or the socket closes, so an unterminated
    // stream after a mid-read failure is the one outcome it cannot recover from.
    stream.write(SSE_DONE);
    flush(stream);
  }

  return { content };
}

/**
 * Builds the `Parameters` response the Provider UI reads when it did not ask for a stream.
 * @param content - The model's answer.
 * @returns A `Parameters` resource carrying `content`.
 */
export function toContentParameters(content: string | undefined): Parameters {
  return {
    resourceType: 'Parameters',
    parameter: content ? [{ name: 'content', valueString: content }] : [],
  };
}
