import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

/**
 * **Validates: Requirements 8.5**
 *
 * Property 13: Compaction Does Not Mutate Original Messages
 *
 * Messages stored before compaction SHALL remain byte-for-byte identical after;
 * only new compactedHistory field is written.
 */

// Mock the llm.js module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { createMessage } from '../llm.js';
import { compactHistory } from '../compaction.js';

// --- Generators ---

/**
 * Generates a message with arbitrary role and content.
 */
function arbMessage() {
  return fc.record({
    role: fc.constantFrom('user', 'assistant'),
    content: fc.oneof(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.array(
        fc.record({
          type: fc.constant('text'),
          text: fc.string({ minLength: 1, maxLength: 100 }),
        }),
        { minLength: 1, maxLength: 3 }
      )
    ),
  });
}

/**
 * Generates arrays of messages (enough to trigger compaction logic).
 * Minimum length of 2 to ensure we have something to compact when preserveTurns < length.
 */
function arbMessages() {
  return fc.array(arbMessage(), { minLength: 2, maxLength: 15 });
}

/**
 * Generates preserveTurns values that are less than message array length
 * to ensure compaction actually processes some messages.
 */
function arbPreserveTurns() {
  return fc.integer({ min: 1, max: 10 });
}

// --- Property Tests ---

describe('Property 13: Compaction Does Not Mutate Original Messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock createMessage to return a summary response
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: 'Summary of earlier conversation.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    });
  });

  /**
   * **Validates: Requirements 8.5**
   *
   * For any message array, calling compactHistory SHALL NOT mutate the original
   * messages array or any of its elements. A deep copy made before the call
   * must be JSON-identical to the original after the call.
   */
  it('compactHistory does not mutate the original messages array', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessages(), arbPreserveTurns(), async (messages, preserveTurns) => {
        // Deep-copy the messages before calling compactHistory
        const originalSnapshot = JSON.stringify(messages);

        // Call compactHistory (may or may not actually compact depending on preserveTurns vs length)
        await compactHistory(messages, preserveTurns);

        // Verify the original messages array is still byte-for-byte identical to the snapshot
        const afterSnapshot = JSON.stringify(messages);
        expect(afterSnapshot).toBe(originalSnapshot);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 8.5**
   *
   * For any message array where compaction occurs (messages.length > preserveTurns),
   * the original messages array length SHALL remain unchanged after compaction.
   */
  it('compactHistory does not change original array length', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessages(), arbPreserveTurns(), async (messages, preserveTurns) => {
        // Only test cases where compaction actually happens
        fc.pre(messages.length > preserveTurns);

        const originalLength = messages.length;

        await compactHistory(messages, preserveTurns);

        expect(messages.length).toBe(originalLength);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 8.5**
   *
   * For any message array, individual message objects within the array SHALL NOT
   * have any properties added, removed, or modified after compaction.
   */
  it('compactHistory does not mutate individual message objects', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessages(), arbPreserveTurns(), async (messages, preserveTurns) => {
        // Deep-copy each individual message before calling compactHistory
        const messageCopies = messages.map(m => JSON.parse(JSON.stringify(m)));

        await compactHistory(messages, preserveTurns);

        // Each message at each index should be identical to its copy
        for (let i = 0; i < messages.length; i++) {
          expect(JSON.stringify(messages[i])).toBe(JSON.stringify(messageCopies[i]));
        }
      }),
      { numRuns: 100 }
    );
  });
});
