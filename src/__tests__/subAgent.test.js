/**
 * Unit tests for src/tools/subAgent.js — delegate_to_subagent tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

// Mock the tools/index.js module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => [
    { name: 'mock_tool', description: 'A mock tool', input_schema: { type: 'object', properties: {} } },
  ]),
}));

import { createMessage } from '../llm.js';
import { executeTool, getToolDefinitions } from '../tools/index.js';
import { delegateToSubagentTool, clampTurns } from '../tools/subAgent.js';

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

describe('delegateToSubagentTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(delegateToSubagentTool.name).toBe('delegate_to_subagent');
    });

    it('has correct tags', () => {
      expect(delegateToSubagentTool.tags).toEqual(['agent']);
    });

    it('requires taskDescription', () => {
      expect(delegateToSubagentTool.inputSchema.required).toContain('taskDescription');
    });

    it('has optional context and maxTurns properties', () => {
      const props = delegateToSubagentTool.inputSchema.properties;
      expect(props.context).toBeDefined();
      expect(props.maxTurns).toBeDefined();
      expect(delegateToSubagentTool.inputSchema.required).not.toContain('context');
      expect(delegateToSubagentTool.inputSchema.required).not.toContain('maxTurns');
    });

    it('has description', () => {
      expect(delegateToSubagentTool.description).toBeTruthy();
      expect(delegateToSubagentTool.description).toContain('sub-agent');
    });
  });

  describe('handler - basic execution', () => {
    it('returns text output when LLM responds with end_turn', async () => {
      createMessage.mockResolvedValue(mockTextResponse('Task completed successfully'));

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Find information about login issues',
      });

      expect(result.output).toBe('Task completed successfully');
      expect(result.turnsUsed).toBe(1);
      expect(result.maxTurnsReached).toBe(false);
    });

    it('uses haiku model via createMessage', async () => {
      createMessage.mockResolvedValue(mockTextResponse('done'));

      await delegateToSubagentTool.handler({
        taskDescription: 'Test task',
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'haiku',
        })
      );
    });

    it('passes tools to createMessage', async () => {
      createMessage.mockResolvedValue(mockTextResponse('done'));

      await delegateToSubagentTool.handler({
        taskDescription: 'Test task',
      });

      expect(getToolDefinitions).toHaveBeenCalled();
      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.any(Array),
        })
      );
    });

    it('includes context in system prompt when provided', async () => {
      createMessage.mockResolvedValue(mockTextResponse('done'));

      await delegateToSubagentTool.handler({
        taskDescription: 'Research something',
        context: 'The user is working on project XYZ',
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('The user is working on project XYZ'),
        })
      );
    });

    it('includes taskDescription in system prompt', async () => {
      createMessage.mockResolvedValue(mockTextResponse('done'));

      await delegateToSubagentTool.handler({
        taskDescription: 'Find Jira tickets about authentication',
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('Find Jira tickets about authentication'),
        })
      );
    });
  });

  describe('handler - multi-turn tool calling', () => {
    it('executes tools and continues the loop', async () => {
      createMessage
        .mockResolvedValueOnce(mockToolUseResponse('mock_tool', { query: 'test' }))
        .mockResolvedValueOnce(mockTextResponse('Found the answer'));

      executeTool.mockResolvedValue({ results: ['item1'] });

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Search for something',
      });

      expect(executeTool).toHaveBeenCalledWith('mock_tool', { query: 'test' });
      expect(createMessage).toHaveBeenCalledTimes(2);
      expect(result.output).toBe('Found the answer');
      expect(result.turnsUsed).toBe(2);
      expect(result.maxTurnsReached).toBe(false);
    });

    it('handles tool execution errors gracefully', async () => {
      createMessage
        .mockResolvedValueOnce(mockToolUseResponse('mock_tool', { query: 'test' }))
        .mockResolvedValueOnce(mockTextResponse('Could not find the information'));

      executeTool.mockRejectedValue(new Error('Connection refused'));

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Search for something',
      });

      // Tool error is passed back to LLM as a tool result
      expect(createMessage).toHaveBeenCalledTimes(2);
      expect(result.output).toBe('Could not find the information');
    });

    it('passes tool result back to LLM in correct format', async () => {
      createMessage
        .mockResolvedValueOnce(mockToolUseResponse('mock_tool', { q: 'hello' }, 'tool_abc'))
        .mockResolvedValueOnce(mockTextResponse('done'));

      executeTool.mockResolvedValue({ data: 'found it' });

      await delegateToSubagentTool.handler({
        taskDescription: 'Test',
      });

      // Second call should include the tool result message
      const secondCall = createMessage.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        m => m.role === 'user' && Array.isArray(m.content)
      );
      expect(toolResultMsg).toBeTruthy();
      expect(toolResultMsg.content[0].type).toBe('tool_result');
      expect(toolResultMsg.content[0].tool_use_id).toBe('tool_abc');
      expect(JSON.parse(toolResultMsg.content[0].content)).toEqual({ data: 'found it' });
    });
  });

  describe('handler - max turns enforcement', () => {
    it('terminates and returns partial result when max turns exceeded', async () => {
      // All calls return tool_use (infinite loop)
      createMessage.mockResolvedValue(mockToolUseResponse('mock_tool', { q: 'test' }));
      executeTool.mockResolvedValue({ results: [] });

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Search endlessly',
        maxTurns: 3,
      });

      expect(createMessage).toHaveBeenCalledTimes(3);
      expect(result.maxTurnsReached).toBe(true);
      expect(result.turnsUsed).toBe(3);
      expect(result.warning).toContain('maximum');
      expect(result.warning).toContain('3');
    });

    it('uses default maxTurns of 5 when not specified', async () => {
      createMessage.mockResolvedValue(mockToolUseResponse('mock_tool', { q: 'test' }));
      executeTool.mockResolvedValue({ results: [] });

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Search endlessly',
      });

      expect(createMessage).toHaveBeenCalledTimes(5);
      expect(result.turnsUsed).toBe(5);
      expect(result.maxTurnsReached).toBe(true);
    });

    it('returns last text output when max turns exceeded with partial text', async () => {
      // First response has both text and tool_use
      createMessage
        .mockResolvedValueOnce({
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching for information...' },
            { type: 'tool_use', id: 'tool_1', name: 'mock_tool', input: { q: 'test' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        })
        .mockResolvedValue(mockToolUseResponse('mock_tool', { q: 'test' }));

      executeTool.mockResolvedValue({ results: [] });

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Search',
        maxTurns: 2,
      });

      expect(result.maxTurnsReached).toBe(true);
      expect(result.output).toBe('Searching for information...');
    });
  });

  describe('handler - error handling', () => {
    it('returns error result when createMessage fails', async () => {
      createMessage.mockRejectedValue(new Error('Bedrock API unavailable'));

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Do something',
      });

      expect(result.error).toBe('Bedrock API unavailable');
      expect(result.output).toContain('error');
      expect(result.maxTurnsReached).toBe(false);
    });

    it('returns error result when createMessage fails mid-loop', async () => {
      createMessage
        .mockResolvedValueOnce(mockToolUseResponse('mock_tool', { q: 'test' }))
        .mockRejectedValueOnce(new Error('Rate limit exceeded'));

      executeTool.mockResolvedValue({ results: [] });

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Do something',
      });

      expect(result.error).toBe('Rate limit exceeded');
      expect(result.turnsUsed).toBe(1);
    });

    it('handles empty tool definitions gracefully', async () => {
      getToolDefinitions.mockReturnValue([]);
      createMessage.mockResolvedValue(mockTextResponse('done without tools'));

      const result = await delegateToSubagentTool.handler({
        taskDescription: 'Answer a question',
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: undefined,
        })
      );
      expect(result.output).toBe('done without tools');
    });
  });
});

describe('clampTurns', () => {
  it('returns default 5 for undefined', () => {
    expect(clampTurns(undefined)).toBe(5);
  });

  it('returns default 5 for null', () => {
    expect(clampTurns(null)).toBe(5);
  });

  it('returns default 5 for 0', () => {
    expect(clampTurns(0)).toBe(5);
  });

  it('clamps values below 1 to 1', () => {
    expect(clampTurns(-5)).toBe(1);
    expect(clampTurns(-100)).toBe(1);
  });

  it('clamps values above 10 to 10', () => {
    expect(clampTurns(11)).toBe(10);
    expect(clampTurns(100)).toBe(10);
    expect(clampTurns(999)).toBe(10);
  });

  it('passes through valid values in range [1, 10]', () => {
    expect(clampTurns(1)).toBe(1);
    expect(clampTurns(5)).toBe(5);
    expect(clampTurns(10)).toBe(10);
    expect(clampTurns(7)).toBe(7);
  });
});
