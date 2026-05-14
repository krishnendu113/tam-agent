import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  classifyQuery,
  parsePreflightResponse,
  validatePreflightResult,
  PREFLIGHT_SYSTEM_PROMPT,
  FAIL_OPEN_RESULT,
} from '../preflight.js';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';

describe('Preflight Module — classifyQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Successful classification', () => {
    it('classifies an on-topic query and returns structured result', async () => {
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

      const result = await classifyQuery('Find deployment issues in Jira');

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('search for Jira tickets related to deployment issues');
      expect(result.toolTags).toEqual(['jira']);
      expect(result.skillIds).toEqual(['troubleshooting']);
    });

    it('classifies an off-topic query correctly', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: false,
          intent: 'casual conversation',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 20 },
      });

      const result = await classifyQuery('What is the meaning of life?');

      expect(result.onTopic).toBe(false);
      expect(result.intent).toBe('casual conversation');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
    });

    it('calls createMessage with haiku model and correct parameters', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'test',
          toolTags: [],
          skillIds: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      });

      await classifyQuery('test query');

      expect(createMessage).toHaveBeenCalledWith({
        model: 'haiku',
        system: PREFLIGHT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: 'test query' }],
        maxTokens: 256,
      });
    });

    it('handles multiple tool tags and skill IDs', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          onTopic: true,
          intent: 'cross-reference Jira and Confluence',
          toolTags: ['jira', 'confluence'],
          skillIds: ['troubleshooting'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 40, output_tokens: 30 },
      });

      const result = await classifyQuery('Check Jira and Confluence for related issues');

      expect(result.toolTags).toEqual(['jira', 'confluence']);
      expect(result.skillIds).toEqual(['troubleshooting']);
    });
  });

  describe('Fail-open behavior', () => {
    it('returns fail-open result when LLM call throws an error', async () => {
      createMessage.mockRejectedValue(new Error('Network timeout'));

      const result = await classifyQuery('some query');

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
      expect(result.toolTags).toEqual([]);
      expect(result.skillIds).toEqual([]);
      expect(console.warn).toHaveBeenCalled();
    });

    it('returns fail-open result when response has no text content', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const result = await classifyQuery('some query');

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
    });

    it('returns fail-open result when response is not valid JSON', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'This is not JSON at all' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      });

      const result = await classifyQuery('some query');

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
    });

    it('returns fail-open result when JSON is missing onTopic field', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ intent: 'test' }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      });

      const result = await classifyQuery('some query');

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('unknown');
    });
  });

  describe('JSON extraction from wrapped responses', () => {
    it('extracts JSON from markdown code blocks', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: '```json\n{"onTopic": true, "intent": "test", "toolTags": ["jira"], "skillIds": []}\n```' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = await classifyQuery('test');

      expect(result.onTopic).toBe(true);
      expect(result.intent).toBe('test');
      expect(result.toolTags).toEqual(['jira']);
    });

    it('extracts JSON with surrounding text', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the classification:\n{"onTopic": false, "intent": "off-topic", "toolTags": [], "skillIds": []}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = await classifyQuery('hello');

      expect(result.onTopic).toBe(false);
      expect(result.intent).toBe('off-topic');
    });
  });
});

describe('Preflight Module — parsePreflightResponse', () => {
  it('returns null for response with no text blocks', () => {
    const result = parsePreflightResponse({ content: [{ type: 'tool_use', id: '1', name: 'test', input: {} }] });
    expect(result).toBeNull();
  });

  it('returns null for empty text', () => {
    const result = parsePreflightResponse({ content: [{ type: 'text', text: '' }] });
    expect(result).toBeNull();
  });

  it('parses valid JSON response', () => {
    const result = parsePreflightResponse({
      content: [{ type: 'text', text: '{"onTopic": true, "intent": "test", "toolTags": ["jira"], "skillIds": []}' }],
    });
    expect(result).toEqual({
      onTopic: true,
      intent: 'test',
      toolTags: ['jira'],
      skillIds: [],
    });
  });
});

describe('Preflight Module — validatePreflightResult', () => {
  it('returns null for non-object input', () => {
    expect(validatePreflightResult(null)).toBeNull();
    expect(validatePreflightResult('string')).toBeNull();
    expect(validatePreflightResult(42)).toBeNull();
  });

  it('returns null when onTopic is not a boolean', () => {
    expect(validatePreflightResult({ onTopic: 'yes', intent: 'test' })).toBeNull();
    expect(validatePreflightResult({ onTopic: 1, intent: 'test' })).toBeNull();
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
});
