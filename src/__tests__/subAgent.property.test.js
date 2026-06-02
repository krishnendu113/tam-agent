import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { clampTurns } from '../tools/subAgent.js';

// --- Generators ---

/**
 * Generates arbitrary integers including negatives, zero, and very large values.
 */
function arbMaxTurns() {
  return fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })
  );
}

/**
 * Generates integers strictly in the valid range [1, 10].
 */
function arbValidRange() {
  return fc.integer({ min: 1, max: 10 });
}

/**
 * Generates truthy integers below the valid lower bound (negative values).
 */
function arbBelowRange() {
  return fc.integer({ min: -10000, max: -1 });
}

/**
 * Generates integers above the valid upper bound.
 */
function arbAboveRange() {
  return fc.integer({ min: 11, max: 10000 });
}

// --- Property Tests ---

describe('Property 9: Sub-Agent Turn Limit Clamping', () => {
  /**
   * **Validates: Requirements 5.4**
   *
   * For any maxTurns integer value, the effective turn limit SHALL be
   * Math.min(Math.max(maxTurns || 5, 1), 10) — clamped to the range [1, 10],
   * with falsy values (0, null, undefined) defaulting to 5.
   */
  it('For any integer maxTurns, clampTurns produces Math.min(Math.max(maxTurns || 5, 1), 10)', () => {
    fc.assert(
      fc.property(arbMaxTurns(), (maxTurns) => {
        const result = clampTurns(maxTurns);
        const expected = Math.min(Math.max(maxTurns || 5, 1), 10);
        expect(result).toBe(expected);
      }),
      { numRuns: 500 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * The clamped result SHALL always be within [1, 10] regardless of input.
   */
  it('For any integer input, result is always in [1, 10]', () => {
    fc.assert(
      fc.property(arbMaxTurns(), (maxTurns) => {
        const result = clampTurns(maxTurns);
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(10);
      }),
      { numRuns: 500 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * Values within [1, 10] SHALL pass through unchanged.
   */
  it('For any value in [1, 10], clampTurns returns the value unchanged', () => {
    fc.assert(
      fc.property(arbValidRange(), (maxTurns) => {
        const result = clampTurns(maxTurns);
        expect(result).toBe(maxTurns);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * Negative values SHALL be clamped to 1.
   */
  it('For any negative integer, clampTurns returns 1', () => {
    fc.assert(
      fc.property(arbBelowRange(), (maxTurns) => {
        const result = clampTurns(maxTurns);
        expect(result).toBe(1);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * Values above 10 SHALL be clamped to 10.
   */
  it('For any integer > 10, clampTurns returns 10', () => {
    fc.assert(
      fc.property(arbAboveRange(), (maxTurns) => {
        const result = clampTurns(maxTurns);
        expect(result).toBe(10);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * Falsy values (0, null, undefined) use default of 5 before clamping.
   */
  it('For falsy values (0, null, undefined), clampTurns returns 5', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, null, undefined),
        (maxTurns) => {
          const result = clampTurns(maxTurns);
          expect(result).toBe(5);
        }
      ),
      { numRuns: 50 }
    );
  });
});
