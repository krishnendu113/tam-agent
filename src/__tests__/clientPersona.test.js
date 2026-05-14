import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectPersona,
  parsePersonaResponse,
  validatePersonaResult,
  PERSONA_SYSTEM_PROMPT,
  DEFAULT_PERSONA,
} from '../clientPersona.js';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';

describe('ClientPersona Module — detectPersona', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Successful detection', () => {
    it('detects a technical-lead persona from conversation', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          persona: 'technical-lead',
          confidence: 0.85,
          traits: ['technical', 'detail-oriented', 'architecture-focused'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 40 },
      });

      const messages = [
        { role: 'user', content: 'Can you check the microservice architecture for our deployment pipeline?' },
        { role: 'assistant', content: 'I can look into that for you.' },
        { role: 'user', content: 'Also, what is the latency impact of the new load balancer config?' },
      ];

      const result = await detectPersona(messages);

      expect(result.persona).toBe('technical-lead');
      expect(result.confidence).toBe(0.85);
      expect(result.traits).toEqual(['technical', 'detail-oriented', 'architecture-focused']);
    });

    it('detects a support-user persona', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          persona: 'support-user',
          confidence: 0.9,
          traits: ['non-technical', 'needs-guidance'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 60, output_tokens: 30 },
      });

      const messages = [
        { role: 'user', content: 'How do I reset my password?' },
      ];

      const result = await detectPersona(messages);

      expect(result.persona).toBe('support-user');
      expect(result.confidence).toBe(0.9);
      expect(result.traits).toEqual(['non-technical', 'needs-guidance']);
    });

    it('calls createMessage with haiku model', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          persona: 'developer',
          confidence: 0.7,
          traits: ['technical'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const messages = [{ role: 'user', content: 'How do I use the API?' }];

      await detectPersona(messages);

      expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
        model: 'haiku',
        system: PERSONA_SYSTEM_PROMPT,
        maxTokens: 256,
      }));
    });

    it('formats messages correctly for detection', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          persona: 'developer',
          confidence: 0.8,
          traits: ['concise'],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      await detectPersona(messages);

      const callArgs = createMessage.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('User: Hello');
      expect(callArgs.messages[0].content).toContain('Assistant: Hi there!');
    });

    it('handles messages with content block arrays', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({
          persona: 'developer',
          confidence: 0.6,
          traits: [],
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Check this code' }] },
      ];

      await detectPersona(messages);

      const callArgs = createMessage.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('User: Check this code');
    });
  });

  describe('Default persona on failure', () => {
    it('returns default persona when messages array is empty', async () => {
      const result = await detectPersona([]);

      expect(result).toEqual(DEFAULT_PERSONA);
      expect(createMessage).not.toHaveBeenCalled();
    });

    it('returns default persona when messages is null', async () => {
      const result = await detectPersona(null);

      expect(result).toEqual(DEFAULT_PERSONA);
      expect(createMessage).not.toHaveBeenCalled();
    });

    it('returns default persona when messages is undefined', async () => {
      const result = await detectPersona(undefined);

      expect(result).toEqual(DEFAULT_PERSONA);
      expect(createMessage).not.toHaveBeenCalled();
    });

    it('returns default persona when LLM call throws an error', async () => {
      createMessage.mockRejectedValue(new Error('Service unavailable'));

      const messages = [{ role: 'user', content: 'test' }];
      const result = await detectPersona(messages);

      expect(result).toEqual(DEFAULT_PERSONA);
      expect(console.warn).toHaveBeenCalled();
    });

    it('returns default persona when response has no text content', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const messages = [{ role: 'user', content: 'test' }];
      const result = await detectPersona(messages);

      expect(result).toEqual(DEFAULT_PERSONA);
    });

    it('returns default persona when response is not valid JSON', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'I cannot determine the persona' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 },
      });

      const messages = [{ role: 'user', content: 'test' }];
      const result = await detectPersona(messages);

      expect(result).toEqual(DEFAULT_PERSONA);
    });
  });

  describe('Parallel execution support', () => {
    it('can run in parallel with classifyQuery (both use createMessage independently)', async () => {
      // Simulate two concurrent calls — both should resolve independently
      createMessage
        .mockResolvedValueOnce({
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({
            persona: 'developer',
            confidence: 0.8,
            traits: ['technical'],
          }) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 20 },
        })
        .mockResolvedValueOnce({
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({
            persona: 'executive',
            confidence: 0.7,
            traits: ['strategic'],
          }) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 20 },
        });

      const messages = [{ role: 'user', content: 'test' }];

      // Run two detectPersona calls in parallel
      const [result1, result2] = await Promise.all([
        detectPersona(messages),
        detectPersona(messages),
      ]);

      expect(result1.persona).toBe('developer');
      expect(result2.persona).toBe('executive');
      expect(createMessage).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ClientPersona Module — parsePersonaResponse', () => {
  it('returns null for response with no text blocks', () => {
    const result = parsePersonaResponse({ content: [{ type: 'tool_use', id: '1', name: 'test', input: {} }] });
    expect(result).toBeNull();
  });

  it('returns null for empty text', () => {
    const result = parsePersonaResponse({ content: [{ type: 'text', text: '' }] });
    expect(result).toBeNull();
  });

  it('parses valid JSON response', () => {
    const result = parsePersonaResponse({
      content: [{ type: 'text', text: '{"persona": "developer", "confidence": 0.8, "traits": ["technical"]}' }],
    });
    expect(result).toEqual({
      persona: 'developer',
      confidence: 0.8,
      traits: ['technical'],
    });
  });

  it('extracts JSON from markdown code blocks', () => {
    const result = parsePersonaResponse({
      content: [{ type: 'text', text: '```json\n{"persona": "executive", "confidence": 0.9, "traits": ["strategic"]}\n```' }],
    });
    expect(result).toEqual({
      persona: 'executive',
      confidence: 0.9,
      traits: ['strategic'],
    });
  });
});

describe('ClientPersona Module — validatePersonaResult', () => {
  it('returns null for non-object input', () => {
    expect(validatePersonaResult(null)).toBeNull();
    expect(validatePersonaResult('string')).toBeNull();
    expect(validatePersonaResult(42)).toBeNull();
  });

  it('returns null when persona is not a string', () => {
    expect(validatePersonaResult({ persona: 123, confidence: 0.5 })).toBeNull();
    expect(validatePersonaResult({ persona: null, confidence: 0.5 })).toBeNull();
  });

  it('returns null when persona is empty string', () => {
    expect(validatePersonaResult({ persona: '', confidence: 0.5 })).toBeNull();
  });

  it('clamps confidence to 0-1 range', () => {
    const result1 = validatePersonaResult({ persona: 'developer', confidence: 1.5, traits: [] });
    expect(result1.confidence).toBe(1);

    const result2 = validatePersonaResult({ persona: 'developer', confidence: -0.5, traits: [] });
    expect(result2.confidence).toBe(0);
  });

  it('defaults confidence to 0 when not a number', () => {
    const result = validatePersonaResult({ persona: 'developer', confidence: 'high', traits: [] });
    expect(result.confidence).toBe(0);
  });

  it('defaults traits to empty array when not an array', () => {
    const result = validatePersonaResult({ persona: 'developer', confidence: 0.5, traits: 'technical' });
    expect(result.traits).toEqual([]);
  });
});
