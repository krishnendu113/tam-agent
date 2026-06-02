/**
 * Unit tests for src/skillLoader.js — SKILL.md-only discovery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, resolve } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

// We test the parseFrontmatter function directly, and then integration
// with real skills directory.

describe('skillLoader', () => {
  let skillLoader;

  beforeEach(async () => {
    // Fresh import to reset module state
    vi.resetModules();
    skillLoader = await import('../skillLoader.js');
    skillLoader.clearCache();
  });

  describe('parseFrontmatter', () => {
    it('parses valid YAML frontmatter with simple values', () => {
      const content = `---
name: my-skill
description: "A test skill description"
---

# My Skill

Body content here.`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).toEqual({
        name: 'my-skill',
        description: 'A test skill description',
      });
    });

    it('parses YAML frontmatter with multi-line description using >', () => {
      const content = `---
name: pm-pipeline
description: >
  PM Pipeline · Full 3-phase delivery skill for Capillary PSV projects.
  Triggers: "create BRD", "run discovery", "generate Jira".
---

# PM Pipeline`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).not.toBeNull();
      expect(result.name).toBe('pm-pipeline');
      expect(result.description).toContain('PM Pipeline');
      expect(result.description).toContain('3-phase delivery');
    });

    it('returns null for content without frontmatter', () => {
      const content = `# Just a heading

Some content without frontmatter.`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).toBeNull();
    });

    it('returns null for content with missing closing delimiter', () => {
      const content = `---
name: broken
description: "No closing delimiter"

# Heading`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).toBeNull();
    });

    it('returns null for null input', () => {
      expect(skillLoader.parseFrontmatter(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(skillLoader.parseFrontmatter('')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(skillLoader.parseFrontmatter(123)).toBeNull();
      expect(skillLoader.parseFrontmatter({})).toBeNull();
    });

    it('returns null when name field is missing', () => {
      const content = `---
description: "Only description"
---

# Heading`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).toBeNull();
    });

    it('returns null when description field is missing', () => {
      const content = `---
name: only-name
---

# Heading`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).toBeNull();
    });

    it('handles single-quoted values', () => {
      const content = `---
name: 'quoted-skill'
description: 'A skill with single quotes'
---

# Heading`;

      const result = skillLoader.parseFrontmatter(content);
      expect(result).toEqual({
        name: 'quoted-skill',
        description: 'A skill with single quotes',
      });
    });
  });

  describe('discoverSkills (integration with real skills directory)', () => {
    it('discovers skills from the actual skills/ directory', () => {
      const skills = skillLoader.discoverSkills();
      expect(Array.isArray(skills)).toBe(true);

      // We know brd, capillary-sdd-writer, excalidraw-diagram, solution-gap-analyzer
      // have valid YAML frontmatter
      const ids = skills.map(s => s.id);
      expect(ids).toContain('brd');
      expect(ids).toContain('capillary-sdd-writer');
      expect(ids).toContain('excalidraw-diagram');
      expect(ids).toContain('solution-gap-analyzer');
    });

    it('returns normalized SkillManifest objects', () => {
      const skills = skillLoader.discoverSkills();
      const brd = skills.find(s => s.id === 'brd');

      expect(brd).toBeDefined();
      expect(brd.id).toBe('brd');
      expect(brd.name).toBeTruthy();
      expect(brd.description).toBeTruthy();
      expect(brd.path).toBeTruthy();
      expect(brd.path).toMatch(/\/skills\/brd$/);
      expect(brd.triggers).toBeInstanceOf(Array);
      expect(brd.referenceFiles).toBeInstanceOf(Array);
    });

    it('includes reference files in the manifest', () => {
      const skills = skillLoader.discoverSkills();
      const brd = skills.find(s => s.id === 'brd');

      expect(brd.referenceFiles.length).toBeGreaterThan(0);
      const fileNames = brd.referenceFiles.map(rf => rf.fileName);
      expect(fileNames).toContain('guardrails.md');
    });

    it('caches results after first call', () => {
      const first = skillLoader.discoverSkills();
      const second = skillLoader.discoverSkills();
      expect(first).toBe(second); // Same reference — cached
    });

    it('skips cr-evaluator (no YAML frontmatter)', () => {
      const skills = skillLoader.discoverSkills();
      const cr = skills.find(s => s.id === 'cr-evaluator');
      // cr-evaluator SKILL.md doesn't have YAML frontmatter, should be skipped
      expect(cr).toBeUndefined();
    });
  });

  describe('getSkillSummary', () => {
    it('returns summary for a valid skill', () => {
      const summary = skillLoader.getSkillSummary('brd');
      expect(summary).not.toBeNull();
      expect(summary.id).toBe('brd');
      expect(summary.name).toBeTruthy();
      expect(summary.description).toBeTruthy();
      expect(summary.referenceFiles).toBeInstanceOf(Array);
    });

    it('returns null for unknown skill', () => {
      const summary = skillLoader.getSkillSummary('nonexistent-skill');
      expect(summary).toBeNull();
    });

    it('referenceFiles contains file names only (not full paths)', () => {
      const summary = skillLoader.getSkillSummary('excalidraw-diagram');
      if (summary) {
        for (const file of summary.referenceFiles) {
          expect(file).not.toContain('/');
          expect(file).not.toContain('\\');
        }
      }
    });
  });

  describe('getSkillReferences', () => {
    it('returns reference files for a valid skill', () => {
      const refs = skillLoader.getSkillReferences('brd');
      expect(refs.length).toBeGreaterThan(0);
      // Each ref should have fileName and relativePath
      for (const ref of refs) {
        expect(ref.fileName).toBeTruthy();
        expect(ref.relativePath).toBeTruthy();
      }
    });

    it('returns empty array for unknown skill', () => {
      const refs = skillLoader.getSkillReferences('nonexistent');
      expect(refs).toEqual([]);
    });

    it('includes files from references/ subdirectory', () => {
      const refs = skillLoader.getSkillReferences('excalidraw-diagram');
      const refPaths = refs.map(r => r.relativePath);
      expect(refPaths.some(p => p.startsWith('references/'))).toBe(true);
    });
  });

  describe('loadReferenceFile', () => {
    it('loads a valid reference file', () => {
      const content = skillLoader.loadReferenceFile('brd', 'references/guardrails.md');
      expect(content).toBeTruthy();
      expect(typeof content).toBe('string');
    });

    it('throws for unknown skill', () => {
      expect(() => skillLoader.loadReferenceFile('nonexistent', 'file.md'))
        .toThrow(/not found/);
    });

    it('throws for path traversal with ..', () => {
      expect(() => skillLoader.loadReferenceFile('brd', '../server.js'))
        .toThrow(/traversal/i);
    });

    it('throws for absolute paths', () => {
      expect(() => skillLoader.loadReferenceFile('brd', '/etc/passwd'))
        .toThrow(/traversal/i);
    });

    it('throws for encoded traversal', () => {
      expect(() => skillLoader.loadReferenceFile('brd', '%2e%2e/server.js'))
        .toThrow(/traversal/i);
    });

    it('throws for null bytes', () => {
      expect(() => skillLoader.loadReferenceFile('brd', 'file\0.md'))
        .toThrow(/traversal/i);
    });

    it('throws with available files list when file not found', () => {
      expect(() => skillLoader.loadReferenceFile('brd', 'nonexistent.md'))
        .toThrow(/Available files/);
    });
  });

  describe('getRegistryTriggers', () => {
    it('returns a Map of triggers', () => {
      const triggers = skillLoader.getRegistryTriggers();
      expect(triggers).toBeInstanceOf(Map);
      expect(triggers.size).toBeGreaterThan(0);
    });

    it('includes triggers for brd folder', () => {
      const triggers = skillLoader.getRegistryTriggers();
      const brdTriggers = triggers.get('brd');
      expect(brdTriggers).toBeInstanceOf(Array);
      expect(brdTriggers.length).toBeGreaterThan(0);
      expect(brdTriggers).toContain('brd');
    });

    it('includes triggers for excalidraw-diagram', () => {
      const triggers = skillLoader.getRegistryTriggers();
      const exTriggers = triggers.get('excalidraw-diagram');
      expect(exTriggers).toBeInstanceOf(Array);
      expect(exTriggers).toContain('diagram');
    });
  });
});
