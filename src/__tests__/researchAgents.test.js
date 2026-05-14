import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reformulateQuery, runResearchAgent, runStreamingResearchAgent } from '../researchAgents.js';

// Mock the LLM module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => [
    { name: 'mock_search', description: 'A mock search tool', input_schema: { type: 'object', properties: {} } },
  ]),
}));

import { createMessage, streamMessage } from '../llm.js';
import { executeTool, getToolDefinitions } from '../tools/index.js';

/**
 * Helper to create a mock LLM text response.
 */
function mockTextResponse(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/**
 * Helper to create a mock LLM tool_use response.
 */
function mockToolUseResponse(toolName, toolInput, toolId = 'tool_123') {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input: toolInput }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/**
 * Helper to create a mock async iterable for streamMessage.
 */
function mockStreamEvents(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('reformulateQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use Haiku model via createMessage', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse('optimized search query for jira tickets')
    );

    const result = await reformulateQuery('fix login bug', 'jira');

    expect(createMessage).toHaveBeenCalledWith({
      model: 'haiku',
      system: expect.stringContaining('query reformulation expert'),
      messages: [{ role: 'user', content: 'fix login bug' }],
      maxTokens: 128,
    });
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('jira'),
      })
    );
    expect(result).toBe('optimized search query for jira tickets');
  });

  it('should fall back to original query on error', async () => {
    createMessage.mockRejectedValue(new Error('LLM service unavailable'));

    const result = await reformulateQuery('original query text', 'confluence');

    expect(result).toBe('original query text');
  });

  it('should fall back to original query when response has no text block', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 0 },
    });

    const result = await reformulateQuery('my query', 'docs');

    expect(result).toBe('my query');
  });

  it('should trim whitespace from reformulated query', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse('  reformulated query with spaces  ')
    );

    const result = await reformulateQuery('test', 'web');

    expect(result).toBe('reformulated query with spaces');
  });

  it('should include the domain in the system prompt', async () => {
    createMessage.mockResolvedValue(mockTextResponse('reformulated'));

    await reformulateQuery('test query', 'confluence');

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('confluence'),
      })
    );
  });
});

describe('runResearchAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: reformulateQuery returns the reformulated text
    createMessage.mockResolvedValue(mockTextResponse('reformulated query'));
  });

  it('should perform multi-turn tool calling', async () => {
    // Call 1: reformulateQuery
    // Call 2: LLM requests tool use
    // Call 3: LLM returns final text
    createMessage
      .mockResolvedValueOnce(mockTextResponse('reformulated query'))  // reformulateQuery
      .mockResolvedValueOnce(mockToolUseResponse('mock_search', { query: 'reformulated query' }))  // first research turn
      .mockResolvedValueOnce(mockTextResponse(JSON.stringify({
        domain: 'jira',
        found: true,
        summary: 'Found 3 tickets',
        details: ['TICKET-1', 'TICKET-2', 'TICKET-3'],
      })));  // final response

    executeTool.mockResolvedValue({ results: [{ key: 'TICKET-1' }] });

    const result = await runResearchAgent({ query: 'login issue', domain: 'jira' });

    // createMessage called 3 times: reformulate + 2 research turns
    expect(createMessage).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledWith('mock_search', { query: 'reformulated query' });
    expect(result.success).toBe(true);
    expect(result.sources).toEqual(['TICKET-1', 'TICKET-2', 'TICKET-3']);
  });

  it('should handle tool errors gracefully', async () => {
    createMessage
      .mockResolvedValueOnce(mockTextResponse('reformulated'))  // reformulateQuery
      .mockResolvedValueOnce(mockToolUseResponse('mock_search', { query: 'test' }))  // tool use
      .mockResolvedValueOnce(mockTextResponse(JSON.stringify({
        domain: 'jira',
        found: false,
        summary: 'Tool failed but recovered',
        details: [],
      })));  // final response after tool error

    executeTool.mockRejectedValue(new Error('Tool connection refused'));

    const result = await runResearchAgent({ query: 'test', domain: 'jira' });

    // Should still complete — tool error is passed back to LLM
    expect(createMessage).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('Tool failed but recovered');
  });

  it('should respect max turns limit', async () => {
    // reformulateQuery call
    createMessage.mockResolvedValueOnce(mockTextResponse('reformulated'));

    // All subsequent calls return tool_use (infinite loop scenario)
    createMessage.mockResolvedValue(mockToolUseResponse('mock_search', { query: 'test' }));
    executeTool.mockResolvedValue({ results: [] });

    const result = await runResearchAgent({ query: 'test', domain: 'jira' });

    // 1 reformulate + 5 research turns (MAX_RESEARCH_TURNS = 5)
    expect(createMessage).toHaveBeenCalledTimes(6);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('maximum turns');
  });

  it('should use reformulated query in research messages', async () => {
    createMessage
      .mockResolvedValueOnce(mockTextResponse('better search terms'))  // reformulateQuery
      .mockResolvedValueOnce(mockTextResponse(JSON.stringify({
        domain: 'docs',
        found: true,
        summary: 'Found docs',
        details: [],
      })));

    await runResearchAgent({ query: 'original query', domain: 'docs' });

    // Second call (research) should use the reformulated query
    const researchCall = createMessage.mock.calls[1];
    expect(researchCall[0].messages[0].content).toBe('better search terms');
  });

  it('should use provided tools when specified', async () => {
    const customTools = [
      { name: 'custom_tool', description: 'Custom', input_schema: { type: 'object' } },
    ];

    createMessage
      .mockResolvedValueOnce(mockTextResponse('reformulated'))
      .mockResolvedValueOnce(mockTextResponse('result'));

    await runResearchAgent({ query: 'test', domain: 'jira', tools: customTools });

    const researchCall = createMessage.mock.calls[1];
    expect(researchCall[0].tools).toEqual(customTools);
    // getToolDefinitions should NOT be called when tools are provided
    expect(getToolDefinitions).not.toHaveBeenCalled();
  });

  it('should use custom system prompt when provided', async () => {
    createMessage
      .mockResolvedValueOnce(mockTextResponse('reformulated'))
      .mockResolvedValueOnce(mockTextResponse('result'));

    await runResearchAgent({
      query: 'test',
      domain: 'jira',
      systemPrompt: 'Custom system prompt for research',
    });

    const researchCall = createMessage.mock.calls[1];
    expect(researchCall[0].system).toBe('Custom system prompt for research');
  });

  it('should return structured result with summary, sources, and success', async () => {
    createMessage
      .mockResolvedValueOnce(mockTextResponse('reformulated'))
      .mockResolvedValueOnce(mockTextResponse(JSON.stringify({
        domain: 'web',
        found: true,
        summary: 'Found 2 results',
        details: ['source1', 'source2'],
      })));

    const result = await runResearchAgent({ query: 'test', domain: 'web' });

    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('sources');
    expect(result).toHaveProperty('success');
    expect(result.sources).toEqual(['source1', 'source2']);
    expect(result.success).toBe(true);
  });

  it('should handle non-JSON text response gracefully', async () => {
    createMessage
      .mockResolvedValueOnce(mockTextResponse('reformulated'))
      .mockResolvedValueOnce(mockTextResponse('Plain text response without JSON'));

    const result = await runResearchAgent({ query: 'test', domain: 'jira' });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('Plain text response without JSON');
    expect(result.sources).toEqual([]);
  });
});

describe('runStreamingResearchAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should stream tokens via onToken callback', async () => {
    // reformulateQuery
    createMessage.mockResolvedValue(mockTextResponse('reformulated'));

    // streamMessage returns events
    streamMessage.mockReturnValue(mockStreamEvents([
      { type: 'text', text: 'Found ' },
      { type: 'text', text: 'results' },
      {
        type: 'message_complete',
        response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found results' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]));

    const onToken = vi.fn();
    const result = await runStreamingResearchAgent(
      { query: 'test', domain: 'jira' },
      onToken
    );

    expect(onToken).toHaveBeenCalledWith('Found ');
    expect(onToken).toHaveBeenCalledWith('results');
    expect(result.success).toBe(true);
  });

  it('should handle stream errors gracefully', async () => {
    createMessage.mockResolvedValue(mockTextResponse('reformulated'));

    streamMessage.mockReturnValue(mockStreamEvents([
      { type: 'error', error: { message: 'Stream interrupted', errorType: 'network_error', statusCode: 500 } },
    ]));

    const onToken = vi.fn();
    const result = await runStreamingResearchAgent(
      { query: 'test', domain: 'jira' },
      onToken
    );

    expect(result.success).toBe(false);
    expect(result.summary).toContain('Stream error');
  });

  it('should handle multi-turn tool calling in streaming mode', async () => {
    createMessage.mockResolvedValue(mockTextResponse('reformulated'));

    // First stream: tool use
    const toolUseStream = mockStreamEvents([
      {
        type: 'message_complete',
        response: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'mock_search', input: { q: 'test' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 15 },
        },
      },
    ]);

    // Second stream: final text
    const textStream = mockStreamEvents([
      { type: 'text', text: 'Final answer' },
      {
        type: 'message_complete',
        response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      },
    ]);

    streamMessage
      .mockReturnValueOnce(toolUseStream)
      .mockReturnValueOnce(textStream);

    executeTool.mockResolvedValue({ results: ['item1'] });

    const onToken = vi.fn();
    const result = await runStreamingResearchAgent(
      { query: 'test', domain: 'jira' },
      onToken
    );

    expect(executeTool).toHaveBeenCalledWith('mock_search', { q: 'test' });
    expect(streamMessage).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Final answer');
  });
});

describe('No Anthropic SDK imports', () => {
  it('should not import from @anthropic-ai/sdk', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const fileContent = fs.readFileSync(
      path.resolve(import.meta.dirname, '../researchAgents.js'),
      'utf-8'
    );

    expect(fileContent).not.toContain('@anthropic-ai/sdk');
    expect(fileContent).not.toContain('anthropic');
    // Should import from ./llm.js
    expect(fileContent).toContain("from './llm.js'");
  });
});
