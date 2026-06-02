/**
 * Property 3: Skill Summary Loading Excludes Full Body Content
 *
 * For any SKILL.md with body longer than frontmatter + first heading,
 * loaded summary SHALL have character length strictly less than full file content.
 *
 * **Validates: Requirements 2.1, 2.2**
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { getSkillSummary, discoverSkills, parseFrontmatter, clearCache } from '../skillLoader.js';

const SKILLS_DIR = resolve(process.env.SKILLS_DIR || './skills');

// --- Generators ---

/**
 * Generates a valid YAML frontmatter name (non-empty alphanumeric + dashes).
 */
function arbSkillName() {
  return fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
      minLength: 3,
      maxLength: 30,
    })
    .filter((s) => /^[a-z]/.test(s) && !s.endsWith('-'));
}

/**
 * Generates a valid YAML frontmatter description (non-empty, no newlines in simple mode).
 */
function arbDescription() {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?()-'.split('')
    ),
    { minLength: 10, maxLength: 200 }
  );
}

/**
 * Generates body content that is longer than the frontmatter.
 * This simulates the "full body" portion of a SKILL.md file.
 */
function arbBodyContent() {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?()-\n#*[]|'.split(
          ''
        )
      ),
      { minLength: 200, maxLength: 2000 }
    )
    .map((body) => `\n# Main Heading\n\n${body}`);
}

/**
 * Generates a complete SKILL.md content string with YAML frontmatter + substantial body.
 */
function arbSkillMdWithBody() {
  return fc.tuple(arbSkillName(), arbDescription(), arbBodyContent()).map(([name, desc, body]) => {
    return `---\nname: ${name}\ndescription: "${desc}"\n---\n${body}`;
  });
}

// --- Property Tests ---

describe('Property 3: Skill Summary Loading Excludes Full Body Content', () => {
  beforeEach(() => {
    clearCache();
  });

  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For real SKILL.md files that have body content beyond frontmatter,
   * getSkillSummary returns data whose total character length is strictly
   * less than the full SKILL.md file content length.
   */
  it('For any real skill with body content, summary character length is strictly less than full file content', () => {
    const skills = discoverSkills();

    // Filter to skills whose SKILL.md has substantial body content
    const skillsWithBody = skills.filter((skill) => {
      const skillMdPath = join(skill.path, 'SKILL.md');
      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        // Check the file has content beyond frontmatter (after second ---)
        const trimmed = content.trimStart();
        const secondDelim = trimmed.indexOf('---', 3);
        if (secondDelim === -1) return false;
        const bodyAfterFrontmatter = trimmed.slice(secondDelim + 3).trim();
        return bodyAfterFrontmatter.length > 100; // Substantial body
      } catch {
        return false;
      }
    });

    // We need at least some skills with body content for this test to be meaningful
    expect(skillsWithBody.length).toBeGreaterThan(0);

    for (const skill of skillsWithBody) {
      const summary = getSkillSummary(skill.id);
      expect(summary).not.toBeNull();

      const skillMdPath = join(skill.path, 'SKILL.md');
      const fullContent = readFileSync(skillMdPath, 'utf-8');

      // The summary is: id + name + description + referenceFiles array
      // Serialize summary to measure its character footprint
      const summaryCharLength =
        summary.id.length +
        summary.name.length +
        summary.description.length +
        summary.referenceFiles.join('').length;

      expect(summaryCharLength).toBeLessThan(fullContent.length);
    }
  });

  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any generated SKILL.md content with body longer than frontmatter + first heading,
   * parseFrontmatter returns only the frontmatter fields, whose combined character length
   * is strictly less than the full file content.
   */
  it('For any SKILL.md with substantial body, parsed summary fields have fewer characters than full content', () => {
    fc.assert(
      fc.property(arbSkillMdWithBody(), (content) => {
        const parsed = parseFrontmatter(content);

        // parseFrontmatter should succeed for valid frontmatter
        expect(parsed).not.toBeNull();

        // The summary (name + description) should be strictly shorter than the full content
        const summaryLength = parsed.name.length + parsed.description.length;
        expect(summaryLength).toBeLessThan(content.length);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * The summary description SHALL NOT contain the body content that appears
   * after the frontmatter closing delimiter.
   */
  it('Summary description does not contain body content from after frontmatter', () => {
    fc.assert(
      fc.property(arbSkillMdWithBody(), (content) => {
        const parsed = parseFrontmatter(content);
        expect(parsed).not.toBeNull();

        // Extract body content (after second ---)
        const trimmed = content.trimStart();
        const secondDelim = trimmed.indexOf('---', 3);
        const bodyContent = trimmed.slice(secondDelim + 3).trim();

        // The parsed description should not contain any of the body's unique heading
        // (we always insert "# Main Heading" in our generator)
        expect(parsed.description).not.toContain('# Main Heading');

        // The body is longer than the summary fields combined
        expect(bodyContent.length).toBeGreaterThan(parsed.name.length + parsed.description.length);
      }),
      { numRuns: 200 }
    );
  });
});
