// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { getDisplayString, getReferenceString, isNotFound, OperationOutcomeError } from '@medplum/core';
import type { Bundle, Communication, Identifier, Patient, Reference, Resource, ResourceType } from '@medplum/fhirtypes';
import type { useMedplum } from '@medplum/react';
import type { DocumentSearchResult } from '../services/document-search';
import { searchPatientDocuments } from '../services/document-search';
import type { Message } from '../types/spaces';
import type { ReasoningEffort } from './spaceModels';
import { createConversationTopic, saveMessage } from './spacePersistence';

const fhirRequestToolsId: Identifier = {
  value: 'ai-fhir-request-tools',
  system: 'https://www.medplum.com/bots',
};

const resourceSummaryBotId: Identifier = {
  value: 'ai-resource-summary',
  system: 'https://www.medplum.com/bots',
};

const resourceSummaryBotSseId: Identifier = {
  value: 'ai-resource-summary-sse',
  system: 'https://www.medplum.com/bots',
};

const componentGeneratorBotSseId: Identifier = {
  value: 'ai-component-generator-sse',
  system: 'https://www.medplum.com/bots',
};

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface FhirRequestArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

interface SearchDocumentsArgs {
  patientId: string;
  query: string;
  topK?: number;
}

export interface ExecuteToolCallsResult {
  messages: Message[];
  resourceRefs: string[];
}

/** One chunk, as the model is shown it. */
export interface DocumentSearchToolHit {
  /** `DocumentReference/<id>` — the same string the citation numbering uses. */
  reference: string;
  title: string | null;
  date: string | null;
  chunk: number;
  text: string;
}

/** The `search_documents` tool result, as it is stored on the tool message. */
export interface DocumentSearchToolResult {
  documentSearch: {
    patientId: string;
    hits: DocumentSearchToolHit[];
    /** Present only when nothing matched, where it says why. */
    note?: string;
  };
}

/**
 * The reference a document hit is cited as.
 *
 * The RAG index keys a chunk by its `DocumentReference.id`, so a hit already
 * has a FHIR identity and needs no new one. That is what lets document hits
 * join the single `[doc:Sn]` numbering instead of needing a namespace of their
 * own — see {@link toDocumentSearchToolResult}.
 * @param documentId - The `DocumentReference` id from a hit.
 * @returns The reference string.
 */
export function documentReferenceString(documentId: string): string {
  return `DocumentReference/${documentId}`;
}

/**
 * Turn a worker search result into the tool result the model reads.
 *
 * ## One numbering, and why the worker's own numbers are dropped
 *
 * `[doc:Sn]` means "the nth entry of this message's `resources` array" and
 * nothing else (`src/components/lyfe-ai/citations.ts`). That array is built
 * here, by walking tool results in order and de-duplicating, so a document hit
 * becomes citable simply by being a reference in it —
 * `DocumentReference/<documentId>` — interleaved with the FHIR resources
 * `fhir_request` returned. Documents and resources therefore share one
 * numbering by construction, and a pill resolves to a real source card because
 * `DocumentReference` is a real resource the signed-in user can open.
 *
 * The worker's digest (`asText`) already labels its hits `[doc:S1]`, `[doc:S2]`
 * … but those numbers are **local to one search**: they count from 1 whatever
 * else the loop has fetched. Showing them to the model would invite it to copy
 * `[doc:S1]` for a document that is globally S7 — and a citation pointing at
 * the wrong record does not look like an error to a clinician, it looks like a
 * fact. So the digest's numbering is not forwarded. The hits are forwarded as
 * structured JSON, like every other tool result in this loop, each carrying its
 * reference string; the authoritative numbers are the `Sn = Type/id` list the
 * summary bot computes with `collectCitableSources` and appends to its own
 * prompt, and the model matches a snippet to a number through that reference.
 *
 * `asText` is still used when nothing matched, because there it is prose rather
 * than a numbered list and it is the only thing that distinguishes "no document
 * is relevant" from "the embedding call failed" — a difference the model is
 * required to report honestly rather than as an absence of data.
 * @param result - What the worker returned.
 * @param patientId - The patient searched, echoed so the model can see it.
 * @returns The tool result.
 */
export function toDocumentSearchToolResult(
  result: DocumentSearchResult,
  patientId: string
): DocumentSearchToolResult {
  const hits = result.hits.map((hit) => ({
    reference: documentReferenceString(hit.documentId),
    title: hit.title,
    date: hit.documentDate,
    chunk: hit.chunkIndex,
    text: hit.snippet,
  }));
  return {
    documentSearch: {
      patientId,
      hits,
      ...(hits.length === 0 && { note: result.asText }),
    },
  };
}

/**
 * Read a tool call's arguments, whichever form they arrived in.
 *
 * `$ai` parses them into an object; a replayed conversation carries the JSON
 * string OpenAI's schema requires. Both reach here.
 * @param toolCall - The call.
 * @returns The arguments.
 */
function toolArguments<T>(toolCall: ToolCall): T {
  return typeof toolCall.function.arguments === 'string'
    ? (JSON.parse(toolCall.function.arguments) as T)
    : (toolCall.function.arguments as unknown as T);
}

async function executeFhirRequest(medplum: ReturnType<typeof useMedplum>, args: FhirRequestArgs): Promise<Resource> {
  const { method, path, body } = args;
  switch (method) {
    case 'GET':
      return medplum.get(medplum.fhirUrl(path));
    case 'POST':
      return medplum.post(medplum.fhirUrl(path), body);
    case 'PUT':
      return medplum.put(medplum.fhirUrl(path), body);
    case 'DELETE':
      return medplum.delete(medplum.fhirUrl(path));
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }
}

function extractResourceRefs(result: Resource | Bundle): string[] {
  const refs: string[] = [];
  if (result.resourceType === 'Bundle' && result.entry) {
    for (const entry of result.entry) {
      if (entry.resource) {
        const ref = getReferenceString(entry.resource);
        if (ref) {
          refs.push(ref);
        }
      }
    }
  } else {
    const ref = getReferenceString(result);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

export class StreamingCodeExtractor {
  private buffer = '';
  private code = '';
  private inCodeBlock = false;

  process(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      if (!this.inCodeBlock) {
        const startMatch = this.buffer.match(/```(?:jsx|tsx|javascript|js)?\s*\n/);
        if (startMatch?.index !== undefined) {
          this.inCodeBlock = true;
          this.buffer = this.buffer.slice(startMatch.index + startMatch[0].length);
        } else {
          break;
        }
      }

      if (this.inCodeBlock) {
        const endIndex = this.buffer.indexOf('```');
        if (endIndex !== -1) {
          this.code += this.buffer.slice(0, endIndex);
          this.buffer = this.buffer.slice(endIndex + 3);
          this.inCodeBlock = false;
        } else {
          // Keep last 3 chars in buffer in case ``` spans chunks
          const safeLength = Math.max(0, this.buffer.length - 3);
          this.code += this.buffer.slice(0, safeLength);
          this.buffer = this.buffer.slice(safeLength);
          break;
        }
      }
    }
  }

  getCode(): string | undefined {
    const trimmed = this.code.trim();
    return trimmed || undefined;
  }
}

export async function collectFhirData(medplum: MedplumClient, refs: string[]): Promise<Resource[]> {
  const results = await Promise.all(
    refs.map(async (ref) => {
      try {
        const [resourceType, id] = ref.split('/');
        return await medplum.readResource(resourceType as ResourceType, id);
      } catch (error) {
        if (!(error instanceof OperationOutcomeError && isNotFound(error.outcome))) {
          console.error(`Failed to fetch ${ref}:`, error);
        }
        return undefined;
      }
    })
  );
  return results.filter((resource) => resource !== undefined);
}

export async function executeToolCalls(
  medplum: ReturnType<typeof useMedplum>,
  toolCalls: ToolCall[],
  onFhirRequest: (request: string) => void
): Promise<ExecuteToolCallsResult> {
  const messages: Message[] = [];
  const resourceRefs: string[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.function.name === 'fhir_request') {
      const args = toolArguments<FhirRequestArgs>(toolCall);

      onFhirRequest(`${args.method} ${args.path}`);

      try {
        const result = await executeFhirRequest(medplum, args);
        resourceRefs.push(...extractResourceRefs(result));

        const toolMessage: Message = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
        messages.push(toolMessage);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        const toolErrorMessage: Message = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: true,
            message: `Unable to execute ${args.method}: ${args.path}`,
            details: errorMessage,
          }),
        };
        messages.push(toolErrorMessage);
      }
    } else if (toolCall.function.name === 'search_documents') {
      const args = toolArguments<SearchDocumentsArgs>(toolCall);

      // A bare id, whatever the model sent. The pre-selected-patient system message gives it
      // `Patient/<id>`, so it will sometimes pass that back despite the tool description — and
      // `Patient/Patient/abc` is a 404, which reads to the user as "the AI cannot see my
      // documents" rather than as a malformed request.
      const patientId = String(args.patientId ?? '').replace(/^Patient\//, '');

      onFhirRequest(`search documents: ${args.query}`);

      try {
        // The patient is read first, under the signed-in user's access policy,
        // and the search only happens if that read succeeds.
        //
        // Everything else in this loop is bounded by that policy because
        // Medplum applies it to each request. The document index is not: the
        // worker scopes a search to the caller's *organization*, resolved from
        // their own token, and has no view of their AccessPolicy. Without this
        // read, a user restricted to a subset of their clinic's patients could
        // reach documents belonging to a patient they cannot open — same
        // clinic, but not theirs to see. Asking Medplum is the whole check;
        // there is no role comparison here to get wrong.
        await medplum.readResource('Patient', patientId);

        const result = await searchPatientDocuments(medplum, {
          patientId,
          query: args.query,
          ...(typeof args.topK === 'number' && { topK: args.topK }),
        });

        // In hit order, so the numbering follows relevance. Repeats — two
        // chunks of one document — are collapsed by the same `Set` that
        // de-duplicates FHIR refs, so both chunks cite one source card.
        resourceRefs.push(...result.hits.map((hit) => documentReferenceString(hit.documentId)));

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toDocumentSearchToolResult(result, patientId)),
        });
      } catch (err) {
        // No refs are pushed on failure, so a failed search contributes nothing
        // citable. The model is told it failed and answers from the structured
        // chart instead, which is better than silently reading as "the patient
        // has no documents".
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: true,
            message: `Unable to search documents for Patient/${patientId}`,
            details: errorMessage,
          }),
        });
      }
    } else if (toolCall.function.name === 'set_visualization') {
      // Acknowledge visualization tool call (handled separately via visualize flag)
      const toolMessage: Message = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({ acknowledged: true }),
      };
      messages.push(toolMessage);
    } else {
      // Handle unrecognized tool calls - OpenAI requires a response for every tool_call_id
      const toolErrorMessage: Message = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: true,
          message: `Unrecognized tool: ${toolCall.function.name}`,
        }),
      };
      messages.push(toolErrorMessage);
    }
  }

  return { messages, resourceRefs };
}

/**
 * Strip display-only fields that should not be sent to the AI API
 * @param messages - The messages to strip
 * @returns Messages with only API-relevant fields
 */
function toApiMessages(messages: Message[]): Pick<Message, 'role' | 'content' | 'tool_calls' | 'tool_call_id'>[] {
  return messages.map(({ role, content, tool_calls, tool_call_id }) => ({
    role,
    content,
    ...(tool_calls !== undefined && { tool_calls }),
    ...(tool_call_id !== undefined && { tool_call_id }),
  }));
}

export async function sendToBot(
  medplum: ReturnType<typeof useMedplum>,
  botId: Identifier,
  messages: Message[],
  model: string,
  reasoningEffort: ReasoningEffort
): Promise<{ content?: string; toolCalls?: ToolCall[]; visualize?: boolean }> {
  const response = await medplum.executeBot(botId, {
    resourceType: 'Parameters',
    parameter: [
      { name: 'messages', valueString: JSON.stringify(toApiMessages(messages)) },
      { name: 'model', valueString: model },
      { name: 'reasoning_effort', valueString: reasoningEffort },
    ],
  });

  const content = response.parameter?.find((p: { name: string }) => p.name === 'content')?.valueString;
  const toolCallsStr = response.parameter?.find((p: { name: string }) => p.name === 'tool_calls')?.valueString;
  const toolCalls = toolCallsStr ? JSON.parse(toolCallsStr) : undefined;
  const visualize = response.parameter?.find((p: { name: string }) => p.name === 'visualize')?.valueBoolean;

  return { content, toolCalls, visualize };
}

export interface StreamingResult {
  content: string;
  code?: string;
}

export async function sendToBotStreaming(
  medplum: ReturnType<typeof useMedplum>,
  botId: Identifier,
  messages: Message[],
  model: string,
  reasoningEffort: ReasoningEffort,
  onChunk: (chunk: string) => void,
  additionalParams?: { name: string; valueString: string }[]
): Promise<StreamingResult> {
  const baseUrl = medplum.fhirUrl('Bot', '$execute').toString();
  const url = `${baseUrl}?identifier=${encodeURIComponent(`${botId.system}|${botId.value}`)}`;
  const codeExtractor = new StreamingCodeExtractor();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${medplum.getAccessToken()}`,
      'Content-Type': 'application/fhir+json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      resourceType: 'Parameters',
      parameter: [
        { name: 'messages', valueString: JSON.stringify(toApiMessages(messages)) },
        { name: 'model', valueString: model },
        { name: 'reasoning_effort', valueString: reasoningEffort },
        ...(additionalParams || []),
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bot execution failed: ${response.status} - ${errorText}`);
  }

  const contentType = response.headers.get('Content-Type') || '';
  const isStreaming = contentType.includes('text/event-stream');

  // Handle non-streaming (buffered) JSON response
  if (!isStreaming) {
    const data = await response.json();
    const content = data.parameter?.find((p: { name: string }) => p.name === 'content')?.valueString || '';
    if (content) {
      onChunk(content);
      codeExtractor.process(content);
    }
    return { content, code: codeExtractor.getCode() };
  }

  // Handle streaming SSE response
  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let fullContent = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (!data || data === '[DONE]') {
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const chunk = parsed.content || parsed.choices?.[0]?.delta?.content;
          if (chunk) {
            fullContent += chunk;
            codeExtractor.process(chunk);
            onChunk(chunk);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  return { content: fullContent, code: codeExtractor.getCode() };
}

export interface ProcessMessageParams {
  medplum: ReturnType<typeof useMedplum>;
  input: string;
  userMessage: Message;
  currentMessages: Message[];
  currentTopicId: string | undefined;
  selectedModel: string;
  selectedReasoningEffort: ReasoningEffort;
  isFirstMessage: boolean;
  setCurrentTopicId: (id: string | undefined) => void;
  setRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  setCurrentFhirRequest: (request: string | undefined) => void;
  onNewTopic: (topic: Communication) => void;
  onStreamChunk?: (chunk: string) => void;
  onComponentStart?: () => void;
  onComponentStreamChunk?: (chunk: string) => void;
  selectedPatients?: (Patient | Reference<Patient>)[];
}

export interface ProcessMessageResult {
  activeTopicId: string | undefined;
  assistantMessage: Message;
  updatedMessages: Message[];
}

export async function processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult> {
  const {
    medplum,
    input,
    userMessage,
    currentMessages,
    currentTopicId,
    selectedModel,
    selectedReasoningEffort,
    isFirstMessage,
    setCurrentTopicId,
    setRefreshKey,
    setCurrentFhirRequest,
    onNewTopic,
    onStreamChunk,
    onComponentStart,
    onComponentStreamChunk,
    selectedPatients,
  } = params;

  // Create topic on first message
  let activeTopicId = currentTopicId;
  if (isFirstMessage) {
    const newTopic = await createConversationTopic(medplum, input.substring(0, 100), selectedModel);
    activeTopicId = newTopic.id;
    setCurrentTopicId(activeTopicId);
    setRefreshKey((prev) => prev + 1);
    onNewTopic(newTopic);
  }

  // Save user message
  if (activeTopicId) {
    await saveMessage(medplum, activeTopicId, userMessage, currentMessages.length - 1);
  }

  if (selectedPatients && selectedPatients.length > 0) {
    const patientLines = selectedPatients.map((p) => {
      const displayName = 'resourceType' in p ? getDisplayString(p) : (p.display ?? 'Unknown');
      return `- ${displayName} (${getReferenceString(p)})`;
    });
    const patientContext: Message = {
      role: 'system',
      content: `The user has pre-selected the following patient(s) for this request. Use these patient references when the request involves a patient and do not ask which patient:\n${patientLines.join('\n')}`,
    };
    currentMessages.push(patientContext);
  }

  const MAX_AGENT_ITERATIONS = 10;
  const allResourceRefs: string[] = [];
  let visualize = false;
  let content: string | undefined;
  let loopCompleted = false;

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    const translatorResponse = await sendToBot(
      medplum,
      fhirRequestToolsId,
      currentMessages,
      selectedModel,
      selectedReasoningEffort
    );

    // No tool calls = bot is done, has final answer
    if (!translatorResponse.toolCalls || translatorResponse.toolCalls.length === 0) {
      content = translatorResponse.content;
      loopCompleted = true;
      break;
    }

    if (translatorResponse.visualize) {
      visualize = true;
    }

    const assistantMessageWithToolCalls: Message = {
      role: 'assistant',
      content: null,
      tool_calls: translatorResponse.toolCalls,
    };
    currentMessages.push(assistantMessageWithToolCalls);

    const { messages: toolMessages, resourceRefs } = await executeToolCalls(
      medplum,
      translatorResponse.toolCalls,
      (request) => setCurrentFhirRequest(`Step ${iteration + 1}: ${request}`)
    );
    currentMessages.push(...toolMessages);
    allResourceRefs.push(...resourceRefs);

    // Persist per-iteration (keeps DB recoverable if mid-loop failure)
    if (activeTopicId) {
      const baseSequence = currentMessages.length - 1 - toolMessages.length;
      for (let i = 0; i < toolMessages.length; i++) {
        await saveMessage(medplum, activeTopicId, toolMessages[i], baseSequence + 1 + i);
      }
      await saveMessage(medplum, activeTopicId, assistantMessageWithToolCalls, baseSequence);
    }

    // Reset FHIR indicator while bot thinks about next step
    setCurrentFhirRequest(undefined);
  }

  // Get summary response after tool execution (streaming if callback provided)
  if (currentMessages.some((m) => m.role === 'tool')) {
    if (onStreamChunk) {
      const result = await sendToBotStreaming(
        medplum,
        resourceSummaryBotSseId,
        currentMessages,
        selectedModel,
        selectedReasoningEffort,
        onStreamChunk
      );
      content = result.content;
    } else {
      const summaryResponse = await sendToBot(
        medplum,
        resourceSummaryBotId,
        currentMessages,
        selectedModel,
        selectedReasoningEffort
      );
      content = summaryResponse.content;
    }
  }

  if (!loopCompleted && content) {
    content +=
      '\n\n_Note: The request reached the processing limit before fully completing. Try a more specific question or break it into smaller parts._';
  } else if (!loopCompleted) {
    content =
      'The request reached the processing limit before any results could be gathered. Try a more specific question or break it into smaller parts.';
  }

  let componentCode: string | undefined;
  if (visualize && allResourceRefs.length > 0) {
    // Signal that component generation has begun so the UI can show feedback
    // while we fetch FHIR data and wait for the bot's first streamed chunk.
    onComponentStart?.();

    const fhirData = await collectFhirData(medplum, allResourceRefs);

    const componentChunkCallback = onComponentStreamChunk ?? onStreamChunk;
    if (componentChunkCallback) {
      const result = await sendToBotStreaming(
        medplum,
        componentGeneratorBotSseId,
        currentMessages,
        selectedModel,
        selectedReasoningEffort,
        componentChunkCallback,
        [{ name: 'fhirData', valueString: JSON.stringify(fhirData) }]
      );
      componentCode = result.code;
    } else {
      await sendToBot(medplum, componentGeneratorBotSseId, currentMessages, selectedModel, selectedReasoningEffort);
    }
  }

  const uniqueRefs = allResourceRefs.length > 0 ? [...new Set(allResourceRefs)] : undefined;
  const assistantMessage: Message = {
    role: 'assistant',
    content: content || 'I received your message but was unable to generate a response. Please try again.',
    resources: uniqueRefs,
    componentCode,
  };

  if (activeTopicId) {
    await saveMessage(medplum, activeTopicId, assistantMessage, currentMessages.length);
  }

  return {
    activeTopicId,
    assistantMessage,
    updatedMessages: [...currentMessages, assistantMessage],
  };
}
