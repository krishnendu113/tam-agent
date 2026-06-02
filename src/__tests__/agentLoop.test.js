import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { preflightNode, parsePreflightResponse, validatePreflightResult, FAIL_OPEN_RESULT, PREFLIGHT_SYSTEM_PROMPT, matchTriggerSkills } from '../agentLoop.js';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

// Mock the skillLoader module (imported by agentLoop.js)
vi.mock('../skillLoader.js', () => ({
  getSkillSummary: vi.fn(() => null),
  getRegistryTriggers: vi.fn(() => new Map([
    ['cr-evaluator', ['cr', 'change request', 'feasibility', 'brd', 'requirement']],
    ['pm-pipeline', ['create brd', 'brd', 'run discovery', 'generate jira', 'pm pipeline']],
    ['capillary-sdd-writer', ['sdd', 'system design document', 'lld', 'low level design', 'technical spec']],
    ['solution-gap-analyzer', ['gap', 'gap analysis', 'brd', 'business requirements', 'coverage', 'feature analysis']],
    ['excalidraw-diagram', ['diagram', 'flow diagram', 'architecture diagram', 'excalidraw', 'flowchart', 'visual']],
  ])),
}));

import { createMessage } from '../llm.js';
import { getRegistryTriggers } from '../skillLoader.js';

describe('Preflight Gate — preflightNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Successful classification — on-topic', () => {
    it('classifies an on-topic query and returns structured result in state', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'search for Jira tickets related to deployment issues',
          toolTags: ['jira'],
          skillIds: ['troubleshooting'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      const state = {
        conversationId: 'conv-123',
        messages: [{ role: 'user', content: 'Find deployment issues in Jira' }],
        systemPrompt: 'You are a TAM agent.',
        problemText: 'Find deployment issues in Jira',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('search for Jira tickets related to deployment issues');
      expect(result.toolTags).toEqual(['jira']);
      expect(result.skillIds).toEqual(['troubleshooting']);
      // Original state fields preserved
      expect(result.conversationId).toBe('conv-123');
      expect(result.systemPrompt).toBe('You are a TAM agent.');
    });

    it('calls createMessage with haiku model and correct parameters', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'general inquiry',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 15 },
      });

      const state = {
        messages: [{ role: 'user', content: 'How do I reset my password?' }],
        problemText: 'How do I reset my password?',
      };

      await preflightNode(state);

      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage).toHaveBeenCalledWith({
        model: 'haiku',
        system: PREFLIGHT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: 'How do I reset my password?' }],
        maxTokens: 256,
      });
    });

    it('handles multiple tool tags and skill IDs', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'research across multiple sources',
          toolTags: ['jira', 'confluence', 'webSearch'],
          skillIds: ['troubleshooting'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 40, output_tokens: 25 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Find all info about the auth service outage' }],
        problemText: 'Find all info about the auth service outage',
      };

      const result = await preflightNode(state);

      expect(result.toolTags).toEqual(['jira', 'confluence', 'webSearch']);
      expect(result.skillIds).toEqual(['troubleshooting']);
    });
  });

  describe('Off-topic classification', () => {
    it('classifies an off-topic query correctly', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: false,
          intent: 'casual conversation unrelated to technical support',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 20 },
      });

      const state = {
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        problemText: 'What is the meaning of life?',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(false);
      expect(result.intent).toBe('casual conversation unrelated to technical support');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
    });
  });

  describe('Parse failure — fail-open behavior', () => {
    it('returns fail-open result when LLM returns non-JSON text', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'I cannot classify this query properly.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 10 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Help me with something' }],
        problemText: 'Help me with something',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Preflight] Failed to parse LLM response')
      );
    });

    it('returns fail-open result when LLM returns empty content', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Test' }],
        problemText: 'Test',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
    });

    it('returns fail-open result when JSON is malformed', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: '{ onTopic: true, intent: broken }' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 8 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Something' }],
        problemText: 'Something',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
    });

    it('returns fail-open result when onTopic is not a boolean', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: 'yes',
          intent: 'something',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 10 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Query' }],
        problemText: 'Query',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
    });
  });

  describe('LLM error handling', () => {
    it('returns fail-open result when createMessage throws an error', async () => {
      createMessage.mockRejectedValue(new Error('Bedrock API timeout'));

      const state = {
        messages: [{ role: 'user', content: 'Help me troubleshoot' }],
        problemText: 'Help me troubleshoot',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Preflight] LLM call failed'),
        'Bedrock API timeout'
      );
    });

    it('returns fail-open result when createMessage throws LLMError', async () => {
      const llmError = new Error('Rate limited');
      llmError.name = 'LLMError';
      llmError.errorType = 'rate_limit_error';
      llmError.statusCode = 429;
      createMessage.mockRejectedValue(llmError);

      const state = {
        messages: [{ role: 'user', content: 'Search Jira' }],
        problemText: 'Search Jira',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
    });

    it('preserves original state fields on error', async () => {
      createMessage.mockRejectedValue(new Error('Network error'));

      const state = {
        conversationId: 'conv-456',
        messages: [{ role: 'user', content: 'Help' }],
        systemPrompt: 'System prompt here',
        problemText: 'Help',
      };

      const result = await preflightNode(state);

      expect(result.conversationId).toBe('conv-456');
      expect(result.systemPrompt).toBe('System prompt here');
      expect(result.messages).toEqual([{ role: 'user', content: 'Help' }]);
    });
  });

  describe('State handling edge cases', () => {
    it('uses problemText from state when available', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'test',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Old message' }, { role: 'user', content: 'Latest message' }],
        problemText: 'Explicit problem text',
      };

      await preflightNode(state);

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Explicit problem text' }],
        })
      );
    });

    it('falls back to latest user message content when problemText is not set', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'test',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const state = {
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Latest user message' },
        ],
      };

      await preflightNode(state);

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Latest user message' }],
        })
      );
    });

    it('handles JSON wrapped in markdown code blocks', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: '```json\n{"onTopic": true, "intent": "search docs", "toolTags": ["confluence"], "skillIds": []}\n```' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 15 },
      });

      const state = {
        messages: [{ role: 'user', content: 'Find docs about auth' }],
        problemText: 'Find docs about auth',
      };

      const result = await preflightNode(state);

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('search docs');
      expect(result.toolTags).toEqual(['confluence']);
    });
  });
});

describe('parsePreflightResponse', () => {
  it('parses a valid JSON text response', () => {
    const response = {
      role: 'assistant',
      content: [{ type: 'text', text: '{"onTopic": true, "intent": "search", "toolTags": ["jira"], "skillIds": []}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = parsePreflightResponse(response);

    expect(result).toEqual({
      onTopic: true,
      intent: 'search',
      toolTags: ['jira'],
      skillIds: [],
    });
  });

  it('returns null when content has no text block', () => {
    const response = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool1', name: 'search', input: {} }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    expect(parsePreflightResponse(response)).toBeNull();
  });

  it('returns null when text is empty', () => {
    const response = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    expect(parsePreflightResponse(response)).toBeNull();
  });

  it('extracts JSON from text with surrounding content', () => {
    const response = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is the classification:\n{"onTopic": false, "intent": "off-topic chat", "toolTags": [], "skillIds": []}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = parsePreflightResponse(response);

    expect(result).toEqual({
      onTopic: false,
      intent: 'off-topic chat',
      toolTags: [],
      skillIds: [],
    });
  });
});

describe('validatePreflightResult', () => {
  it('returns validated result for valid input', () => {
    const result = validatePreflightResult({
      onTopic: true,
      intent: 'search',
      toolTags: ['jira'],
      skillIds: ['troubleshooting'],
    });

    expect(result).toEqual({
      onTopic: true,
      intent: 'search',
      toolTags: ['jira'],
      skillIds: ['troubleshooting'],
    });
  });

  it('returns null when onTopic is not a boolean', () => {
    expect(validatePreflightResult({ onTopic: 'yes', intent: 'x', toolTags: [], skillIds: [] })).toBeNull();
    expect(validatePreflightResult({ onTopic: 1, intent: 'x', toolTags: [], skillIds: [] })).toBeNull();
    expect(validatePreflightResult({ onTopic: null, intent: 'x', toolTags: [], skillIds: [] })).toBeNull();
  });

  it('defaults intent to "unknown" when not a string', () => {
    const result = validatePreflightResult({ onTopic: true, intent: 123, toolTags: [], skillIds: [] });
    expect(result.intent).toBe('unknown');
  });

  it('defaults toolTags to empty array when not an array', () => {
    const result = validatePreflightResult({ onTopic: true, intent: 'test', toolTags: 'jira', skillIds: [] });
    expect(result.toolTags).toEqual([]);
  });

  it('defaults skillIds to empty array when not an array', () => {
    const result = validatePreflightResult({ onTopic: true, intent: 'test', toolTags: [], skillIds: 'troubleshooting' });
    expect(result.skillIds).toEqual([]);
  });

  it('returns null for null input', () => {
    expect(validatePreflightResult(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(validatePreflightResult('string')).toBeNull();
    expect(validatePreflightResult(42)).toBeNull();
  });
});

describe('FAIL_OPEN_RESULT', () => {
  it('has the expected fail-open structure', () => {
    expect(FAIL_OPEN_RESULT).toEqual({
      onTopic: true,
      intent: 'unknown',
      toolTags: [],
      skillIds: [],
    });
  });
});

describe('matchTriggerSkills', () => {
  it('returns matching skill IDs when query contains trigger keywords', () => {
    const result = matchTriggerSkills('I need to create a BRD for this project');
    expect(result).toContain('cr-evaluator');
    expect(result).toContain('pm-pipeline');
    expect(result).toContain('solution-gap-analyzer');
  });

  it('performs case-insensitive matching', () => {
    const result = matchTriggerSkills('Generate an SDD document');
    expect(result).toContain('capillary-sdd-writer');
  });

  it('returns empty array when no triggers match', () => {
    const result = matchTriggerSkills('What is the weather today?');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(matchTriggerSkills('')).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(matchTriggerSkills(null)).toEqual([]);
    expect(matchTriggerSkills(undefined)).toEqual([]);
  });

  it('returns empty array for non-string input', () => {
    expect(matchTriggerSkills(123)).toEqual([]);
  });

  it('matches multi-word triggers', () => {
    const result = matchTriggerSkills('Can you run a gap analysis on this?');
    expect(result).toContain('solution-gap-analyzer');
  });

  it('matches diagram trigger keywords', () => {
    const result = matchTriggerSkills('Draw a flowchart for the auth process');
    expect(result).toContain('excalidraw-diagram');
  });

  it('returns multiple skills when multiple triggers match', () => {
    // "brd" appears in both cr-evaluator, pm-pipeline, and solution-gap-analyzer
    const result = matchTriggerSkills('evaluate this brd document');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result).toContain('cr-evaluator');
    expect(result).toContain('pm-pipeline');
    expect(result).toContain('solution-gap-analyzer');
  });
});

describe('preflightNode — trigger skill merging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges trigger-matched skills with LLM-classified skills', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: true,
        intent: 'create a BRD',
        toolTags: ['jira'],
        skillIds: ['custom-skill'],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 30 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Create a BRD for client X' }],
      problemText: 'Create a BRD for client X',
    };

    const result = await preflightNode(state);

    // Should include LLM-classified skill and trigger-matched skills
    expect(result.skillIds).toContain('custom-skill');
    expect(result.skillIds).toContain('cr-evaluator');
    expect(result.skillIds).toContain('pm-pipeline');
    expect(result.skillIds).toContain('solution-gap-analyzer');
  });

  it('deduplicates skill IDs from LLM and trigger matching', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: true,
        intent: 'create a diagram',
        toolTags: [],
        skillIds: ['excalidraw-diagram'],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 30 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Draw me a diagram of the system' }],
      problemText: 'Draw me a diagram of the system',
    };

    const result = await preflightNode(state);

    // excalidraw-diagram should appear only once (deduplicated)
    const excalidrawCount = result.skillIds.filter(id => id === 'excalidraw-diagram').length;
    expect(excalidrawCount).toBe(1);
    expect(result.skillIds).toContain('excalidraw-diagram');
  });

  it('returns only trigger-matched skills when LLM returns empty skillIds', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: true,
        intent: 'create SDD',
        toolTags: [],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 30 },
    });

    const state = {
      messages: [{ role: 'user', content: 'I need a system design document' }],
      problemText: 'I need a system design document',
    };

    const result = await preflightNode(state);

    expect(result.skillIds).toContain('capillary-sdd-writer');
  });

  it('returns only LLM skills when no trigger keywords match', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: true,
        intent: 'troubleshoot issue',
        toolTags: ['jira'],
        skillIds: ['troubleshooting'],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 30 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Help me fix the login issue' }],
      problemText: 'Help me fix the login issue',
    };

    const result = await preflightNode(state);

    expect(result.skillIds).toEqual(['troubleshooting']);
  });
});
