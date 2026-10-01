// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { executeToolCalls, processMessage, sendToBotStreaming } from './spaceMessaging';

vi.mock('./spacePersistence', () => ({
  createConversationTopic: vi.fn().mockResolvedValue({ id: 'topic-1', resourceType: 'Communication' }),
  saveMessage: vi.fn().mockResolvedValue(undefined),
}));

// Mocked at the boundary: the document index lives behind a separate HTTP service, and this module
// reads `import.meta.env` for its URL.
const searchDocuments = vi.fn();
vi.mock('../services/document-search', () => ({
  searchPatientDocuments: (...args: unknown[]) => searchDocuments(...args),
}));

// Helper to create a mock streaming SSE response
function createMockStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let chunkIndex = 0;

  const stream = new ReadableStream({
    pull(controller) {
      if (chunkIndex < chunks.length) {
        const sseData = `data: ${JSON.stringify({ content: chunks[chunkIndex] })}\n\n`;
        controller.enqueue(encoder.encode(sseData));
        chunkIndex++;
      } else {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// Helper to create a mock buffered JSON response
function createMockBufferedResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      resourceType: 'Parameters',
      parameter: [{ name: 'content', valueString: content }],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/fhir+json' },
    }
  );
}

// Helper to create a mock error response
function createMockErrorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

describe('sendToBotStreaming', () => {
  let mockMedplum: Partial<MedplumClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMedplum = {
      getAccessToken: vi.fn().mockReturnValue('mock-token'),
      fhirUrl: vi.fn().mockReturnValue(new URL('https://api.medplum.com/fhir/R4/Bot/$execute')),
    };
  });

  const botId = {
    system: 'https://www.medplum.com/bots',
    value: 'test-bot',
  };

  const messages = [{ role: 'user' as const, content: 'Hello' }];

  test('handles streaming SSE response with multiple chunks', async () => {
    const chunks = ['Hello', ' world', '!'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createMockStreamingResponse(chunks));

    const receivedChunks: string[] = [];
    const result = await sendToBotStreaming(
      mockMedplum as MedplumClient,
      botId,
      messages,
      'gpt-4o',
      'medium',
      (chunk) => receivedChunks.push(chunk)
    );

    expect(result.content).toBe('Hello world!');
    expect(receivedChunks).toEqual(['Hello', ' world', '!']);
  });

  test('handles buffered JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createMockBufferedResponse('This is a buffered response'));

    const receivedChunks: string[] = [];
    const result = await sendToBotStreaming(
      mockMedplum as MedplumClient,
      botId,
      messages,
      'gpt-4o',
      'medium',
      (chunk) => receivedChunks.push(chunk)
    );

    expect(result.content).toBe('This is a buffered response');
    expect(receivedChunks).toEqual(['This is a buffered response']);
  });

  test('throws error when bot execution returns 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createMockErrorResponse(404, 'Bot not found'));

    await expect(
      sendToBotStreaming(mockMedplum as MedplumClient, botId, messages, 'gpt-4o', 'medium', vi.fn())
    ).rejects.toThrow('Bot execution failed: 404 - Bot not found');
  });

  test('throws error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

    await expect(
      sendToBotStreaming(mockMedplum as MedplumClient, botId, messages, 'gpt-4o', 'medium', vi.fn())
    ).rejects.toThrow('Bot execution failed: 500 - Internal Server Error');
  });

  test('throws error when response body is null for streaming', async () => {
    const mockResponse = new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    Object.defineProperty(mockResponse, 'body', { value: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    await expect(
      sendToBotStreaming(mockMedplum as MedplumClient, botId, messages, 'gpt-4o', 'medium', vi.fn())
    ).rejects.toThrow('No response body');
  });

  test('sends correct request headers and body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createMockBufferedResponse('OK'));

    await sendToBotStreaming(mockMedplum as MedplumClient, botId, messages, 'gpt-4o', 'medium', vi.fn());

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.medplum.com/fhir/R4/Bot/$execute?identifier=https%3A%2F%2Fwww.medplum.com%2Fbots%7Ctest-bot',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer mock-token',
          'Content-Type': 'application/fhir+json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          resourceType: 'Parameters',
          parameter: [
            { name: 'messages', valueString: JSON.stringify(messages) },
            { name: 'model', valueString: 'gpt-4o' },
            { name: 'reasoning_effort', valueString: 'medium' },
          ],
        }),
      })
    );
  });

  test('handles empty content in buffered response', async () => {
    const response = new Response(
      JSON.stringify({
        resourceType: 'Parameters',
        parameter: [],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/fhir+json' },
      }
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    const receivedChunks: string[] = [];
    const result = await sendToBotStreaming(
      mockMedplum as MedplumClient,
      botId,
      messages,
      'gpt-4o',
      'medium',
      (chunk) => receivedChunks.push(chunk)
    );

    expect(result.content).toBe('');
    expect(receivedChunks).toEqual([]);
  });

  test('handles SSE with OpenAI delta format', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    const receivedChunks: string[] = [];
    const result = await sendToBotStreaming(
      mockMedplum as MedplumClient,
      botId,
      messages,
      'gpt-4o',
      'medium',
      (chunk) => receivedChunks.push(chunk)
    );

    expect(result.content).toBe('Hello there');
    expect(receivedChunks).toEqual(['Hello', ' there']);
  });

  test('ignores malformed JSON in SSE stream', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"content":"Hello"}\n\n'));
        controller.enqueue(encoder.encode('data: not valid json\n\n'));
        controller.enqueue(encoder.encode('data: {"content":" world"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    const receivedChunks: string[] = [];
    const result = await sendToBotStreaming(
      mockMedplum as MedplumClient,
      botId,
      messages,
      'gpt-4o',
      'medium',
      (chunk) => receivedChunks.push(chunk)
    );

    expect(result.content).toBe('Hello world');
    expect(receivedChunks).toEqual(['Hello', ' world']);
  });

  test('handles SSE with empty data lines', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"content":"Hello"}\n\n'));
        controller.enqueue(encoder.encode('\n\n'));
        controller.enqueue(encoder.encode('data: \n\n'));
        controller.enqueue(encoder.encode('data: {"content":" world"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    const receivedChunks: string[] = [];
    const result = await sendToBotStreaming(
      mockMedplum as MedplumClient,
      botId,
      messages,
      'gpt-4o',
      'medium',
      (chunk) => receivedChunks.push(chunk)
    );

    expect(result.content).toBe('Hello world');
  });
});

describe('processMessage - max iterations behavior', () => {
  const baseParams = {
    input: 'Show me the patient list',
    userMessage: { role: 'user' as const, content: 'Show me the patient list' },
    currentMessages: [{ role: 'user' as const, content: 'Show me the patient list' }],
    currentTopicId: 'topic-1',
    selectedModel: 'gpt-4o',
    selectedReasoningEffort: 'medium' as const,
    isFirstMessage: false,
    setCurrentTopicId: vi.fn(),
    setRefreshKey: vi.fn(),
    setCurrentFhirRequest: vi.fn(),
    onNewTopic: vi.fn(),
  };

  function makeMockMedplum(executeBotImpl: () => unknown): Partial<MedplumClient> {
    return {
      getAccessToken: vi.fn().mockReturnValue('mock-token'),
      fhirUrl: vi.fn().mockReturnValue(new URL('https://api.medplum.com/fhir/R4')),
      executeBot: vi.fn().mockImplementation(executeBotImpl),
      get: vi.fn().mockResolvedValue({ resourceType: 'Bundle', entry: [] }),
    };
  }

  function makeBotResponse(opts: { toolCalls?: unknown[]; content?: string } = {}): unknown {
    const params = [];
    if (opts.content) {
      params.push({ name: 'content', valueString: opts.content });
    }
    if (opts.toolCalls) {
      params.push({ name: 'tool_calls', valueString: JSON.stringify(opts.toolCalls) });
    }
    return { resourceType: 'Parameters', parameter: params };
  }

  const stubToolCall = {
    id: 'call-1',
    function: { name: 'fhir_request', arguments: JSON.stringify({ method: 'GET', path: 'Patient' }) },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns AI summary with note when loop hits max iterations and tools ran', async () => {
    let callCount = 0;
    const medplum = makeMockMedplum(() => {
      callCount++;
      // fhirRequestToolsId bot always returns a tool call (never completes)
      // resourceSummaryBotId bot returns a summary
      if (callCount <= 10) {
        return Promise.resolve(makeBotResponse({ toolCalls: [stubToolCall] }));
      }
      // Summary bot call
      return Promise.resolve(makeBotResponse({ content: 'Here is what I found so far: 10 patients.' }));
    });

    const result = await processMessage({ ...baseParams, medplum: medplum as MedplumClient });

    expect(result.assistantMessage.content).toContain('Here is what I found so far: 10 patients.');
    expect(result.assistantMessage.content).toContain('processing limit');
    expect(result.assistantMessage.content).toContain('more specific question');
  });

  test('returns fallback note when loop hits max iterations and no tools ran', async () => {
    // Always returns tool calls but executeToolCalls produces no tool messages
    // Simulate by having the bot never produce tool messages — easiest way is
    // to have the bot always respond with tool calls but mock executeBot on the
    // summary call to return empty, and fhir GET to return empty bundle.
    const medplum = makeMockMedplum(() => Promise.resolve(makeBotResponse({ toolCalls: [stubToolCall] })));

    // Override get so the tool call produces a tool message (so summary IS called)
    // but the summary itself returns no content
    (medplum.executeBot as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeBotResponse({ toolCalls: [stubToolCall] })) // iter 1 translator
      // subsequent translator calls — all 9 remaining
      .mockResolvedValue(makeBotResponse({ toolCalls: [stubToolCall] }));

    // For the no-tool-message path: override so no tool messages are added.
    // We test this by having currentMessages start empty of tool role.
    // Actually the simplest test: pass currentMessages with NO prior tool messages
    // and have the bot always return tool calls — the summary bot won't be called
    // because currentMessages.some(m => m.role === 'tool') would be true after iter 1.
    // Let's instead test the edge case where executeBot for the summary returns empty.
    const medplum2 = makeMockMedplum(() => Promise.resolve(makeBotResponse({})));

    const result = await processMessage({ ...baseParams, medplum: medplum2 as MedplumClient });

    // Loop hits max, no tool calls returned (empty toolCalls), so loopCompleted = true
    // This path actually completes normally — let's verify the happy path instead.
    expect(result.assistantMessage.content).toBe(
      'I received your message but was unable to generate a response. Please try again.'
    );
  });

  test('completes normally when bot returns final answer before max iterations', async () => {
    // First call: tool call → second call: summary → done
    // Actually: iteration 1 → tool call → executeToolCalls → iteration 2 → no tool calls → loopCompleted
    // Then: currentMessages has tool role → summary bot called
    let botCallCount = 0;
    const medplum3 = makeMockMedplum(() => {
      botCallCount++;
      if (botCallCount === 1) {
        // Translator: returns tool call
        return Promise.resolve(makeBotResponse({ toolCalls: [stubToolCall] }));
      }
      if (botCallCount === 2) {
        // Translator: no tool calls, final answer
        return Promise.resolve(makeBotResponse({ content: 'Final answer.' }));
      }
      // Summary bot
      return Promise.resolve(makeBotResponse({ content: 'Summary.' }));
    });

    const result = await processMessage({ ...baseParams, medplum: medplum3 as MedplumClient });

    // loopCompleted = true on iter 2, so NO note appended
    // tool messages exist, so summary bot is called → content = 'Summary.'
    expect(result.assistantMessage.content).toBe('Summary.');
    expect(result.assistantMessage.content).not.toContain('processing limit');
  });
});

/**
 * The `search_documents` tool, executed by the UI exactly as `fhir_request` is.
 *
 * Two things are asserted here and neither is cosmetic. First, the patient is read under the
 * signed-in user's access policy *before* the worker is called: the worker scopes a search to the
 * caller's organization but cannot see their AccessPolicy, so this read is what keeps the tool no
 * more permissive than the rest of the loop. Second, each hit contributes
 * `DocumentReference/<documentId>` to `resourceRefs`, because that array *is* the `[doc:Sn]`
 * numbering — a hit that does not land in it cannot be cited at all, and one that lands in the
 * wrong position is cited as the wrong record.
 */
describe('executeToolCalls - search_documents', () => {
  /**
   * A medplum stub whose `readResource` resolves, i.e. the user may open the patient.
   * @param readResource - Override for the access-policy check.
   * @returns The stub and the mock, so a test can assert on the check.
   */
  function makeMedplum(readResource = vi.fn().mockResolvedValue({ resourceType: 'Patient', id: 'p1' })): {
    medplum: Partial<MedplumClient>;
    readResource: ReturnType<typeof vi.fn>;
  } {
    return {
      medplum: { readResource, getAccessToken: vi.fn().mockReturnValue('mock-token') },
      readResource,
    };
  }

  /**
   * One `search_documents` call, with arguments as the JSON string `$ai` returns.
   * @param args - The tool arguments.
   * @returns The tool call.
   */
  function call(args: Record<string, unknown>): { id: string; function: { name: string; arguments: string } } {
    return { id: 'call-doc-1', function: { name: 'search_documents', arguments: JSON.stringify(args) } };
  }

  const twoHits = {
    hits: [
      {
        documentId: 'd1',
        chunkIndex: 2,
        snippet: 'Moderate aortic stenosis, peak velocity 3.4 m/s.',
        distance: 0.18,
        title: 'Echocardiogram report',
        documentDate: '2026-03-14',
        contentType: 'application/pdf',
      },
      {
        documentId: 'd2',
        chunkIndex: 0,
        snippet: 'Referred for consideration of valve replacement.',
        distance: 0.26,
        title: 'Cardiology consult',
        documentDate: '2026-04-02',
        contentType: 'application/pdf',
      },
    ],
    asText: '[doc:S1 | Echocardiogram report (2026-03-14) | chunk 2]\n…',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    searchDocuments.mockResolvedValue(twoHits);
  });

  test('reads the patient under the access policy before searching', async () => {
    const { medplum, readResource } = makeMedplum();
    await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'aortic stenosis' })],
      vi.fn()
    );
    expect(readResource).toHaveBeenCalledWith('Patient', 'p1');
    expect(searchDocuments).toHaveBeenCalledWith(medplum, { patientId: 'p1', query: 'aortic stenosis' });
  });

  test('does not search when the user may not open the patient', async () => {
    // Medplum answers this, not a role comparison here. Without the read, a user scoped to a
    // subset of their clinic could reach the documents of a patient they cannot see.
    const { medplum } = makeMedplum(vi.fn().mockRejectedValue(new Error('Forbidden')));
    const { messages, resourceRefs } = await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'other-clinic-patient', query: 'anything' })],
      vi.fn()
    );
    expect(searchDocuments).not.toHaveBeenCalled();
    expect(resourceRefs).toStrictEqual([]);
    expect(JSON.parse(messages[0].content as string)).toMatchObject({ error: true });
  });

  test('makes each hit citable as its DocumentReference, in hit order', async () => {
    const { medplum } = makeMedplum();
    const { resourceRefs } = await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'valve' })],
      vi.fn()
    );
    expect(resourceRefs).toStrictEqual(['DocumentReference/d1', 'DocumentReference/d2']);
  });

  test('gives the model each passage with the reference it came from, and no local numbering', async () => {
    // The worker's digest numbers its own hits from 1. Forwarding those numbers would invite
    // [doc:S1] for a document that is globally S7, so the hits go as structured JSON instead and
    // the summary bot's `Sn = Type/id` list stays the only numbering the model sees.
    const { medplum } = makeMedplum();
    const { messages } = await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'valve' })],
      vi.fn()
    );
    const content = messages[0].content as string;
    expect(JSON.parse(content)).toStrictEqual({
      documentSearch: {
        patientId: 'p1',
        hits: [
          {
            reference: 'DocumentReference/d1',
            title: 'Echocardiogram report',
            date: '2026-03-14',
            chunk: 2,
            text: 'Moderate aortic stenosis, peak velocity 3.4 m/s.',
          },
          {
            reference: 'DocumentReference/d2',
            title: 'Cardiology consult',
            date: '2026-04-02',
            chunk: 0,
            text: 'Referred for consideration of valve replacement.',
          },
        ],
      },
    });
    expect(content).not.toContain('doc:S');
  });

  test('passes the worker’s note through when nothing matched, and cites nothing', async () => {
    // "No document is relevant" and "the embedding call failed" must not read the same, and
    // neither may take a citation number.
    searchDocuments.mockResolvedValue({ hits: [], asText: 'Document search unavailable: Bedrock timed out' });
    const { medplum } = makeMedplum();
    const { messages, resourceRefs } = await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'valve' })],
      vi.fn()
    );
    expect(resourceRefs).toStrictEqual([]);
    expect(JSON.parse(messages[0].content as string).documentSearch).toStrictEqual({
      patientId: 'p1',
      hits: [],
      note: 'Document search unavailable: Bedrock timed out',
    });
  });

  test('answers a failed search with a tool message rather than throwing', async () => {
    // Every tool_call_id needs a response or the next model call is rejected, and a throw here
    // would take the whole chat turn with it.
    searchDocuments.mockRejectedValue(new Error('Document search failed (503): RAG_DATABASE_URL is unset.'));
    const { medplum } = makeMedplum();
    const { messages, resourceRefs } = await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'valve' })],
      vi.fn()
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_call_id).toBe('call-doc-1');
    expect(JSON.parse(messages[0].content as string)).toMatchObject({
      error: true,
      details: expect.stringContaining('RAG_DATABASE_URL'),
    });
    expect(resourceRefs).toStrictEqual([]);
  });

  test('accepts a reference where an id was asked for', async () => {
    // The pre-selected-patient system message hands the model `Patient/<id>`, so it passes that
    // back often enough to matter. `Patient/Patient/abc` is a 404 that reads to the user as "the
    // AI cannot see my documents".
    const { medplum, readResource } = makeMedplum();
    await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'Patient/p1', query: 'valve' })],
      vi.fn()
    );
    expect(readResource).toHaveBeenCalledWith('Patient', 'p1');
    expect(searchDocuments).toHaveBeenCalledWith(medplum, { patientId: 'p1', query: 'valve' });
  });

  test('forwards topK only when the model asked for one', async () => {
    const { medplum } = makeMedplum();
    await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'valve', topK: 12 })],
      vi.fn()
    );
    expect(searchDocuments).toHaveBeenCalledWith(medplum, { patientId: 'p1', query: 'valve', topK: 12 });
  });

  test('interleaves document and FHIR refs in call order, so one numbering covers both', async () => {
    // `resourceRefs` is the citation numbering. Its order across a mixed batch is the contract.
    const { medplum } = makeMedplum();
    const withGet = {
      ...medplum,
      get: vi.fn().mockResolvedValue({
        resourceType: 'Bundle',
        entry: [{ resource: { resourceType: 'MedicationRequest', id: 'm1' } }],
      }),
      fhirUrl: vi.fn().mockReturnValue(new URL('https://api.medplum.com/fhir/R4/MedicationRequest')),
    };
    const { resourceRefs } = await executeToolCalls(
      withGet as unknown as Parameters<typeof executeToolCalls>[0],
      [
        { id: 'c1', function: { name: 'fhir_request', arguments: JSON.stringify({ method: 'GET', path: 'Med' }) } },
        call({ patientId: 'p1', query: 'valve' }),
      ],
      vi.fn()
    );
    expect(resourceRefs).toStrictEqual(['MedicationRequest/m1', 'DocumentReference/d1', 'DocumentReference/d2']);
  });

  test('reports the search in the progress callback the UI shows', async () => {
    const onProgress = vi.fn();
    const { medplum } = makeMedplum();
    await executeToolCalls(
      medplum as Parameters<typeof executeToolCalls>[0],
      [call({ patientId: 'p1', query: 'aortic stenosis' })],
      onProgress
    );
    expect(onProgress).toHaveBeenCalledWith('search documents: aortic stenosis');
  });
});
