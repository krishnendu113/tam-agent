import { describe, it, expect, beforeEach, vi } from 'vitest';
import { estimateTokenCount, compactContext, DEFAULT_TOKEN_THRESHOLD } from '../compaction.js';

// Mock the llm.js module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';

describe('Context Compaction Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('estimateTokenCount', () => {
    it('returns 0 for an empty messages array', () => {
      expect(estimateTokenCount([])).toBe(0);
    });

    it('estimates tokens for a single short message', () => {
      const messages = [{ role: 'user', content: 'Hello' }]; // 5 chars → ceil(5/4) = 2
      expect(estimateTokenCount(messages)).toBe(2);
    });

    it('estimates tokens for multiple messages', () => {
      const messages = [
        { role: 'user', content: 'Hello there' },       // 11 chars
        { role: 'assistant', content: 'Hi! How can I help?' }, // 19 chars
      ];
      // Total: 30 chars → ceil(30/4) = 8
      expect(estimateTokenCount(messages)).toBe(8);
    });

    it('handles messages with non-string content (arrays/objects)', () => {
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];
      const jsonLength = JSON.stringify([{ type: 'text', text: 'Hello' }]).length;
      expect(estimateTokenCount(messages)).toBe(Math.ceil(jsonLength / 4));
    });

    it('handles long messages correctly', () => {
      const longContent = 'a'.repeat(400000); // 400000 chars → 100000 tokens
      const messages = [{ role: 'user', content: longContent }];
      expect(estimateTokenCount(messages)).toBe(100000);
    });

    it('sums token counts across all messages', () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },      // 100 chars
        { role: 'assistant', content: 'b'.repeat(200) },  // 200 chars
        { role: 'user', content: 'c'.repeat(100) },      // 100 chars
      ];
      // Total: 400 chars → ceil(400/4) = 100
      expect(estimateTokenCount(messages)).toBe(100);
    });
  });

  describe('compactContext — below threshold (no compaction)', () => {
    it('returns messages unchanged when below threshold', async () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = await compactContext({ messages, threshold: 1000 });

      expect(result.messages).toBe(messages);
      expect(result.wasCompacted).toBe(false);
      expect(result.fullHistory).toBe(messages);
    });

    it('does not invoke createMessage when below threshold', async () => {
      const messages = [{ role: 'user', content: 'Short message' }];

      await compactContext({ messages, threshold: 1000 });

      expect(createMessage).not.toHaveBeenCalled();
    });

    it('does not invoke onStatus when below threshold', async () => {
      const messages = [{ role: 'user', content: 'Short' }];
      const onStatus = vi.fn();

      await compactContext({ messages, threshold: 1000, onStatus });

      expect(onStatus).not.toHaveBeenCalled();
    });

    it('uses DEFAULT_TOKEN_THRESHOLD when threshold is not provided', async () => {
      // A short message should be well below 100000 tokens
      const messages = [{ role: 'user', content: 'Hello' }];

      const result = await compactContext({ messages });

      expect(result.wasCompacted).toBe(false);
    });
  });

  describe('compactContext — above threshold (compaction triggered)', () => {
    beforeEach(() => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Summary of the conversation about project setup and deployment.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    });

    it('compacts messages when above threshold', async () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
        { role: 'assistant', content: 'f'.repeat(100) },
        { role: 'user', content: 'g'.repeat(100) },
        { role: 'assistant', content: 'h'.repeat(100) },
      ];

      // threshold of 10 tokens (40 chars) — well below the total
      const result = await compactContext({ messages, threshold: 10 });

      expect(result.wasCompacted).toBe(true);
      // 8 messages compacted to: summary + ack + last 4 = 6 messages
      expect(result.messages.length).toBeLessThan(messages.length);
    });

    it('keeps last 4 messages as recent messages', async () => {
      const messages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
      ];

      const result = await compactContext({ messages, threshold: 1 });

      // Should have: summary message + assistant ack + last 4 messages = 6
      expect(result.messages.length).toBe(6);
      // Last 4 messages should be preserved
      expect(result.messages[2]).toEqual({ role: 'user', content: 'msg3' });
      expect(result.messages[3]).toEqual({ role: 'assistant', content: 'msg4' });
      expect(result.messages[4]).toEqual({ role: 'user', content: 'msg5' });
      expect(result.messages[5]).toEqual({ role: 'assistant', content: 'msg6' });
    });

    it('starts compacted messages with a summary message', async () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];

      const result = await compactContext({ messages, threshold: 1 });

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toContain('[Previous conversation summary:');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].content).toContain('I understand the context');
    });

    it('preserves full history in the result', async () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];

      const result = await compactContext({ messages, threshold: 1 });

      expect(result.fullHistory).toBe(messages);
      expect(result.fullHistory.length).toBe(5);
    });
  });

  describe('compactContext — onStatus callback', () => {
    beforeEach(() => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Conversation summary.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 10 },
      });
    });

    it('invokes onStatus with compaction notification when compaction starts', async () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];
      const onStatus = vi.fn();

      await compactContext({ messages, threshold: 1, onStatus });

      expect(onStatus).toHaveBeenCalledWith('Compacting conversation context...');
    });

    it('invokes onStatus with completion message after compaction', async () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];
      const onStatus = vi.fn();

      await compactContext({ messages, threshold: 1, onStatus });

      expect(onStatus).toHaveBeenCalledTimes(2);
      expect(onStatus.mock.calls[1][0]).toMatch(/Context compacted: \d+ messages → \d+ messages/);
    });

    it('works without onStatus callback (no error thrown)', async () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];

      // Should not throw
      const result = await compactContext({ messages, threshold: 1 });
      expect(result.wasCompacted).toBe(true);
    });
  });

  describe('summarizeMessages — uses Haiku model via createMessage', () => {
    it('calls createMessage with haiku model and summarization system prompt', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'A summary of the discussion.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 80, output_tokens: 15 },
      });

      const messages = [
        { role: 'user', content: 'Tell me about the project' },
        { role: 'assistant', content: 'The project is a TAM agent migration.' },
        { role: 'user', content: 'What tools does it use?' },
        { role: 'assistant', content: 'It uses Jira, Confluence, and web search.' },
        { role: 'user', content: 'Latest question' },
      ];

      await compactContext({ messages, threshold: 1 });

      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage).toHaveBeenCalledWith({
        model: 'haiku',
        system: 'Summarize the following conversation concisely, preserving key facts, decisions, and context that would be needed to continue the conversation.',
        messages: [{ role: 'user', content: expect.any(String) }],
        maxTokens: 512,
      });
    });

    it('formats messages as role: content for the summarization prompt', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Summary.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 5 },
      });

      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'Good!' },
        { role: 'user', content: 'Latest' },
      ];

      await compactContext({ messages, threshold: 1 });

      // The older message (first one) should be formatted as "role: content"
      const callArgs = createMessage.mock.calls[0][0];
      const content = callArgs.messages[0].content;
      expect(content).toContain('user: Hello');
    });

    it('handles non-string content in messages by JSON stringifying', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Summary of complex messages.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 8 },
      });

      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Complex content' }] },
        { role: 'assistant', content: 'Simple response' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
      ];

      await compactContext({ messages, threshold: 1 });

      const callArgs = createMessage.mock.calls[0][0];
      const content = callArgs.messages[0].content;
      // Non-string content should be JSON stringified
      expect(content).toContain('user: [{"type":"text","text":"Complex content"}]');
    });

    it('uses fallback text when LLM response has no text block', async () => {
      createMessage.mockResolvedValue({
        role: 'assistant',
        content: [], // No text block
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];

      const result = await compactContext({ messages, threshold: 1 });

      expect(result.messages[0].content).toContain('Previous conversation context.');
    });
  });

  describe('Error handling when LLM call fails', () => {
    it('propagates errors from createMessage', async () => {
      createMessage.mockRejectedValue(new Error('LLM service unavailable'));

      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];

      await expect(
        compactContext({ messages, threshold: 1 })
      ).rejects.toThrow('LLM service unavailable');
    });

    it('invokes onStatus before the LLM call fails', async () => {
      createMessage.mockRejectedValue(new Error('Network error'));

      const messages = [
        { role: 'user', content: 'a'.repeat(100) },
        { role: 'assistant', content: 'b'.repeat(100) },
        { role: 'user', content: 'c'.repeat(100) },
        { role: 'assistant', content: 'd'.repeat(100) },
        { role: 'user', content: 'e'.repeat(100) },
      ];
      const onStatus = vi.fn();

      await expect(
        compactContext({ messages, threshold: 1, onStatus })
      ).rejects.toThrow('Network error');

      // onStatus should have been called with the initial notification before the error
      expect(onStatus).toHaveBeenCalledWith('Compacting conversation context...');
    });
  });

  describe('DEFAULT_TOKEN_THRESHOLD', () => {
    it('is set to 100000', () => {
      expect(DEFAULT_TOKEN_THRESHOLD).toBe(100000);
    });
  });
});
