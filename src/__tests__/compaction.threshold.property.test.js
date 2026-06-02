import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { shouldCompact, estimateTokenCount, MAX_CONTEXT_TOKENS } from '../compaction.js';

// --- Generators ---

/**
 * Generates a random message with content of varying length.
 */
function arbMessage() {
  return fc.record({
    role: fc.constantFrom('user', 'assistant'),
    content: fc.string({ minLength: 1, maxLength: 2000 }),
  });
}

/**
 * Generates arrays of messages with random content lengths.
 */
function arbMessages() {
  return fc.array(arbMessage(), { minLength: 1, maxLength: 30 });
}

/**
 * Generates arbitrary threshold values (1-100) representing percentage.
 */
function arbThreshold() {
  return fc.integer({ min: 1, max: 100 });
}

// --- Property Tests ---

describe('Property 11: Compaction Threshold Trigger Condition', () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * shouldCompact SHALL return true if and only if the estimated token count
   * exceeds (threshold/100) * MAX_CONTEXT_TOKENS.
   */
  it('shouldCompact returns true iff estimateTokenCount(messages) > (threshold/100) * MAX_CONTEXT_TOKENS', () => {
    fc.assert(
      fc.property(arbMessages(), arbThreshold(), (messages, threshold) => {
        const tokenCount = estimateTokenCount(messages);
        const maxAllowed = (threshold / 100) * MAX_CONTEXT_TOKENS;
        const expected = tokenCount > maxAllowed;
        const actual = shouldCompact(messages, threshold);

        expect(actual).toBe(expected);
      }),
      { numRuns: 500 }
    );
  });

  /**
   * **Validates: Requirements 8.1**
   *
   * shouldCompact SHALL be a pure deterministic function — same inputs always produce
   * the same output.
   */
  it('shouldCompact is deterministic: same inputs always produce the same output', () => {
    fc.assert(
      fc.property(arbMessages(), arbThreshold(), (messages, threshold) => {
        const result1 = shouldCompact(messages, threshold);
        const result2 = shouldCompact(messages, threshold);
        const result3 = shouldCompact(messages, threshold);

        expect(result1).toBe(result2);
        expect(result2).toBe(result3);
      }),
      { numRuns: 200 }
    );
  });
});
