import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the llm.js module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';
import { compactContext, estimateTokenCount } from '../compaction.js';

// --- Generators ---

/**
 * Generates a random message with content of varying length.
 */
function arbMessage() {
  return fc.record({
    role: fc.constantFrom('user', 'assistant'),
    content: fc.string({ minLength: 1, maxLength: 500 }),
  });
}

/**
 * Generates arrays of messages with random content lengths.
 */
function arbMessages() {
  return fc.array(arbMessage(), { minLength: 1, maxLength: 20 });
}

/**
 * Generates random token thresholds.
 */
function arbThreshold() {
  return fc.integer({ min: 1, max: 10000 });
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 16: Context Compaction Trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for createMessage — returns a valid summarization response
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: 'Summary of the conversation.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  /**
   * Validates: Requirements 9.1
   *
   * For any conversation where the estimated token count exceeds the configured threshold,
   * the Context_Compactor SHALL invoke summarization (createMessage is called).
   */
  it('Conversations exceeding threshold trigger summarization (createMessage is called)', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessages(), arbThreshold(), async (messages, threshold) => {
        createMessage.mockClear();

        const estimatedTokens = estimateTokenCount(messages);

        // Only test cases where tokens exceed threshold
        fc.pre(estimatedTokens > threshold);

        const result = await compactContext({ messages, threshold });

        // Summarization should have been invoked
        expect(result.wasCompacted).toBe(true);
        expect(createMessage).toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 9.1
   *
   * For any conversation where the estimated token count is at or below the configured threshold,
   * the Context_Compactor SHALL NOT invoke summarization (createMessage is NOT called).
   */
  it('Conversations at or below threshold do NOT trigger summarization', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessages(), arbThreshold(), async (messages, threshold) => {
        createMessage.mockClear();

        const estimatedTokens = estimateTokenCount(messages);

        // Only test cases where tokens are at or below threshold
        fc.pre(estimatedTokens <= threshold);

        const result = await compactContext({ messages, threshold });

        // Summarization should NOT have been invoked
        expect(result.wasCompacted).toBe(false);
        expect(createMessage).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 9.2
   *
   * In ALL cases (whether compacted or not), the full conversation history
   * SHALL be preserved (fullHistory equals the original messages array).
   */
  it('Full conversation history is always preserved regardless of compaction', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessages(), arbThreshold(), async (messages, threshold) => {
        createMessage.mockClear();

        const result = await compactContext({ messages, threshold });

        // fullHistory must always equal the original messages array
        expect(result.fullHistory).toBe(messages);
        expect(result.fullHistory.length).toBe(messages.length);
      }),
      { numRuns: 100 }
    );
  });
});
