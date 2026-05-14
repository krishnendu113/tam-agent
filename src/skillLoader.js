// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Skill loader module - loads and manages skill definitions from the skills/ directory.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = process.env.SKILLS_DIR || './skills';

/**
 * Loads all available skill definitions from the skills directory.
 * @returns {Array} Array of skill definitions
 */
export function loadAllSkills() {
  if (!existsSync(SKILLS_DIR)) {
    return [];
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = join(SKILLS_DIR, entry.name, 'skill.json');
      if (existsSync(skillPath)) {
        try {
          const skillDef = JSON.parse(readFileSync(skillPath, 'utf-8'));
          skills.push({ ...skillDef, id: entry.name, path: join(SKILLS_DIR, entry.name) });
        } catch (err) {
          console.warn(`Failed to load skill ${entry.name}:`, err.message);
        }
      }
    }
  }

  return skills;
}

/**
 * Loads specific skills by their IDs.
 * @param {Array<string>} skillIds - Array of skill IDs to load
 * @returns {Array} Array of loaded skill definitions
 */
export function loadSkillsById(skillIds) {
  if (!skillIds || skillIds.length === 0) return [];

  const allSkills = loadAllSkills();
  return allSkills.filter(skill => skillIds.includes(skill.id));
}

/**
 * Gets the system prompt extension for a skill.
 * @param {object} skill - Skill definition
 * @returns {string} System prompt content for the skill
 */
export function getSkillPrompt(skill) {
  const promptPath = join(skill.path, 'prompt.md');
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, 'utf-8');
  }
  return skill.description || '';
}

export default { loadAllSkills, loadSkillsById, getSkillPrompt };
