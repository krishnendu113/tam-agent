import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the skillLoader module to provide controllable getRegistryTriggers
vi.mock('../skillLoader.js', () => ({
  getSkillSummary: vi.fn(() => null),
  getRegistryTriggers: vi.fn(() => new Map()),
}));

// Mock the llm module (required by agentLoop.js import)
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock the tools/index module (required by agentLoop.js import)
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

// Mock the callbacks module (required by agentLoop.js import)
vi.mock('../callbacks.js', () => ({
  validateCallbacks: vi.fn((cb) => cb),
}));

import { getRegistryTriggers } from '../skillLoader.js';
import { matchTriggerSkills } from '../agentLoop.js';

// --- Generators ---

/**
 * Generates a valid skill ID (alphanumeric with hyphens, non-empty).
 */
function arbSkillId() {
  return fc.stringOf(
    fc.constantFrom(
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-'
    ),
    { minLength: 2, maxLength: 15 }
  );
}

/**
 * Generates a trigger keyword (lowercase word-like string, at least 3 chars to avoid false substring matches).
 */
function arbTriggerKeyword() {
  return fc.stringOf(
    fc.constantFrom(
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'
    ),
    { minLength: 3, maxLength: 12 }
  );
}

/**
 * Generates a trigger map: Map<string, string[]> with 1-5 skills, each having 1-4 triggers.
 */
function arbTriggerMap() {
  return fc.array(
    fc.tuple(
      arbSkillId(),
      fc.array(arbTriggerKeyword(), { minLength: 1, maxLength: 4 })
    ),
    { minLength: 1, maxLength: 5 }
  ).map(entries => new Map(entries));
}

/**
 * Given a trigger map, generates a query string that contains at least one trigger keyword
 * from at least one skill. Returns { query, expectedSkillIds } where expectedSkillIds
 * is the set of all skill IDs whose triggers appear in the query.
 */
function arbQueryWithTriggers(triggerMap) {
  const entries = [...triggerMap.entries()];
  if (entries.length === 0) {
    return fc.constant({ query: 'no triggers', expectedSkillIds: [] });
  }

  // Pick a random non-empty subset of skills to include triggers from
  return fc.subarray(entries, { minLength: 1 }).chain(selectedEntries => {
    // For each selected skill, pick one trigger keyword to include in the query
    const triggerSelections = selectedEntries.map(([skillId, triggers]) =>
      fc.constantFrom(...triggers).map(trigger => ({ skillId, trigger }))
    );

    return fc.tuple(...triggerSelections).chain(selections => {
      // Build query that includes the selected triggers with some surrounding text
      return fc.array(fc.constantFrom(' please ', ' help with ', ' I need ', ' about ', ' '), {
        minLength: selections.length,
        maxLength: selections.length,
      }).map(separators => {
        const queryParts = selections.map((sel, i) => (separators[i] || ' ') + sel.trigger);
        const query = queryParts.join(' ');

        // Compute expected: ALL skills whose triggers overlap with the query (case-insensitive)
        const lowerQuery = query.toLowerCase();
        const expectedSkillIds = entries
          .filter(([, triggers]) =>
            triggers.some(t => lowerQuery.includes(t.toLowerCase()))
          )
          .map(([id]) => id);

        return { query, expectedSkillIds: [...new Set(expectedSkillIds)] };
      });
    });
  });
}

// --- Property Tests ---

describe('Feature: skill-system-enhancement, Property 10: Skill Registry Trigger Matching Returns All Matches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   *
   * For any query containing trigger keywords, preflight SHALL include every skill ID
   * whose triggers overlap with query text. No matching skill shall be omitted.
   */
  it('matchTriggerSkills returns every skill ID whose triggers overlap with query text (case-insensitive)', () => {
    fc.assert(
      fc.property(
        arbTriggerMap().chain(triggerMap =>
          arbQueryWithTriggers(triggerMap).map(queryData => ({
            triggerMap,
            ...queryData,
          }))
        ),
        ({ triggerMap, query, expectedSkillIds }) => {
          // Configure mock to return the generated trigger map
          getRegistryTriggers.mockReturnValue(triggerMap);

          // Execute matchTriggerSkills
          const result = matchTriggerSkills(query);

          // Property: every expected skill ID must be present in the result
          for (const expectedId of expectedSkillIds) {
            expect(result).toContain(expectedId);
          }

          // Property: result should not contain skill IDs that don't match
          const lowerQuery = query.toLowerCase();
          for (const returnedId of result) {
            const triggers = triggerMap.get(returnedId);
            expect(triggers).toBeDefined();
            const hasMatch = triggers.some(t => lowerQuery.includes(t.toLowerCase()));
            expect(hasMatch).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   *
   * Case-insensitive matching: query with mixed case still matches all trigger keywords.
   */
  it('matchTriggerSkills is case-insensitive — mixed case queries still match all triggers', () => {
    fc.assert(
      fc.property(
        arbTriggerMap(),
        fc.constantFrom('upper', 'lower', 'mixed'),
        (triggerMap, caseType) => {
          // Pick one skill entry to build a query from
          const entries = [...triggerMap.entries()];
          if (entries.length === 0) return;

          const [skillId, triggers] = entries[0];
          if (triggers.length === 0) return;

          const trigger = triggers[0];

          // Transform the trigger based on case type
          let queryTrigger;
          if (caseType === 'upper') {
            queryTrigger = trigger.toUpperCase();
          } else if (caseType === 'lower') {
            queryTrigger = trigger.toLowerCase();
          } else {
            // mixed: alternate upper/lower
            queryTrigger = trigger
              .split('')
              .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
              .join('');
          }

          const query = `I need help with ${queryTrigger} please`;

          // Configure mock
          getRegistryTriggers.mockReturnValue(triggerMap);

          const result = matchTriggerSkills(query);

          // The skill with the matching trigger must be in results
          expect(result).toContain(skillId);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 6.2, 6.3**
   *
   * When multiple skills have triggers that overlap with the query,
   * ALL matching skill IDs must be included.
   */
  it('matchTriggerSkills includes ALL matching skill IDs when multiple skills match', () => {
    fc.assert(
      fc.property(
        fc.array(arbSkillId(), { minLength: 2, maxLength: 5 }),
        (skillIds) => {
          // Deduplicate skill IDs
          const uniqueIds = [...new Set(skillIds)];
          if (uniqueIds.length < 2) return;

          // Use a shared trigger keyword so all skills match
          const sharedTrigger = 'sharedkeyword';

          // Build trigger map where every skill has the shared trigger
          const triggerMap = new Map(
            uniqueIds.map(id => [id, [sharedTrigger, id + 'specific']])
          );

          const query = `Please help with ${sharedTrigger} task`;

          // Configure mock
          getRegistryTriggers.mockReturnValue(triggerMap);

          const result = matchTriggerSkills(query);

          // All skills must be in the result since they all share the trigger
          for (const id of uniqueIds) {
            expect(result).toContain(id);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 6.1**
   *
   * When the query does not contain any trigger keywords, no skill IDs should be returned.
   */
  it('matchTriggerSkills returns empty array when query contains no trigger keywords', () => {
    fc.assert(
      fc.property(
        arbTriggerMap(),
        (triggerMap) => {
          // Build a query guaranteed not to contain any trigger keywords
          // Use a string that has no alphabetic characters from any trigger
          const query = '12345 67890 !!!';

          // Verify none of the triggers appear in this query
          const lowerQuery = query.toLowerCase();
          const allTriggers = [...triggerMap.values()].flat();
          const noOverlap = allTriggers.every(t => !lowerQuery.includes(t.toLowerCase()));

          if (!noOverlap) return; // Skip if accidentally overlaps (unlikely with numeric query)

          // Configure mock
          getRegistryTriggers.mockReturnValue(triggerMap);

          const result = matchTriggerSkills(query);

          expect(result).toEqual([]);
        }
      ),
      { numRuns: 200 }
    );
  });
});
