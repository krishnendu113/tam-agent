/**
 * Skill Loader — SKILL.md-only discovery
 *
 * Discovers skills by scanning the skills/ directory for subdirectories
 * containing a SKILL.md file with YAML frontmatter. Ignores skill.json
 * and prompt.md files entirely.
 *
 * Public API:
 *   discoverSkills()                         → SkillManifest[]
 *   getSkillSummary(skillId)                 → SkillSummary | null
 *   getSkillReferences(skillId)              → ReferenceFileInfo[]
 *   loadReferenceFile(skillId, fileName)     → string
 *   getRegistryTriggers()                    → Map<string, string[]>
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';

const SKILLS_DIR = resolve(process.env.SKILLS_DIR || './skills');
const REGISTRY_FILE = join(SKILLS_DIR, 'registry.json');

/** @type {SkillManifest[] | null} */
let cachedManifests = null;

/** @type {Map<string, string[]> | null} */
let cachedTriggers = null;

// ─── YAML Frontmatter Parser ────────────────────────────────────────────────

/**
 * Parses YAML frontmatter from a SKILL.md file content string.
 * Returns null if frontmatter is missing or malformed.
 *
 * @param {string} content - Raw file content
 * @returns {{ name: string, description: string } | null}
 */
export function parseFrontmatter(content) {
  try {
    if (!content || typeof content !== 'string') return null;

    const trimmed = content.trimStart();
    if (!trimmed.startsWith('---')) return null;

    // Find the closing --- delimiter
    const secondDelimiterIdx = trimmed.indexOf('---', 3);
    if (secondDelimiterIdx === -1) return null;

    const yamlBlock = trimmed.slice(3, secondDelimiterIdx).trim();
    if (!yamlBlock) return null;

    // Parse simple key-value YAML (handles multi-line values with > or |)
    const fields = parseYamlKeyValues(yamlBlock);

    const name = fields.get('name');
    const description = fields.get('description');

    if (!name || !description) return null;

    return {
      name: name.trim(),
      description: description.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Lightweight YAML key-value parser.
 * Handles:
 *   - Simple `key: value`
 *   - Quoted values `key: "value"`
 *   - Multi-line folded scalars (`key: >` or `key: |`)
 *   - Multi-line plain values (continuation indented lines)
 *
 * @param {string} yaml
 * @returns {Map<string, string>}
 */
function parseYamlKeyValues(yaml) {
  const result = new Map();
  const lines = yaml.split('\n');
  let currentKey = null;
  let currentValue = '';
  let isMultiline = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a new key-value pair (starts with non-space at column 0)
    const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);

    if (keyMatch && !isMultiline) {
      // Save previous key if any
      if (currentKey !== null) {
        result.set(currentKey, cleanValue(currentValue));
      }

      currentKey = keyMatch[1];
      const rawValue = keyMatch[2].trim();

      // Check for multi-line indicators
      if (rawValue === '>' || rawValue === '|') {
        isMultiline = true;
        currentValue = '';
      } else {
        isMultiline = false;
        currentValue = rawValue;
      }
    } else if (currentKey !== null) {
      // Continuation line (indented or part of multi-line block)
      if (line.match(/^\s/) || line.trim() === '') {
        if (currentValue) {
          currentValue += ' ' + line.trim();
        } else {
          currentValue = line.trim();
        }
      } else if (isMultiline) {
        // Non-indented line in multiline mode — new key starts
        isMultiline = false;
        // Re-check as a new key
        const newKeyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
        if (newKeyMatch) {
          result.set(currentKey, cleanValue(currentValue));
          currentKey = newKeyMatch[1];
          const rawValue = newKeyMatch[2].trim();
          if (rawValue === '>' || rawValue === '|') {
            isMultiline = true;
            currentValue = '';
          } else {
            currentValue = rawValue;
          }
        }
      }
    }
  }

  // Save last key
  if (currentKey !== null) {
    result.set(currentKey, cleanValue(currentValue));
  }

  return result;
}

/**
 * Removes surrounding quotes from a YAML value string.
 * @param {string} value
 * @returns {string}
 */
function cleanValue(value) {
  let v = value.trim();
  // Remove surrounding double quotes
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
  }
  // Remove surrounding single quotes
  if (v.startsWith("'") && v.endsWith("'")) {
    v = v.slice(1, -1);
  }
  // Collapse multiple spaces to single space
  return v.replace(/\s+/g, ' ').trim();
}

// ─── Skill Discovery ────────────────────────────────────────────────────────

/**
 * Discovers all skills by scanning subdirectories of skills/ for SKILL.md files.
 * Caches results at startup (invalidated on restart).
 *
 * @returns {SkillManifest[]}
 */
export function discoverSkills() {
  if (cachedManifests !== null) {
    return cachedManifests;
  }

  const manifests = [];

  if (!existsSync(SKILLS_DIR)) {
    console.warn(`[skillLoader] Skills directory not found: ${SKILLS_DIR}`);
    cachedManifests = manifests;
    return manifests;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const registry = loadRegistry();
  const triggersMap = buildTriggersMap(registry);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirName = entry.name;
    const skillDir = join(SKILLS_DIR, dirName);
    const skillMdPath = join(skillDir, 'SKILL.md');

    if (!existsSync(skillMdPath)) {
      console.warn(`[skillLoader] Skipping "${dirName}": no SKILL.md found`);
      continue;
    }

    let content;
    try {
      content = readFileSync(skillMdPath, 'utf-8');
    } catch (err) {
      console.warn(`[skillLoader] Skipping "${dirName}": failed to read SKILL.md — ${err.message}`);
      continue;
    }

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      console.warn(`[skillLoader] Skipping "${dirName}": malformed or missing YAML frontmatter in SKILL.md`);
      continue;
    }

    // Look up registry entry for this skill directory
    const registryEntry = registry
      ? registry.skills.find(s => s.folder === dirName || s.id === dirName)
      : null;

    const manifest = {
      id: dirName,
      name: frontmatter.name,
      description: frontmatter.description,
      path: resolve(skillDir),
      triggers: triggersMap.get(dirName) || (registryEntry ? registryEntry.triggers || [] : []),
      alwaysLoad: registryEntry ? (registryEntry.alwaysLoad || false) : false,
      referenceFiles: discoverReferenceFiles(skillDir),
    };

    manifests.push(manifest);
  }

  cachedManifests = manifests;
  return manifests;
}

// ─── Skill Summary ──────────────────────────────────────────────────────────

/**
 * Returns only the frontmatter description + first heading block of a skill's SKILL.md.
 * Does NOT include full body content.
 *
 * @param {string} skillId - The skill directory name
 * @returns {{ id: string, name: string, description: string, referenceFiles: string[] } | null}
 */
export function getSkillSummary(skillId) {
  const manifests = discoverSkills();
  const manifest = manifests.find(m => m.id === skillId);
  if (!manifest) return null;

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    referenceFiles: manifest.referenceFiles.map(rf => rf.fileName),
  };
}

// ─── Reference Files ────────────────────────────────────────────────────────

/**
 * Returns the list of reference files for a given skill.
 *
 * @param {string} skillId
 * @returns {ReferenceFileInfo[]}
 */
export function getSkillReferences(skillId) {
  const manifests = discoverSkills();
  const manifest = manifests.find(m => m.id === skillId);
  if (!manifest) return [];

  return manifest.referenceFiles;
}

/**
 * Loads the content of a reference file for a given skill.
 * Includes path traversal prevention.
 *
 * @param {string} skillId
 * @param {string} fileName
 * @returns {string}
 * @throws {Error} If skillId is invalid, file not found, or path traversal detected
 */
export function loadReferenceFile(skillId, fileName) {
  const manifests = discoverSkills();
  const manifest = manifests.find(m => m.id === skillId);
  if (!manifest) {
    throw new Error(`Skill "${skillId}" not found`);
  }

  // Path traversal prevention
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('Invalid fileName');
  }

  // Reject any path containing .. segments
  if (fileName.includes('..')) {
    throw new Error(`Path traversal detected: "${fileName}" contains ".." segments`);
  }

  // Reject absolute paths
  if (fileName.startsWith('/') || fileName.startsWith('\\')) {
    throw new Error(`Path traversal detected: "${fileName}" is an absolute path`);
  }

  // Reject encoded traversal attempts
  if (fileName.includes('%2e') || fileName.includes('%2E') || fileName.includes('%2f') || fileName.includes('%2F')) {
    throw new Error(`Path traversal detected: "${fileName}" contains encoded sequences`);
  }

  // Reject null bytes
  if (fileName.includes('\0')) {
    throw new Error(`Path traversal detected: "${fileName}" contains null bytes`);
  }

  const skillDir = manifest.path;
  const resolvedPath = resolve(skillDir, fileName);

  // Verify the resolved path starts with the skill directory prefix
  if (!resolvedPath.startsWith(skillDir + '/') && resolvedPath !== skillDir) {
    throw new Error(`Path traversal detected: resolved path "${resolvedPath}" is outside skill directory "${skillDir}"`);
  }

  if (!existsSync(resolvedPath)) {
    const available = manifest.referenceFiles.map(rf => rf.fileName).join(', ');
    throw new Error(`File "${fileName}" not found in skill "${skillId}". Available files: ${available}`);
  }

  return readFileSync(resolvedPath, 'utf-8');
}

// ─── Registry Triggers ──────────────────────────────────────────────────────

/**
 * Returns a Map of skillId → trigger keywords, merged from registry.json.
 * Cached at startup.
 *
 * @returns {Map<string, string[]>}
 */
export function getRegistryTriggers() {
  if (cachedTriggers !== null) {
    return cachedTriggers;
  }

  const registry = loadRegistry();
  cachedTriggers = buildTriggersMap(registry);
  return cachedTriggers;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Loads and parses the registry.json file.
 * @returns {{ skills: Array<{ id: string, folder: string, triggers?: string[], alwaysLoad?: boolean }> } | null}
 */
function loadRegistry() {
  if (!existsSync(REGISTRY_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(REGISTRY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`[skillLoader] Failed to parse registry.json: ${err.message}`);
    return null;
  }
}

/**
 * Builds a Map of skill folder name → trigger keywords from registry data.
 * Maps by both folder name and skill id for lookup flexibility.
 *
 * @param {{ skills: Array<{ id: string, folder: string, triggers?: string[] }> } | null} registry
 * @returns {Map<string, string[]>}
 */
function buildTriggersMap(registry) {
  const map = new Map();
  if (!registry || !registry.skills) return map;

  for (const entry of registry.skills) {
    const triggers = entry.triggers || [];
    // Map by folder name (used as directory name)
    if (entry.folder) {
      map.set(entry.folder, triggers);
    }
    // Also map by id if different from folder
    if (entry.id && entry.id !== entry.folder) {
      map.set(entry.id, triggers);
    }
  }

  return map;
}

/**
 * Discovers reference files within a skill directory.
 * Looks for .md files (excluding SKILL.md) in the skill root and in references/ subdirectory.
 *
 * @param {string} skillDir - Absolute path to skill directory
 * @returns {ReferenceFileInfo[]}
 */
function discoverReferenceFiles(skillDir) {
  const refs = [];

  // Scan top-level .md files (exclude SKILL.md)
  try {
    const entries = readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        refs.push({
          fileName: entry.name,
          relativePath: entry.name,
        });
      }
    }
  } catch {
    // skip if unreadable
  }

  // Scan references/ subdirectory
  const refsDir = join(skillDir, 'references');
  if (existsSync(refsDir)) {
    try {
      const refEntries = readdirSync(refsDir, { withFileTypes: true });
      for (const entry of refEntries) {
        if (entry.isFile()) {
          refs.push({
            fileName: entry.name,
            relativePath: `references/${entry.name}`,
          });
        }
      }
    } catch {
      // skip if unreadable
    }
  }

  return refs;
}

/**
 * Clears the cached manifests and triggers (useful for testing).
 */
export function clearCache() {
  cachedManifests = null;
  cachedTriggers = null;
}

// ─── Backward Compatibility ─────────────────────────────────────────────────

/**
 * @deprecated Use discoverSkills() + filter instead.
 * Loads specific skills by their IDs (backward-compatible with old API).
 *
 * @param {string[]} skillIds
 * @returns {SkillManifest[]}
 */
export function loadSkillsById(skillIds) {
  if (!skillIds || skillIds.length === 0) return [];
  const allSkills = discoverSkills();
  return allSkills.filter(skill => skillIds.includes(skill.id));
}

/**
 * @deprecated Use discoverSkills() instead.
 * Loads all available skills (backward-compatible with old API).
 *
 * @returns {SkillManifest[]}
 */
export function loadAllSkills() {
  return discoverSkills();
}

/**
 * @deprecated Use getSkillSummary() instead.
 * Gets the system prompt extension for a skill.
 *
 * @param {{ id: string, path: string, description?: string }} skill
 * @returns {string}
 */
export function getSkillPrompt(skill) {
  const summary = getSkillSummary(skill.id);
  return summary ? summary.description : (skill.description || '');
}

export default {
  discoverSkills,
  getSkillSummary,
  getSkillReferences,
  loadReferenceFile,
  getRegistryTriggers,
  parseFrontmatter,
  clearCache,
  // Backward-compatible exports
  loadSkillsById,
  loadAllSkills,
  getSkillPrompt,
};
