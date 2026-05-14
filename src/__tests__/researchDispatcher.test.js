import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parallelResearchNode,
  sequentialResearchFallback,
  runJiraResearch,
  runConfluenceResearch,
  runDocsResearch,
  runWebResearch,
  runAgentLoop,
} from '../agentLoop.js';

// Mock the LLM module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => [
    { name: 'mock_tool', description: 'A mock tool', input_schema: { type: 'object', properties: {} } },
  ]),
}));

import { createMessage } from '../llm.js';
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
 * Helper to create a base agent state.
 */
function createBaseState(overrides = {}) {
  return {
    conversationId: 'test-conv-1',
    messages: [{ role: 'user', content: 'How do I fix the login issue?' }],
    systemPrompt: 'You are a TAM agent.',
    problemText: 'How do I fix the login issue?',
    toolTags: ['jira', 'confluence', 'docs', 'web'],
    ...overrides,
  };
}

/**
 * Helper to create mock callbacks.
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
  };
}

describe('parallelResearchNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should dispatch all sub-agents in parallel and collect results', async () => {
    const jiraResult = { domain: 'jira', found: true, summary: 'Found 3 tickets', details: [] };
    const confluenceResult = { domain: 'confluence', found: true, summary: 'Found 2 pages', details: [] };
    const docsResult = { domain: 'docs', found: true, summary: 'Found docs', details: [] };
    const webResult = { domain: 'web', found: false, summary: 'No results', details: [] };

    // Each sub-agent makes one createMessage call that returns a text response with JSON
    createMessage.mockImplementation(async ({ system }) => {
      if (system.includes('jira')) {
        return mockTextResponse(JSON.stringify(jiraResult));
      }
      if (system.includes('confluence')) {
        return mockTextResponse(JSON.stringify(confluenceResult));
      }
      if (system.includes('docs')) {
        return mockTextResponse(JSON.stringify(docsResult));
      }
      if (system.includes('web')) {
        return mockTextResponse(JSON.stringify(webResult));
      }
      return mockTextResponse('{}');
    });

    const state = createBaseState();
    const callbacks = createMockCallbacks();

    const result = await parallelResearchNode(state, callbacks);

    expect(result.researchContext).toBeDefined();
    expect(result.researchContext.results).toHaveLength(4);
    expect(result.researchContext.successCount).toBe(4);
    expect(result.researchContext.failureCount).toBe(0);
    expect(result.fallbackToSequential).toBe(false);
    expect(callbacks.onStatus).toHaveBeenCalledWith(
      expect.stringContaining('4/4 sub-agents succeeded')
    );
  });

  it('should handle partial failure — some sub-agents fail, results from successful ones collected', async () => {
    let callCount = 0;
    createMessage.mockImplementation(async ({ system }) => {
      if (system.includes('jira')) {
        return mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Found tickets', details: [] }));
      }
      if (system.includes('confluence')) {
        throw new Error('Confluence API timeout');
      }
      if (system.includes('docs')) {
        return mockTextResponse(JSON.stringify({ domain: 'docs', found: true, summary: 'Found docs', details: [] }));
      }
      if (system.includes('web')) {
        throw new Error('Web search rate limited');
      }
      return mockTextResponse('{}');
    });

    const state = createBaseState();
    const callbacks = createMockCallbacks();

    const result = await parallelResearchNode(state, callbacks);

    expect(result.researchContext.results).toHaveLength(2);
    expect(result.researchContext.failures).toHaveLength(2);
    expect(result.researchContext.successCount).toBe(2);
    expect(result.researchContext.failureCount).toBe(2);
    expect(result.fallbackToSequential).toBe(false);
    expect(callbacks.onStatus).toHaveBeenCalledWith(
      expect.stringContaining('2/4 sub-agents succeeded')
    );
  });

  it('should set fallbackToSequential = true when all sub-agents fail', async () => {
    createMessage.mockRejectedValue(new Error('LLM service unavailable'));

    const state = createBaseState();
    const callbacks = createMockCallbacks();

    const result = await parallelResearchNode(state, callbacks);

    expect(result.researchContext.results).toHaveLength(0);
    expect(result.researchContext.failures).toHaveLength(4);
    expect(result.fallbackToSequential).toBe(true);
    expect(callbacks.onStatus).toHaveBeenCalledWith(
      expect.stringContaining('falling back to sequential mode')
    );
  });

  it('should select sub-agents based on toolTags', async () => {
    createMessage.mockImplementation(async ({ system }) => {
      if (system.includes('jira')) {
        return mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Jira results', details: [] }));
      }
      if (system.includes('docs')) {
        return mockTextResponse(JSON.stringify({ domain: 'docs', found: true, summary: 'Docs results', details: [] }));
      }
      return mockTextResponse('{}');
    });

    const state = createBaseState({ toolTags: ['jira', 'docs'] });
    const callbacks = createMockCallbacks();

    const result = await parallelResearchNode(state, callbacks);

    expect(result.researchContext.domainsSearched).toEqual(['jira', 'docs']);
    expect(result.researchContext.results).toHaveLength(2);
    expect(result.researchContext.successCount).toBe(2);
  });

  it('should dispatch all domains when toolTags is empty', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'any', found: false, summary: 'No results', details: [] }))
    );

    const state = createBaseState({ toolTags: [] });
    const callbacks = createMockCallbacks();

    const result = await parallelResearchNode(state, callbacks);

    expect(result.researchContext.domainsSearched).toEqual(['jira', 'confluence', 'docs', 'web']);
  });

  it('should invoke callbacks.onStatus with research summary on completion', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Results', details: [] }))
    );

    const state = createBaseState({ toolTags: ['jira'] });
    const callbacks = createMockCallbacks();

    await parallelResearchNode(state, callbacks);

    expect(callbacks.onStatus).toHaveBeenCalledTimes(1);
    expect(callbacks.onStatus).toHaveBeenCalledWith(expect.any(String));
  });

  it('should handle missing callbacks gracefully', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Results', details: [] }))
    );

    const state = createBaseState({ toolTags: ['jira'] });

    // Should not throw with null/undefined callbacks
    const result = await parallelResearchNode(state, null);
    expect(result.researchContext).toBeDefined();
  });

  it('should handle toolTags with non-research tags (ignored)', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Results', details: [] }))
    );

    const state = createBaseState({ toolTags: ['jira', 'unknown_tag', 'another_tag'] });
    const callbacks = createMockCallbacks();

    const result = await parallelResearchNode(state, callbacks);

    // Only 'jira' is a valid research domain
    expect(result.researchContext.domainsSearched).toEqual(['jira']);
    expect(result.researchContext.results).toHaveLength(1);
  });
});

describe('Sub-agent multi-turn tool-calling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute tool when LLM responds with tool_use and make follow-up call', async () => {
    // First call: LLM wants to use a tool
    // Second call: LLM returns final text response
    createMessage
      .mockResolvedValueOnce(mockToolUseResponse('jira_search', { query: 'login issue' }))
      .mockResolvedValueOnce(
        mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Found 2 tickets about login', details: ['TICKET-1', 'TICKET-2'] }))
      );

    executeTool.mockResolvedValue({ results: [{ key: 'TICKET-1' }, { key: 'TICKET-2' }], total: 2 });

    const state = createBaseState({ toolTags: ['jira'] });
    const result = await runJiraResearch(state);

    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledWith('jira_search', { query: 'login issue' });
    expect(result.domain).toBe('jira');
    expect(result.found).toBe(true);
  });

  it('should handle tool execution errors gracefully', async () => {
    createMessage
      .mockResolvedValueOnce(mockToolUseResponse('jira_search', { query: 'test' }))
      .mockResolvedValueOnce(
        mockTextResponse(JSON.stringify({ domain: 'jira', found: false, summary: 'Tool failed', details: [] }))
      );

    executeTool.mockRejectedValue(new Error('Jira API connection refused'));

    const state = createBaseState({ toolTags: ['jira'] });
    const result = await runJiraResearch(state);

    // Should still complete — tool error is passed back to LLM as context
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(result.domain).toBe('jira');
  });

  it('should respect max turns limit', async () => {
    // LLM keeps requesting tools indefinitely
    createMessage.mockResolvedValue(mockToolUseResponse('jira_search', { query: 'test' }));
    executeTool.mockResolvedValue({ results: [] });

    const state = createBaseState({ toolTags: ['jira'] });
    const result = await runJiraResearch(state);

    // Should stop after MAX_SUB_AGENT_TURNS (3) tool calls
    expect(createMessage).toHaveBeenCalledTimes(3);
    expect(result.domain).toBe('jira');
    expect(result.found).toBe(false);
    expect(result.summary).toContain('maximum turns');
  });

  it('should propagate LLM errors (caught by Promise.allSettled)', async () => {
    createMessage.mockRejectedValue(new Error('LLM service down'));

    const state = createBaseState();
    await expect(runJiraResearch(state)).rejects.toThrow('LLM service down');
  });
});

describe('Individual sub-agent functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runConfluenceResearch should use confluence domain', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'confluence', found: true, summary: 'Found pages', details: [] }))
    );

    const state = createBaseState();
    const result = await runConfluenceResearch(state);

    expect(result.domain).toBe('confluence');
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
        system: expect.stringContaining('confluence'),
      })
    );
  });

  it('runDocsResearch should use docs domain', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'docs', found: true, summary: 'Found documentation', details: [] }))
    );

    const state = createBaseState();
    const result = await runDocsResearch(state);

    expect(result.domain).toBe('docs');
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
        system: expect.stringContaining('docs'),
      })
    );
  });

  it('runWebResearch should use web domain', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'web', found: false, summary: 'No web results', details: [] }))
    );

    const state = createBaseState();
    const result = await runWebResearch(state);

    expect(result.domain).toBe('web');
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku',
        system: expect.stringContaining('web'),
      })
    );
  });

  it('should handle empty problemText gracefully', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'jira', found: false, summary: 'No query provided', details: [] }))
    );

    const state = createBaseState({ problemText: '' });
    const result = await runJiraResearch(state);

    expect(result).toBeDefined();
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '' }],
      })
    );
  });

  it('should handle non-JSON text response from LLM', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse('I could not find any relevant information about this topic.')
    );

    const state = createBaseState();
    const result = await runJiraResearch(state);

    // Should fall back to text summary format
    expect(result.domain).toBe('jira');
    expect(result.found).toBe(true);
    expect(result.summary).toContain('could not find');
  });
});


describe('sequentialResearchFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should succeed on first domain (jira)', async () => {
    const jiraResult = { domain: 'jira', found: true, summary: 'Found tickets', details: ['TICKET-1'] };

    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify(jiraResult))
    );

    const state = createBaseState({
      fallbackToSequential: true,
      researchContext: { results: [], failures: [{ domain: 'jira', error: 'timeout' }], domainsSearched: ['jira'], successCount: 0, failureCount: 1 },
    });
    const callbacks = createMockCallbacks();

    const result = await sequentialResearchFallback(state, callbacks);

    expect(result.researchContext.results).toHaveLength(1);
    expect(result.researchContext.results[0].domain).toBe('jira');
    expect(result.researchContext.successCount).toBe(1);
    expect(result.fallbackToSequential).toBe(true);
  });

  it('should succeed on later domain after earlier failures', async () => {
    let callCount = 0;
    createMessage.mockImplementation(async ({ system }) => {
      if (system.includes('jira')) {
        throw new Error('Jira unavailable');
      }
      if (system.includes('confluence')) {
        throw new Error('Confluence unavailable');
      }
      if (system.includes('docs')) {
        return mockTextResponse(JSON.stringify({ domain: 'docs', found: true, summary: 'Found docs', details: [] }));
      }
      // web should not be reached
      return mockTextResponse(JSON.stringify({ domain: 'web', found: true, summary: 'Web results', details: [] }));
    });

    const state = createBaseState({
      fallbackToSequential: true,
      researchContext: { results: [], failures: [], domainsSearched: [], successCount: 0, failureCount: 0 },
    });
    const callbacks = createMockCallbacks();

    const result = await sequentialResearchFallback(state, callbacks);

    expect(result.researchContext.results).toHaveLength(1);
    expect(result.researchContext.results[0].domain).toBe('docs');
    expect(result.researchContext.successCount).toBe(1);
    // Verify it stopped after docs succeeded (web not called)
    expect(callbacks.onStatus).toHaveBeenCalledWith('Sequential research: docs succeeded');
  });

  it('should return empty results when all domains fail again', async () => {
    createMessage.mockRejectedValue(new Error('All services down'));

    const state = createBaseState({
      fallbackToSequential: true,
      researchContext: { results: [], failures: [], domainsSearched: [], successCount: 0, failureCount: 0 },
    });
    const callbacks = createMockCallbacks();

    const result = await sequentialResearchFallback(state, callbacks);

    expect(result.researchContext.results).toHaveLength(0);
    expect(result.researchContext.successCount).toBe(0);
    expect(result.fallbackToSequential).toBe(true);
    expect(callbacks.onStatus).toHaveBeenCalledWith(
      'Sequential research: all domains failed, proceeding with empty context'
    );
  });

  it('should invoke callbacks.onStatus with progress updates', async () => {
    createMessage.mockImplementation(async ({ system }) => {
      if (system.includes('jira')) {
        throw new Error('Jira down');
      }
      if (system.includes('confluence')) {
        return mockTextResponse(JSON.stringify({ domain: 'confluence', found: true, summary: 'Found pages', details: [] }));
      }
      return mockTextResponse('{}');
    });

    const state = createBaseState({
      fallbackToSequential: true,
      researchContext: { results: [], failures: [], domainsSearched: [], successCount: 0, failureCount: 0 },
    });
    const callbacks = createMockCallbacks();

    await sequentialResearchFallback(state, callbacks);

    expect(callbacks.onStatus).toHaveBeenCalledWith('Falling back to sequential research...');
    expect(callbacks.onStatus).toHaveBeenCalledWith('Sequential research: trying jira...');
    expect(callbacks.onStatus).toHaveBeenCalledWith('Sequential research: trying confluence...');
    expect(callbacks.onStatus).toHaveBeenCalledWith('Sequential research: confluence succeeded');
  });

  it('should handle null callbacks gracefully', async () => {
    createMessage.mockResolvedValue(
      mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Results', details: [] }))
    );

    const state = createBaseState({
      fallbackToSequential: true,
      researchContext: { results: [], failures: [], domainsSearched: [], successCount: 0, failureCount: 0 },
    });

    // Should not throw with null callbacks
    const result = await sequentialResearchFallback(state, null);
    expect(result.researchContext.results).toHaveLength(1);
  });
});

describe('runAgentLoop — sequential fallback integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should invoke sequentialResearchFallback when fallbackToSequential is true', async () => {
    // Preflight: on-topic, research mode
    const preflightResponse = mockTextResponse(JSON.stringify({
      onTopic: true,
      intent: 'troubleshooting',
      toolTags: ['jira'],
      skillIds: [],
    }));

    let callIndex = 0;
    createMessage.mockImplementation(async ({ system }) => {
      callIndex++;
      if (callIndex === 1) {
        // Preflight call
        return preflightResponse;
      }
      // All subsequent calls (parallel research) fail
      throw new Error('LLM service unavailable');
    });

    const state = createBaseState({
      onTopic: undefined,
      toolTags: undefined,
    });
    const callbacks = createMockCallbacks();

    const result = await runAgentLoop(state, callbacks);

    // Verify sequential fallback was triggered
    expect(callbacks.onStatus).toHaveBeenCalledWith('Falling back to sequential research...');
    expect(result.fallbackToSequential).toBe(true);
  });

  it('should NOT invoke sequentialResearchFallback when parallel research succeeds', async () => {
    // Preflight: on-topic, research mode
    const preflightResponse = mockTextResponse(JSON.stringify({
      onTopic: true,
      intent: 'troubleshooting',
      toolTags: ['jira'],
      skillIds: [],
    }));

    let callIndex = 0;
    createMessage.mockImplementation(async ({ system }) => {
      callIndex++;
      if (callIndex === 1) {
        // Preflight call
        return preflightResponse;
      }
      // Research call succeeds
      return mockTextResponse(JSON.stringify({ domain: 'jira', found: true, summary: 'Found results', details: [] }));
    });

    const state = createBaseState({
      onTopic: undefined,
      toolTags: undefined,
    });
    const callbacks = createMockCallbacks();

    const result = await runAgentLoop(state, callbacks);

    // Sequential fallback should NOT have been triggered
    expect(result.fallbackToSequential).toBe(false);
    // Should not have the sequential fallback status message
    const statusCalls = callbacks.onStatus.mock.calls.map(c => c[0]);
    expect(statusCalls).not.toContain('Falling back to sequential research...');
  });
});
