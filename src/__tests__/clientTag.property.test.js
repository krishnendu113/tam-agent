import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractClientTag } from '../clientTag.js';

// --- Generators ---

/**
 * Generates a valid Jira project key: starts with [A-Z], followed by one or more [A-Z0-9].
 * Minimum 2 characters total.
 */
function arbProjectKey() {
  return fc
    .tuple(
      fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
      fc.stringOf(
        fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
        { minLength: 1, maxLength: 8 }
      )
    )
    .map(([first, rest]) => `${first}${rest}`);
}

/**
 * Generates a valid Jira ticket number (one or more digits, no leading constraint).
 */
function arbTicketNumber() {
  return fc.integer({ min: 1, max: 99999 }).map(String);
}

/**
 * Generates a full Jira ticket reference: PROJECT-123
 */
function arbJiraTicket() {
  return fc
    .tuple(arbProjectKey(), arbTicketNumber())
    .map(([key, num]) => `${key}-${num}`);
}

/**
 * Generates surrounding text that does NOT contain a Jira ticket pattern.
 * Uses only lowercase letters, digits, spaces, and basic punctuation.
 */
function arbSurroundingText() {
  return fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789.,;:!?()-'.split('')),
    { minLength: 0, maxLength: 50 }
  );
}

/**
 * Generates a string that definitively does NOT contain a Jira ticket pattern.
 * Avoids consecutive uppercase letters followed by digits after a dash.
 */
function arbNoJiraString() {
  return fc.oneof(
    // Pure lowercase strings
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), {
      minLength: 0,
      maxLength: 100,
    }),
    // Strings with numbers but no uppercase pattern
    fc.stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 .,!?'.split('')),
      { minLength: 0, maxLength: 100 }
    ),
    // Single uppercase letter (not enough for pattern which requires 2+ uppercase/digits before dash)
    fc.tuple(
      fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), {
        minLength: 1,
        maxLength: 50,
      })
    ).map(([upper, rest]) => `${upper}${rest}`),
    // Empty string
    fc.constant('')
  );
}

// --- Property Tests ---

describe('Property 21: Jira Project Key Extraction', () => {
  /**
   * **Validates: Requirements 11.9**
   *
   * For any string containing a Jira ticket reference matching [A-Z][A-Z0-9]+-\d+,
   * extraction SHALL return the project key portion.
   */
  it('For any string containing a valid Jira ticket, extractClientTag returns the project key portion', () => {
    fc.assert(
      fc.property(
        arbJiraTicket(),
        arbSurroundingText(),
        arbSurroundingText(),
        (ticket, prefix, suffix) => {
          const text = `${prefix}${ticket}${suffix}`;
          const result = extractClientTag(text);

          // Extract expected project key (everything before the last dash)
          const dashIndex = ticket.lastIndexOf('-');
          const expectedKey = ticket.substring(0, dashIndex);

          expect(result).toBe(expectedKey);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 11.9**
   *
   * For strings without any Jira ticket pattern, extraction SHALL return null.
   */
  it('For any string without a Jira ticket pattern, extractClientTag returns null', () => {
    fc.assert(
      fc.property(arbNoJiraString(), (text) => {
        const result = extractClientTag(text);
        expect(result).toBeNull();
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 11.9**
   *
   * For non-string inputs, extraction SHALL return null.
   */
  it('For any non-string input, extractClientTag returns null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.object(),
          fc.array(fc.anything())
        ),
        (input) => {
          const result = extractClientTag(input);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 11.9**
   *
   * The returned project key SHALL always match the pattern [A-Z][A-Z0-9]+ (2+ chars, starting uppercase).
   */
  it('Extracted project key always matches [A-Z][A-Z0-9]+ pattern', () => {
    fc.assert(
      fc.property(arbJiraTicket(), arbSurroundingText(), (ticket, surrounding) => {
        const text = `${surrounding}${ticket}`;
        const result = extractClientTag(text);

        expect(result).not.toBeNull();
        expect(result).toMatch(/^[A-Z][A-Z0-9]+$/);
      }),
      { numRuns: 200 }
    );
  });
});
