/**
 * Property-based tests for src/skillLoader.js — SKILL.md parsing round-trip
 *
 * Property 1: SKILL.md Parsing Round-Trip Produces Normalized Objects
 *
 * **Validates: Requirements 1.1, 1.4**
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

describe('Feature: skill-system-enhancement, Property 1: SKILL.md Parsing Round-Trip Produces Normalized Objects', () => {
  let parseFrontmatter;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../skillLoader.js');
    parseFrontmatter = mod.parseFrontmatter;
    mod.clearCache();
  });

  // --- Generators ---

  /**
   * Generates a non-empty alphanumeric name suitable for YAML frontmatter.
   * Avoids characters that would break YAML parsing:
   * - No `---` sequences (would be interpreted as frontmatter delimiter)
   * - No colons or newlines
   */
  function arbSkillName() {
    return fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9 _-]{0,49}$/)
      .filter(s => s.trim().length > 0 && !s.includes('---'));
  }

  /**
   * Generates a non-empty description string.
   * Avoids leading/trailing quotes, newlines, and `---` sequences
   * to keep it as a simple single-line YAML value.
   */
  function arbDescription() {
    return fc
      .stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9 ,.!?;:()\-_]{0,199}$/)
      .filter(s => s.trim().length > 0 && !s.includes('---'));
  }

  /**
   * Generates arbitrary body content for the SKILL.md after frontmatter.
   */
  function arbBodyContent() {
    return fc.oneof(
      fc.constant(''),
      fc.constant('\n# Heading\n\nSome body text.'),
      fc.stringMatching(/^[a-zA-Z0-9 \n.,!?#\-_]{0,200}$/)
    );
  }

  /**
   * Builds a valid SKILL.md content string from name, description, and body.
   */
  function buildSkillMd(name, description, body) {
    return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 1.1, 1.4**
   *
   * For any valid SKILL.md with YAML frontmatter containing name and description,
   * parsing SHALL produce a normalized skill object with name and description as
   * non-empty strings.
   */
  it('parseFrontmatter produces non-null result with non-empty name and description for valid frontmatter', () => {
    fc.assert(
      fc.property(
        arbSkillName(),
        arbDescription(),
        arbBodyContent(),
        (name, description, body) => {
          const content = buildSkillMd(name, description, body);
          const result = parseFrontmatter(content);

          // SHALL produce a non-null result
          expect(result).not.toBeNull();

          // name SHALL be a non-empty string
          expect(typeof result.name).toBe('string');
          expect(result.name.length).toBeGreaterThan(0);

          // description SHALL be a non-empty string
          expect(typeof result.description).toBe('string');
          expect(result.description.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.1, 1.4**
   *
   * The parsed name and description SHALL match the input values
   * (after normalization of whitespace).
   */
  it('parsed name and description match the input values after normalization', () => {
    fc.assert(
      fc.property(
        arbSkillName(),
        arbDescription(),
        arbBodyContent(),
        (name, description, body) => {
          const content = buildSkillMd(name, description, body);
          const result = parseFrontmatter(content);

          expect(result).not.toBeNull();

          // The parsed name should match the input (trimmed and whitespace-normalized)
          const expectedName = name.replace(/\s+/g, ' ').trim();
          expect(result.name).toBe(expectedName);

          // The parsed description should match the input (trimmed and whitespace-normalized)
          const expectedDescription = description.replace(/\s+/g, ' ').trim();
          expect(result.description).toBe(expectedDescription);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.1, 1.4**
   *
   * For quoted YAML values, parsing SHALL still produce correct non-empty strings.
   */
  it('parseFrontmatter handles double-quoted name and description values', () => {
    fc.assert(
      fc.property(
        arbSkillName(),
        arbDescription(),
        (name, description) => {
          // Use double-quoted YAML values
          const content = `---\nname: "${name}"\ndescription: "${description}"\n---\n# Heading`;
          const result = parseFrontmatter(content);

          expect(result).not.toBeNull();
          expect(typeof result.name).toBe('string');
          expect(result.name.length).toBeGreaterThan(0);
          expect(typeof result.description).toBe('string');
          expect(result.description.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
