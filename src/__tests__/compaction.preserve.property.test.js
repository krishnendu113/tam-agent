import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the llm.js module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';
import { compactHistory } from '../compaction.js';

// --- Generators ---

/**
 * Generates a random message with role and arbitrary string content.
 */
function arbMessage() {
  return fc.record({
    role: fc.constantFrom('user', 'assistant'),
    content: fc.string({ minLength: 1, maxLength: 200 }),
  });
}

/**
 * Generates a preserveTurns value in the valid range [1, 10].
 */
function arbPreserveTurns() {
  return fc.integer({ min: 1, max: 10 });
}

/**
 * Generates an array of messages whose length is strictly greater than preserveTurns.
 * Returns { messages, preserveTurns } where messages.length > preserveTurns.
 */
function arbMessagesAndPreserveTurns() {
  return arbPreserveTurns().chain((preserveTurns) =>
    fc
      .array(arbMessage(), { minLength: preserveTurns + 1, maxLength: 30 })
      .map((messages) => ({ messages, preserveTurns }))
  );
}

// --- Property Tests ---

describe('Feature: skill-system-enhancement, Property 12: Compaction Preserves Recent Turns Verbatim', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock createMessage to return a summary response
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: 'Summary of earlier conversation.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  /**
   * **Validates: Requirements 8.3**
   *
   * For any message array with length > PRESERVE_TURNS, after compaction the most recent
   * PRESERVE_TURNS messages in the output context SHALL be byte-for-byte identical
   * to the last PRESERVE_TURNS messages of the original array.
   */
  it('After compaction, recentMessages are byte-for-byte identical to the last preserveTurns messages of the original array', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessagesAndPreserveTurns(), async ({ messages, preserveTurns }) => {
        createMessage.mockClear();

        const result = await compactHistory(messages, preserveTurns);

        const expectedRecent = messages.slice(-preserveTurns);

        // Verify count matches
        expect(result.recentMessages.length).toBe(preserveTurns);

        // Byte-for-byte identical via JSON.stringify comparison
        expect(JSON.stringify(result.recentMessages)).toBe(
          JSON.stringify(expectedRecent)
        );

        // Also verify deep equality for each element
        for (let i = 0; i < preserveTurns; i++) {
          expect(result.recentMessages[i]).toEqual(expectedRecent[i]);
        }
      }),
      { numRuns: 100 }
    );
  });
});
