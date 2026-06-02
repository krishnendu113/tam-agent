import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateTokenCount,
  shouldCompact,
  compactHistory,
  buildCompactedContext,
  MAX_CONTEXT_TOKENS,
} from '../compaction.js';

// Mock the llm.js module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';

describe('Context Compaction - New API (shouldCompact, compactHistory, buildCompactedContext)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env vars
    delete process.env.CONTEXT_COMPACTION_THRESHOLD;
    delete process.env.CONTEXT_COMPACTION_PRESERVE_TURNS;
  });

  afterEach(() => {
    delete process.env.CONTEXT_COMPACTION_THRESHOLD;
    delete process.env.CONTEXT_COMPACTION_PRESERVE_TURNS;
  });

  describe('MAX_CONTEXT_TOKENS', () => {
    it('is exported and set to 200000', () => {
      expect(MAX_CONTEXT_TOKENS).toBe(200000);
    });
  });

  describe('shouldCompact', () => {
    it('returns false when messages are well below threshold', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      // Default threshold is 75% of 200000 = 150000 tokens
      expect(shouldCompact(messages)).toBe(false);
    });

    it('returns true when estimated tokens exceed threshold', () => {
      // Need > 150000 tokens at 75% threshold = 600000 chars
      const messages = [{ role: 'user', content: 'a'.repeat(700000) }];
      expect(shouldCompact(messages)).toBe(true);
    });

    it('uses explicit threshold parameter when provided', () => {
      // 50% of 200000 = 100000 tokens = 400000 chars
      const messages = [{ role: 'user', content: 'a'.repeat(500000) }];
      expect(shouldCompact(messages, 50)).toBe(true);
    });

    it('returns false at exactly the threshold boundary', () => {
      // 75% of 200000 = 150000 tokens = 600000 chars exactly
      // estimateTokenCount rounds up, so 600000 chars = ceil(600000/4) = 150000
      // shouldCompact: 150000 > 150000 → false (not strictly greater)
      const messages = [{ role: 'user', content: 'a'.repeat(600000) }];
      expect(shouldCompact(messages)).toBe(false);
    });

    it('returns true when just above threshold', () => {
      // 150000 tokens requires > 600000 chars. 600001 chars → ceil(600001/4) = 150001 > 150000
      const messages = [{ role: 'user', content: 'a'.repeat(600001) }];
      expect(shouldCompact(messages)).toBe(true);
    });

    it('reads threshold from CONTEXT_COMPACTION_THRESHOLD env var', () => {
      process.env.CONTEXT_COMPACTION_THRESHOLD = '50';
      // 50% of 200000 = 100000 tokens = 400000 chars
      const messages = [{ role: 'user', content: 'a'.repeat(500000) }];
      expect(shouldCompact(messages)).toBe(true);
    });

    it('uses default 75 when env var is invalid', () => {
      process.env.CONTEXT_COMPACTION_THRESHOLD = 'invalid';
      // Fallback to 75%: 150000 tokens
      const messages = [{ role: 'user', content: 'a'.repeat(700000) }];
      expect(shouldCompact(messages)).toBe(true);
    });

    it('uses default 75 when env var is empty', () => {
      process.env.CONTEXT_COMPACTION_THRESHOLD = '';
      const messages = [{ role: 'user', content: 'a'.repeat(700000) }];
      expect(shouldCompact(messages)).toBe(true);
    });

    it('is a pure function — same inputs produce same output', () => {
      const messages = [{ role: 'user', content: 'a'.repeat(700000) }];
      const result1 = shouldCompact(messages, 75);
      const result2 = shouldCompact(messages, 75);
      expect(result1).toBe(result2);
    });
  });

  describe('compactHistory', () => {
    beforeEach(() => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Summary of earlier conversation about project setup.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 30 },
      });
    });

    it('returns empty summary when messages <= preserveTurns', async () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      const result = await compactHistory(messages, 5);

      expect(result.summary).toBe('');
      expect(result.recentMessages).toEqual(messages);
      expect(result.olderMessages).toEqual([]);
      expect(createMessage).not.toHaveBeenCalled();
    });

    it('preserves the specified number of recent turns', async () => {
      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
        { role: 'user', content: 'msg7' },
      ];

      const result = await compactHistory(messages, 3);

      expect(result.recentMessages).toEqual([
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
        { role: 'user', content: 'msg7' },
      ]);
      expect(result.olderMessages).toEqual([
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
      ]);
    });

    it('calls Haiku to summarize older messages', async () => {
      const messages = [
        { role: 'user', content: 'Question about deployment' },
        { role: 'assistant', content: 'Here is how to deploy...' },
        { role: 'user', content: 'What about testing?' },
        { role: 'assistant', content: 'Run npm test...' },
        { role: 'user', content: 'Thanks!' },
        { role: 'assistant', content: 'You are welcome!' },
      ];

      const result = await compactHistory(messages, 2);

      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
        model: 'haiku',
        maxTokens: 1024,
      }));
      expect(result.summary).toBe('Summary of earlier conversation about project setup.');
    });

    it('reads preserveTurns from CONTEXT_COMPACTION_PRESERVE_TURNS env var', async () => {
      process.env.CONTEXT_COMPACTION_PRESERVE_TURNS = '2';

      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
      ];

      const result = await compactHistory(messages);

      expect(result.recentMessages.length).toBe(2);
      expect(result.olderMessages.length).toBe(2);
    });

    it('uses default 5 when env var is not set', async () => {
      const messages = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i + 1}`,
      }));

      const result = await compactHistory(messages);

      expect(result.recentMessages.length).toBe(5);
      expect(result.olderMessages.length).toBe(3);
    });

    it('does not mutate the original messages array', async () => {
      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
      ];
      const originalCopy = JSON.parse(JSON.stringify(messages));

      await compactHistory(messages, 2);

      expect(messages).toEqual(originalCopy);
    });

    it('returns fallback summary when LLM returns no text block', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
      ];

      const result = await compactHistory(messages, 2);

      expect(result.summary).toBe('Previous conversation context.');
    });
  });

  describe('buildCompactedContext', () => {
    it('assembles context with summary + acknowledgement + recent messages', () => {
      const summary = 'User discussed deployment and testing.';
      const recentMessages = [
        { role: 'user', content: 'Latest question' },
        { role: 'assistant', content: 'Latest answer' },
      ];

      const result = buildCompactedContext(summary, recentMessages);

      expect(result.length).toBe(4); // summary + ack + 2 recent
      expect(result[0].role).toBe('user');
      expect(result[0].content).toContain('[Previous conversation summary:');
      expect(result[0].content).toContain(summary);
      expect(result[1].role).toBe('assistant');
      expect(result[1].content).toContain('I understand the context');
      expect(result[2]).toEqual(recentMessages[0]);
      expect(result[3]).toEqual(recentMessages[1]);
    });

    it('returns only summary + ack when recentMessages is empty', () => {
      const result = buildCompactedContext('Some summary', []);

      expect(result.length).toBe(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('preserves recent messages byte-for-byte', () => {
      const recentMessages = [
        { role: 'user', content: 'Exact content with special chars: "quotes" & <brackets>' },
        { role: 'assistant', content: 'Response with\nnewlines\ttabs' },
      ];

      const result = buildCompactedContext('summary', recentMessages);

      // Recent messages should be identical (same reference)
      expect(result[2]).toBe(recentMessages[0]);
      expect(result[3]).toBe(recentMessages[1]);
    });

    it('does not mutate the input recentMessages array', () => {
      const recentMessages = [
        { role: 'user', content: 'msg1' },
      ];
      const originalLength = recentMessages.length;

      buildCompactedContext('summary', recentMessages);

      expect(recentMessages.length).toBe(originalLength);
    });
  });

  describe('Integration: shouldCompact + compactHistory + buildCompactedContext', () => {
    beforeEach(() => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Summarized conversation about AWS migration and testing strategies.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 50 },
      });
    });

    it('full workflow: detect, compact, and build context', async () => {
      // Create messages that exceed 75% threshold (150000 tokens = 600000 chars)
      const longMessages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(40000), // 20 * 40000 = 800000 chars = 200000 tokens
      }));

      // Step 1: Check if compaction needed
      expect(shouldCompact(longMessages)).toBe(true);

      // Step 2: Compact history (preserve last 5)
      const { summary, recentMessages } = await compactHistory(longMessages, 5);

      expect(summary).toBe('Summarized conversation about AWS migration and testing strategies.');
      expect(recentMessages.length).toBe(5);

      // Step 3: Build compacted context
      const context = buildCompactedContext(summary, recentMessages);

      expect(context.length).toBe(7); // summary + ack + 5 recent
      expect(context[0].content).toContain('Summarized conversation about AWS migration');

      // Verify recent messages are the last 5 from original
      for (let i = 0; i < 5; i++) {
        expect(context[i + 2]).toBe(longMessages[longMessages.length - 5 + i]);
      }
    });
  });
});
