/**
 * Property-based tests for reference file content round-trip
 *
 * Property 5: Reference File Content Round-Trip
 *
 * For any file written to a skill's reference directory, invoking
 * load_skill_reference SHALL return content byte-for-byte identical
 * to what was written.
 *
 * **Validates: Requirements 3.2**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const SKILLS_DIR = resolve('./skills');

describe('Feature: skill-system-enhancement, Property 5: Reference File Content Round-Trip', () => {
  let loadReferenceFile;
  let clearCache;

  const tempFiles = [];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../skillLoader.js');
    loadReferenceFile = mod.loadReferenceFile;
    clearCache = mod.clearCache;
    clearCache();
  });

  afterEach(() => {
    // Clean up any temp files created during tests
    for (const filePath of tempFiles) {
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch {
        // ignore cleanup errors
      }
    }
    tempFiles.length = 0;
  });

  // --- Generators ---

  /**
   * Generates arbitrary text content for reference files.
   * Includes printable ASCII, unicode, whitespace variants, and multi-line content.
   */
  function arbFileContent() {
    return fc.oneof(
      // Simple alphanumeric content
      fc.string({ minLength: 1, maxLength: 500 }),
      // Multi-line markdown-like content
      fc.array(fc.string({ minLength: 0, maxLength: 100 }), { minLength: 1, maxLength: 20 })
        .map(lines => lines.join('\n')),
      // Content with special characters (tabs, multiple newlines)
      fc.string({ minLength: 1, maxLength: 300 })
        .map(s => s + '\n\n\t\t' + s),
      // Unicode content
      fc.unicodeString({ minLength: 1, maxLength: 200 })
    );
  }

  /**
   * Generates a valid filename for a reference file (no path separators or traversal).
   */
  function arbFileName() {
    return fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/)
      .filter(s => s.length > 0)
      .map(s => `_proptest_${s}.md`);
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 3.2**
   *
   * For any existing reference file in the brd skill's references directory,
   * loadReferenceFile SHALL return content byte-for-byte identical to what
   * exists on disk.
   */
  it('loadReferenceFile returns content identical to file on disk for existing reference files', () => {
    // Use the real brd/references/guardrails.md file which is known to exist
    const skillId = 'brd';
    const fileName = 'references/guardrails.md';
    const filePath = join(SKILLS_DIR, 'brd', 'references', 'guardrails.md');

    // Read file directly from disk
    const expectedContent = readFileSync(filePath, 'utf-8');

    // Load via loadReferenceFile
    const actualContent = loadReferenceFile(skillId, fileName);

    // Content SHALL be byte-for-byte identical
    expect(actualContent).toBe(expectedContent);
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * For any arbitrary text content written to the brd skill's references directory,
   * invoking loadReferenceFile SHALL return content byte-for-byte identical
   * to what was written.
   */
  it('loadReferenceFile returns byte-for-byte identical content for any written reference file', () => {
    const refsDir = join(SKILLS_DIR, 'brd', 'references');

    fc.assert(
      fc.property(
        arbFileContent(),
        arbFileName(),
        (content, fileName) => {
          const filePath = join(refsDir, fileName);

          // Write arbitrary content to a temp reference file
          writeFileSync(filePath, content, 'utf-8');
          tempFiles.push(filePath);

          // Clear cache so the new file is discovered
          clearCache();

          // Load via loadReferenceFile
          const loaded = loadReferenceFile('brd', `references/${fileName}`);

          // Content SHALL be byte-for-byte identical to what was written
          expect(loaded).toBe(content);

          // Clean up immediately to avoid accumulation
          unlinkSync(filePath);
          tempFiles.splice(tempFiles.indexOf(filePath), 1);
          clearCache();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * For all existing reference files across all skills, loadReferenceFile
   * SHALL return content identical to what fs.readFileSync returns.
   */
  it('loadReferenceFile matches fs.readFileSync for all existing reference files in brd skill', () => {
    // Use known reference files in brd skill
    const knownFiles = [
      'references/guardrails.md',
      'references/customer-journey.md',
      'references/pm-journey.md',
      'references/product-knowledge.md',
      'references/raid-library.md',
      'references/stakeholder-journey.md',
    ];

    for (const relPath of knownFiles) {
      const diskPath = join(SKILLS_DIR, 'brd', relPath);
      if (!existsSync(diskPath)) continue;

      const diskContent = readFileSync(diskPath, 'utf-8');
      const loadedContent = loadReferenceFile('brd', relPath);

      expect(loadedContent).toBe(diskContent);
    }
  });
});
