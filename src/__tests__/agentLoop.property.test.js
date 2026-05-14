import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

// Mock the skillLoader module
vi.mock('../skillLoader.js', () => ({
  loadSkillsById: vi.fn(() => []),
}));

import { createMessage } from '../llm.js';
import { loadSkillsById } from '../skillLoader.js';
import {
  runAgentLoop,
  preflightNode,
  loadSkillsNode,
  skillRouterNode,
  parsePreflightResponse,
  validatePreflightResult,
  FAIL_OPEN_RESULT,
} from '../agentLoop.js';

// --- Generators ---

/**
 * Generates a random valid agent state.
 */
function arbAgentState() {
  return fc.record({
    conversationId: fc.string({ minLength: 1, maxLength: 30 }),
    messages: fc.array(
      fc.record({
        role: fc.constantFrom('user', 'assistant'),
        content: fc.string({ minLength: 1, maxLength: 100 }),
      }),
      { minLength: 1, maxLength: 5 }
    ),
    systemPrompt: fc.string({ minLength: 1, maxLength: 200 }),
    problemText: fc.string({ minLength: 1, maxLength: 200 }),
  });
}

/**
 * Generates a random valid preflight result.
 */
function arbPreflightResult() {
  return fc.record({
    onTopic: fc.boolean(),
    intent: fc.string({ minLength: 1, maxLength: 100 }),
    toolTags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
    skillIds: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
  });
}

/**
 * Helper: creates a mock callbacks object that records phase invocations.
 */
function createMockCallbacks() {
  const phases = [];
  return {
    phases,
    callbacks: {
      onPhase: vi.fn((phase) => phases.push(phase)),
      onToken: vi.fn(),
      onStatus: vi.fn(),
      onToolStatus: vi.fn(),
      onSkillActive: vi.fn(),
      onPlanUpdate: vi.fn(),
      onDocumentReady: vi.fn(),
      onError: vi.fn(),
      onComplete: vi.fn(),
    },
  };
}

/**
 * Helper: creates a mock LLM response for preflight classification.
 */
function makeLlmResponse(preflightResult) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(preflightResult) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 50, output_tokens: 30 },
  };
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 8: Agent Loop Execution Order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 4.2
   */
  it('For any on-topic state, nodes execute in order: Preflight → Skill Loading → Skill Router → path', async () => {
    await fc.assert(
      fc.asyncProperty(arbAgentState(), arbPreflightResult(), async (state, preflightResult) => {
        // Reset mocks between iterations
        createMessage.mockReset();
        loadSkillsById.mockReset();

        // Force on-topic
        const onTopicResult = { ...preflightResult, onTopic: true };

        createMessage.mockResolvedValue(makeLlmResponse(onTopicResult));
        loadSkillsById.mockReturnValue([]);

        const { phases, callbacks } = createMockCallbacks();

        await runAgentLoop(state, callbacks);

        // Verify phase order: preflight → skill_loading → (multi_node or research) → synthesis
        expect(phases[0]).toBe('preflight');
        expect(phases[1]).toBe('skill_loading');
        // After skill_loading, either multi_node or research is invoked
        expect(['multi_node', 'research']).toContain(phases[2]);
        expect(phases[3]).toBe('synthesis');
        // Verify total phases
        expect(phases.length).toBe(4);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 9: Off-Topic Early Termination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 4.3, 5.3
   */
  it('For any off-topic state, refusal is invoked and research/synthesis are NOT invoked', async () => {
    await fc.assert(
      fc.asyncProperty(arbAgentState(), arbPreflightResult(), async (state, preflightResult) => {
        // Reset mocks between iterations
        createMessage.mockReset();

        // Force off-topic
        const offTopicResult = { ...preflightResult, onTopic: false };

        createMessage.mockResolvedValue(makeLlmResponse(offTopicResult));

        const { phases, callbacks } = createMockCallbacks();

        await runAgentLoop(state, callbacks);

        // Only preflight and refusal phases should be invoked
        expect(phases).toContain('preflight');
        expect(phases).toContain('refusal');
        // Research, multi_node, and synthesis should NOT be invoked
        expect(phases).not.toContain('research');
        expect(phases).not.toContain('multi_node');
        expect(phases).not.toContain('synthesis');
        expect(phases).not.toContain('skill_loading');
        // Exactly 2 phases
        expect(phases.length).toBe(2);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 10: Skill Router Correctness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 4.4, 4.5
   */
  it('executionMode "multi-node" triggers multi-node path; "research" triggers Research_Dispatcher', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAgentState(),
        arbPreflightResult(),
        fc.boolean(),
        async (state, preflightResult, hasSkills) => {
          // Reset mocks between iterations
          createMessage.mockReset();
          loadSkillsById.mockReset();

          // Force on-topic and control skillIds based on hasSkills
          // When hasSkills is true, ensure skillIds is non-empty so loadSkillsById is called
          const onTopicResult = {
            ...preflightResult,
            onTopic: true,
            skillIds: hasSkills ? ['troubleshooting'] : [],
          };

          createMessage.mockResolvedValue(makeLlmResponse(onTopicResult));

          // When hasSkills is true, loadSkillsById returns skills → multi-node
          // When hasSkills is false, loadSkillsById returns empty → research
          if (hasSkills) {
            loadSkillsById.mockReturnValue([{ id: 'troubleshooting', name: 'Troubleshooting' }]);
          } else {
            loadSkillsById.mockReturnValue([]);
          }

          const { phases, callbacks } = createMockCallbacks();

          await runAgentLoop(state, callbacks);

          if (hasSkills) {
            // multi-node path should be invoked
            expect(phases).toContain('multi_node');
            expect(phases).not.toContain('research');
          } else {
            // research path should be invoked
            expect(phases).toContain('research');
            expect(phases).not.toContain('multi_node');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 15: Preflight Output Structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 5.2
   */
  it('Parsed result always contains onTopic (boolean), intent (string), toolTags (array), skillIds (array)', () => {
    fc.assert(
      fc.property(arbPreflightResult(), (preflightResult) => {
        // Simulate an LLM response containing the preflight result as JSON
        const response = {
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify(preflightResult) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
        };

        const parsed = parsePreflightResponse(response);

        // The parsed result must always have the correct structure
        expect(parsed).not.toBeNull();
        expect(typeof parsed.onTopic).toBe('boolean');
        expect(typeof parsed.intent).toBe('string');
        expect(Array.isArray(parsed.toolTags)).toBe(true);
        expect(Array.isArray(parsed.skillIds)).toBe(true);

        // Verify values match input (since arbPreflightResult generates valid data)
        expect(parsed.onTopic).toBe(preflightResult.onTopic);
        expect(parsed.intent).toBe(preflightResult.intent);
        expect(parsed.toolTags).toEqual(preflightResult.toolTags);
        expect(parsed.skillIds).toEqual(preflightResult.skillIds);
      }),
      { numRuns: 100 }
    );
  });

  it('validatePreflightResult always produces correct structure for any object with boolean onTopic', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.anything(),
        fc.anything(),
        fc.anything(),
        (onTopic, intent, toolTags, skillIds) => {
          const input = { onTopic, intent, toolTags, skillIds };
          const result = validatePreflightResult(input);

          // Since onTopic is always a boolean, result should never be null
          expect(result).not.toBeNull();
          expect(typeof result.onTopic).toBe('boolean');
          expect(typeof result.intent).toBe('string');
          expect(Array.isArray(result.toolTags)).toBe(true);
          expect(Array.isArray(result.skillIds)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
