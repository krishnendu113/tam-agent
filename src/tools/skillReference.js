// Skill reference tools - load and list reference files from skills on demand.

import { loadReferenceFile, getSkillReferences, getSkillSummary } from '../skillLoader.js';

/**
 * Tool: load_skill_reference
 *
 * Loads the full content of a reference file from a skill directory.
 * Includes path traversal prevention via the skillLoader module.
 */
export const loadSkillReferenceTool = {
  name: 'load_skill_reference',
  description: 'Load the full content of a reference file from an active skill. Use when you need detailed guidance from a skill\'s reference materials.',
  tags: ['skill'],
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: "The skill ID (e.g., 'brd', 'excalidraw-diagram')"
      },
      fileName: {
        type: 'string',
        description: "The reference file name (e.g., 'color-palette.md', 'guardrails.md')"
      }
    },
    required: ['skillId', 'fileName']
  },
  async handler(input) {
    const { skillId, fileName } = input;

    if (!skillId || typeof skillId !== 'string') {
      return { error: 'skillId is required and must be a string.' };
    }

    if (!fileName || typeof fileName !== 'string') {
      return { error: 'fileName is required and must be a string.' };
    }

    try {
      const content = loadReferenceFile(skillId, fileName);
      return { skillId, fileName, content };
    } catch (err) {
      // loadReferenceFile throws on path traversal, skill not found, or file not found
      return { error: err.message };
    }
  }
};

/**
 * Tool: list_skill_references
 *
 * Lists available reference files for a given skill.
 */
export const listSkillReferencesTool = {
  name: 'list_skill_references',
  description: 'List available reference files for a skill. Use to discover what detailed guidance is available before loading specific files.',
  tags: ['skill'],
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The skill ID'
      }
    },
    required: ['skillId']
  },
  async handler(input) {
    const { skillId } = input;

    if (!skillId || typeof skillId !== 'string') {
      return { error: 'skillId is required and must be a string.' };
    }

    // Check if skill exists
    const summary = getSkillSummary(skillId);
    if (!summary) {
      return { error: `Skill "${skillId}" not found.` };
    }

    const references = getSkillReferences(skillId);
    const files = references.map(ref => ({
      fileName: ref.fileName,
      relativePath: ref.relativePath
    }));

    return {
      skillId,
      skillName: summary.name,
      referenceFiles: files
    };
  }
};

export default { loadSkillReferenceTool, listSkillReferencesTool };
