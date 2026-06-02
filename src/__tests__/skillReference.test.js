/**
 * Unit tests for src/tools/skillReference.js — load_skill_reference and list_skill_references tools
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadSkillReferenceTool, listSkillReferencesTool } from '../tools/skillReference.js';
import { clearCache } from '../skillLoader.js';

describe('skillReference tools', () => {
  beforeEach(() => {
    clearCache();
  });

  describe('loadSkillReferenceTool', () => {
    it('has correct tool metadata', () => {
      expect(loadSkillReferenceTool.name).toBe('load_skill_reference');
      expect(loadSkillReferenceTool.tags).toEqual(['skill']);
      expect(loadSkillReferenceTool.inputSchema.required).toContain('skillId');
      expect(loadSkillReferenceTool.inputSchema.required).toContain('fileName');
    });

    it('loads a valid reference file', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: 'references/guardrails.md'
      });

      expect(result.error).toBeUndefined();
      expect(result.skillId).toBe('brd');
      expect(result.fileName).toBe('references/guardrails.md');
      expect(result.content).toBeTruthy();
      expect(typeof result.content).toBe('string');
    });

    it('returns error for unknown skill', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'nonexistent-skill',
        fileName: 'file.md'
      });

      expect(result.error).toMatch(/not found/);
    });

    it('returns error with available files when file not found', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: 'nonexistent.md'
      });

      expect(result.error).toMatch(/not found/i);
      expect(result.error).toMatch(/Available files/);
    });

    it('returns error for path traversal with ..', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: '../server.js'
      });

      expect(result.error).toMatch(/traversal/i);
    });

    it('returns error for absolute paths', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: '/etc/passwd'
      });

      expect(result.error).toMatch(/traversal/i);
    });

    it('returns error for encoded traversal', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: '%2e%2e/server.js'
      });

      expect(result.error).toMatch(/traversal/i);
    });

    it('returns error for null bytes', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: 'file\0.md'
      });

      expect(result.error).toMatch(/traversal/i);
    });

    it('returns error when skillId is empty', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: '',
        fileName: 'file.md'
      });

      expect(result.error).toBeTruthy();
    });

    it('returns error when fileName is empty', async () => {
      const result = await loadSkillReferenceTool.handler({
        skillId: 'brd',
        fileName: ''
      });

      expect(result.error).toBeTruthy();
    });
  });

  describe('listSkillReferencesTool', () => {
    it('has correct tool metadata', () => {
      expect(listSkillReferencesTool.name).toBe('list_skill_references');
      expect(listSkillReferencesTool.tags).toEqual(['skill']);
      expect(listSkillReferencesTool.inputSchema.required).toContain('skillId');
    });

    it('lists reference files for a valid skill', async () => {
      const result = await listSkillReferencesTool.handler({
        skillId: 'brd'
      });

      expect(result.error).toBeUndefined();
      expect(result.skillId).toBe('brd');
      expect(result.skillName).toBeTruthy();
      expect(result.referenceFiles).toBeInstanceOf(Array);
      expect(result.referenceFiles.length).toBeGreaterThan(0);

      // Each entry should have fileName and relativePath
      for (const file of result.referenceFiles) {
        expect(file.fileName).toBeTruthy();
        expect(file.relativePath).toBeTruthy();
      }
    });

    it('includes files from references/ subdirectory', async () => {
      const result = await listSkillReferencesTool.handler({
        skillId: 'brd'
      });

      const refPaths = result.referenceFiles.map(f => f.relativePath);
      expect(refPaths.some(p => p.startsWith('references/'))).toBe(true);
    });

    it('returns error for unknown skill', async () => {
      const result = await listSkillReferencesTool.handler({
        skillId: 'nonexistent-skill'
      });

      expect(result.error).toMatch(/not found/i);
    });

    it('returns error when skillId is empty', async () => {
      const result = await listSkillReferencesTool.handler({
        skillId: ''
      });

      expect(result.error).toBeTruthy();
    });

    it('returns error when skillId is not a string', async () => {
      const result = await listSkillReferencesTool.handler({
        skillId: 123
      });

      expect(result.error).toBeTruthy();
    });
  });
});
