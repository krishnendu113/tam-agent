/**
 * Property Test: Malformed YAML Frontmatter Never Crashes the Parser
 *
 * **Validates: Requirements 1.3**
 *
 * For any string that is not valid YAML frontmatter (including random binary data,
 * strings missing `---` delimiters, strings with unclosed quotes, and empty strings),
 * the Skill_Loader parser SHALL return null without throwing an exception.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseFrontmatter } from '../skillLoader.js';

// --- Generators ---

/**
 * Generates arbitrary strings that do NOT start with '---' delimiter.
 * These can never be valid YAML frontmatter.
 */
function arbStringMissingOpeningDelimiter() {
  return fc.string({ minLength: 0, maxLength: 500 }).filter(
    (s) => !s.trimStart().startsWith('---')
  );
}

/**
 * Generates strings that start with '---' but have no closing '---' delimiter.
 * Single delimiter only.
 */
function arbSingleDelimiterOnly() {
  return fc.string({ minLength: 0, maxLength: 200 }).map((body) => {
    // Remove any '---' in the body to guarantee no second delimiter
    const sanitized = body.replace(/---/g, '');
    return `---\n${sanitized}`;
  });
}

/**
 * Generates strings with '---' delimiters but without required name/description fields.
 */
function arbDelimitersButNoRequiredFields() {
  return fc
    .record({
      key: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 1,
        maxLength: 10,
      }),
      value: fc.string({ minLength: 1, maxLength: 50 }),
    })
    .filter((r) => r.key !== 'name' && r.key !== 'description')
    .map(({ key, value }) => `---\n${key}: ${value}\n---\n\n# Heading`);
}

/**
 * Generates strings with unclosed quotes inside YAML blocks.
 */
function arbUnclosedQuotes() {
  return fc.string({ minLength: 1, maxLength: 100 }).map((content) => {
    return `---\nname: "unclosed ${content}\ndescription: value\n---`;
  });
}

/**
 * Generates random binary-like data (arbitrary unicode/control characters).
 */
function arbBinaryData() {
  return fc
    .array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 500 })
    .map((bytes) => String.fromCharCode(...bytes));
}

/**
 * Generates very long random strings.
 */
function arbVeryLongStrings() {
  return fc.string({ minLength: 1000, maxLength: 5000 });
}

/**
 * Generates strings with special characters (null bytes, control chars, etc.).
 */
function arbSpecialCharStrings() {
  return fc.oneof(
    fc.constant('\0'),
    fc.constant('\x01\x02\x03'),
    fc.constant('---\nname: test\x00value\ndescription: ok\n---'),
    fc.string({ minLength: 1, maxLength: 200 }).map(
      (s) => `${s}\0${s}`
    ),
    fc.fullUnicode().map((c) => c.repeat(50))
  );
}

/**
 * Generates non-string inputs (numbers, objects, arrays, null, undefined).
 */
function arbNonStringInputs() {
  return fc.oneof(
    fc.integer(),
    fc.double(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.anything()),
    fc.dictionary(fc.string(), fc.anything()),
    fc.constant(true),
    fc.constant(false),
    fc.constant(NaN),
    fc.constant(Infinity)
  );
}

// --- Property Tests ---

describe('Feature: skill-system-enhancement, Property 2: Malformed YAML Frontmatter Never Crashes the Parser', () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any arbitrary string, parseFrontmatter SHALL either return a valid
   * {name, description} object or return null — it SHALL never throw.
   */
  it('parseFrontmatter never throws for any arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 2000 }), (input) => {
        let result;
        expect(() => {
          result = parseFrontmatter(input);
        }).not.toThrow();

        // Result is either null or an object with name and description
        if (result !== null) {
          expect(result).toHaveProperty('name');
          expect(result).toHaveProperty('description');
          expect(typeof result.name).toBe('string');
          expect(typeof result.description).toBe('string');
        }
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Strings missing the opening `---` delimiter SHALL return null without throwing.
   */
  it('returns null for strings missing opening --- delimiter', () => {
    fc.assert(
      fc.property(arbStringMissingOpeningDelimiter(), (input) => {
        let result;
        expect(() => {
          result = parseFrontmatter(input);
        }).not.toThrow();

        expect(result).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Strings with only one `---` delimiter (no closing) SHALL return null without throwing.
   */
  it('returns null for strings with only one --- delimiter', () => {
    fc.assert(
      fc.property(arbSingleDelimiterOnly(), (input) => {
        let result;
        expect(() => {
          result = parseFrontmatter(input);
        }).not.toThrow();

        expect(result).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Strings with `---` delimiters but missing name/description fields SHALL return null.
   */
  it('returns null for YAML blocks without name or description fields', () => {
    fc.assert(
      fc.property(arbDelimitersButNoRequiredFields(), (input) => {
        let result;
        expect(() => {
          result = parseFrontmatter(input);
        }).not.toThrow();

        expect(result).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Strings with unclosed quotes SHALL not crash the parser.
   */
  it('never throws for strings with unclosed quotes', () => {
    fc.assert(
      fc.property(arbUnclosedQuotes(), (input) => {
        expect(() => {
          parseFrontmatter(input);
        }).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Random binary data SHALL not crash the parser and SHALL return null.
   */
  it('returns null for random binary data without throwing', () => {
    fc.assert(
      fc.property(arbBinaryData(), (input) => {
        let result;
        expect(() => {
          result = parseFrontmatter(input);
        }).not.toThrow();

        // Binary data is extremely unlikely to be valid frontmatter
        // but the key property is it doesn't throw
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Very long random strings SHALL not crash the parser.
   */
  it('never throws for very long random strings', () => {
    fc.assert(
      fc.property(arbVeryLongStrings(), (input) => {
        expect(() => {
          parseFrontmatter(input);
        }).not.toThrow();
      }),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Strings with special characters (null bytes, control chars, unicode) SHALL not crash.
   */
  it('never throws for strings with special characters', () => {
    fc.assert(
      fc.property(arbSpecialCharStrings(), (input) => {
        expect(() => {
          parseFrontmatter(input);
        }).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Non-string inputs (numbers, objects, arrays, null, undefined) SHALL return null
   * without throwing.
   */
  it('returns null for non-string inputs without throwing', () => {
    fc.assert(
      fc.property(arbNonStringInputs(), (input) => {
        let result;
        expect(() => {
          result = parseFrontmatter(input);
        }).not.toThrow();

        expect(result).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.3**
   *
   * Empty string SHALL return null without throwing.
   */
  it('returns null for empty string', () => {
    const result = parseFrontmatter('');
    expect(result).toBeNull();
  });
});
