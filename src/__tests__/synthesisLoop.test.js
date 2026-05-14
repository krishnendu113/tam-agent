import { describe, it, expect, beforeEach, vi } from 'vitest';
import { synthesisLoop, buildSynthesisSystemPrompt } from '../agentLoop.js';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

// Mock the skillLoader module (imported by agentLoop.js)
vi.mock('../skillLoader.js', () => ({
  loadSkillsById: vi.fn(() => []),
}));

import { streamMessage } from '../llm.js';
import { executeTool } from '../tools/index.js';

/**
 * Helper to create an async iterable from an array of events.
 */
function createMockStream(events) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

/**
 * Helper to create a standard callbacks object with vi.fn() spies.
 */
function createMockCallbacks() {
  return {
    onToken: vi.fn(),
    onStatus: vi.fn(),
    onPhase: vi.fn(),
    onToolStatus: vi.fn(),
    onSkillActive: vi.fn(),
    onPlanUpdate: vi.fn(),
    onDocumentReady: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
  };
}

describe('buildSynthesisSystemPrompt', () => {
  it('returns base system prompt when no research context', () => {
    const state = { systemPrompt: 'You are a TAM agent.' };
    const result = buildSynthesisSystemPrompt(state);
    expect(result).toBe('You are a TAM agent.');
  });

  it('returns default prompt when systemPrompt is not set', () => {
    const state = {};
    const result = buildSynthesisSystemPrompt(state);
    expect(result).toBe('You are a helpful Technical Account Manager agent.');
  });

  it('returns base prompt when researchContext has empty results', () => {
    const state = {
      systemPrompt: 'Base prompt.',
      researchContext: { results: [] },
    };
    const result = buildSynthesisSystemPrompt(state);
    expect(result).toBe('Base prompt.');
  });

  it('appends research context to system prompt', () => {
    const state = {
      systemPrompt: 'Base prompt.',
      researchContext: {
        results: [
          { domain: 'jira', summary: 'Found 3 tickets', details: [] },
          { domain: 'confluence', summary: 'Found 1 page', details: [{ title: 'Auth Guide' }] },
        ],
      },
    };
    const result = buildSynthesisSystemPrompt(state);
    expect(result).toContain('Base prompt.');
    expect(result).toContain('## Research Context');
    expect(result).toContain('[jira] Found 3 tickets');
    expect(result).toContain('[confluence] Found 1 page');
    expect(result).toContain('Auth Guide');
  });
});

describe('synthesisLoop', () => {
  let callbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
  });

  describe('Text streaming', () => {
    it('invokes onToken for each text event from the stream', async () => {
      streamMessage.mockReturnValue(createMockStream([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Hi' }],
        systemPrompt: 'You are helpful.',
        availableTools: [],
      };

      await synthesisLoop(state, callbacks);

      expect(callbacks.onToken).toHaveBeenCalledTimes(2);
      expect(callbacks.onToken).toHaveBeenNthCalledWith(1, 'Hello');
      expect(callbacks.onToken).toHaveBeenNthCalledWith(2, ' world');
    });
  });

  describe('Tool use handling', () => {
    it('executes tool, appends result, and invokes onToolStatus', async () => {
      executeTool.mockResolvedValue({ data: 'tool result' });

      streamMessage.mockReturnValueOnce(createMockStream([
        { type: 'tool_use_start', id: 'tool_1', name: 'jira_search' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'jira_search', input: { query: 'auth' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 15 },
        }},
      ]));

      // Second call after tool result — returns end_turn
      streamMessage.mockReturnValueOnce(createMockStream([
        { type: 'text', text: 'Based on the results...' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Based on the results...' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 20 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Search Jira' }],
        systemPrompt: 'You are helpful.',
        availableTools: [{ name: 'jira_search', description: 'Search Jira', input_schema: {} }],
      };

      const result = await synthesisLoop(state, callbacks);

      // Tool was executed
      expect(executeTool).toHaveBeenCalledWith('jira_search', { query: 'auth' });

      // onToolStatus called for start and completion
      expect(callbacks.onToolStatus).toHaveBeenCalledWith('jira_search', 'started');
      expect(callbacks.onToolStatus).toHaveBeenCalledWith('jira_search', 'completed');

      // Tool result appended to messages
      const toolResultMsg = result.messages.find(
        m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg.content[0].tool_use_id).toBe('tool_1');
      expect(JSON.parse(toolResultMsg.content[0].content)).toEqual({ data: 'tool result' });
    });
  });

  describe('Multi-turn tool use', () => {
    it('re-invokes LLM when stop_reason is "tool_use"', async () => {
      executeTool.mockResolvedValue({ items: [1, 2, 3] });

      // First call — tool use
      streamMessage.mockReturnValueOnce(createMockStream([
        { type: 'tool_use_start', id: 'tool_1', name: 'search' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'search', input: { q: 'test' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }},
      ]));

      // Second call — end turn
      streamMessage.mockReturnValueOnce(createMockStream([
        { type: 'text', text: 'Done' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 10 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Search' }],
        systemPrompt: 'Prompt',
        availableTools: [],
      };

      await synthesisLoop(state, callbacks);

      // streamMessage called twice (re-invoked after tool use)
      expect(streamMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('End turn finalization', () => {
    it('calls onComplete with final text when stop_reason is "end_turn"', async () => {
      streamMessage.mockReturnValue(createMockStream([
        { type: 'text', text: 'Final answer' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Final answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Question' }],
        systemPrompt: 'Prompt',
        availableTools: [],
      };

      const result = await synthesisLoop(state, callbacks);

      expect(callbacks.onComplete).toHaveBeenCalledWith('Final answer');
      expect(result.finalResponse).toBeDefined();
      expect(result.finalResponse.stop_reason).toBe('end_turn');
    });

    it('concatenates multiple text blocks in final response', async () => {
      streamMessage.mockReturnValue(createMockStream([
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: ' Part 2' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: ' Part 2' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 8 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Q' }],
        systemPrompt: 'P',
        availableTools: [],
      };

      await synthesisLoop(state, callbacks);

      expect(callbacks.onComplete).toHaveBeenCalledWith('Part 1 Part 2');
    });

    it('returns updated state with messages and finalResponse', async () => {
      const fullResponse = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      streamMessage.mockReturnValue(createMockStream([
        { type: 'text', text: 'Answer' },
        { type: 'message_complete', response: fullResponse },
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Q' }],
        systemPrompt: 'P',
        availableTools: [],
        conversationId: 'conv-1',
      };

      const result = await synthesisLoop(state, callbacks);

      expect(result.conversationId).toBe('conv-1');
      expect(result.finalResponse).toEqual(fullResponse);
      expect(result.messages).toHaveLength(2); // original + assistant
      expect(result.messages[1]).toEqual({ role: 'assistant', content: fullResponse.content });
    });
  });

  describe('Max iterations limit', () => {
    it('stops after MAX_ITERATIONS and calls onStatus and onComplete', async () => {
      executeTool.mockResolvedValue({ result: 'ok' });

      // Always return tool_use to force infinite loop
      streamMessage.mockImplementation(() => createMockStream([
        { type: 'tool_use_start', id: 'tool_1', name: 'search' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'search', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Loop forever' }],
        systemPrompt: 'P',
        availableTools: [],
      };

      const result = await synthesisLoop(state, callbacks);

      // Should have been called exactly 10 times (MAX_ITERATIONS)
      expect(streamMessage).toHaveBeenCalledTimes(10);
      expect(callbacks.onStatus).toHaveBeenCalledWith('Warning: maximum synthesis iterations reached');
      expect(callbacks.onComplete).toHaveBeenCalled();
      expect(result.finalResponse).toBeNull();
    });
  });

  describe('Error handling', () => {
    it('throws when stream yields an error event', async () => {
      streamMessage.mockReturnValue(createMockStream([
        { type: 'error', error: { errorType: 'api_error', message: 'Service unavailable', statusCode: 503 } },
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Q' }],
        systemPrompt: 'P',
        availableTools: [],
      };

      await expect(synthesisLoop(state, callbacks)).rejects.toThrow('Service unavailable');
      expect(callbacks.onComplete).not.toHaveBeenCalled();
    });
  });

  describe('Tool execution failure', () => {
    it('appends error result and continues loop when tool execution fails', async () => {
      executeTool.mockRejectedValue(new Error('Tool timeout'));

      // First call — tool use that will fail
      streamMessage.mockReturnValueOnce(createMockStream([
        { type: 'tool_use_start', id: 'tool_1', name: 'failing_tool' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'failing_tool', input: { x: 1 } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }},
      ]));

      // Second call — LLM handles the error and responds
      streamMessage.mockReturnValueOnce(createMockStream([
        { type: 'text', text: 'Tool failed, here is what I know...' },
        { type: 'message_complete', response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Tool failed, here is what I know...' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 15 },
        }},
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Do something' }],
        systemPrompt: 'P',
        availableTools: [],
      };

      const result = await synthesisLoop(state, callbacks);

      // onToolStatus called with 'failed'
      expect(callbacks.onToolStatus).toHaveBeenCalledWith('failing_tool', 'failed');

      // Error result appended to messages
      const toolResultMsg = result.messages.find(
        m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      expect(toolResultMsg).toBeDefined();
      expect(JSON.parse(toolResultMsg.content[0].content)).toEqual({ error: 'Tool timeout' });

      // Loop continued and completed
      expect(callbacks.onComplete).toHaveBeenCalledWith('Tool failed, here is what I know...');
      expect(streamMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('streamMessage invocation', () => {
    it('passes correct parameters to streamMessage', async () => {
      let capturedArgs = null;
      streamMessage.mockImplementation((args) => {
        // Capture a snapshot of the messages at call time
        capturedArgs = { ...args, messages: [...args.messages] };
        return createMockStream([
          { type: 'text', text: 'Response' },
          { type: 'message_complete', response: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }},
        ]);
      });

      const tools = [{ name: 'search', description: 'Search', input_schema: {} }];
      const state = {
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'System prompt here.',
        availableTools: tools,
        researchContext: {
          results: [{ domain: 'jira', summary: 'Found items', details: [] }],
        },
      };

      await synthesisLoop(state, callbacks);

      expect(capturedArgs.model).toBe('sonnet');
      expect(capturedArgs.system).toContain('System prompt here.');
      expect(capturedArgs.system).toContain('[jira] Found items');
      expect(capturedArgs.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(capturedArgs.tools).toEqual(tools);
      expect(capturedArgs.maxTokens).toBe(4096);
    });
  });

  describe('No fullResponse handling', () => {
    it('breaks out of loop when stream yields no message_complete', async () => {
      streamMessage.mockReturnValue(createMockStream([
        { type: 'text', text: 'Partial...' },
        // No message_complete event
      ]));

      const state = {
        messages: [{ role: 'user', content: 'Q' }],
        systemPrompt: 'P',
        availableTools: [],
      };

      const result = await synthesisLoop(state, callbacks);

      // Breaks out of loop, hits max-iterations-reached path
      expect(callbacks.onStatus).toHaveBeenCalledWith('Warning: maximum synthesis iterations reached');
      expect(callbacks.onComplete).toHaveBeenCalled();
      expect(result.finalResponse).toBeNull();
      // Only called once since fullResponse is null and loop breaks
      expect(streamMessage).toHaveBeenCalledTimes(1);
    });
  });
});
