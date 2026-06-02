import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock the skillLoader module
vi.mock('../skillLoader.js', () => ({
  getSkillSummary: vi.fn(() => null),
  getRegistryTriggers: vi.fn(() => new Map()),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

// Mock new modules added by skill-system-enhancement
vi.mock('../compaction.js', () => ({
  shouldCompact: vi.fn(() => false),
  compactHistory: vi.fn(),
  buildCompactedContext: vi.fn(),
  estimateTokenCount: vi.fn(() => 0),
}));

vi.mock('../tracing.js', () => ({
  createTrace: vi.fn(() => ({})),
  startSpan: vi.fn(() => ({})),
  endSpan: vi.fn(),
  flushTracing: vi.fn(async () => {}),
}));

vi.mock('../logger.js', () => ({
  logLLMCall: vi.fn(),
  logRequestComplete: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../clientTag.js', () => ({
  extractClientTag: vi.fn(() => null),
}));

vi.mock('../planManager.js', () => ({
  listSessionPlans: vi.fn(() => []),
}));

import { createMessage, streamMessage } from '../llm.js';
import { getSkillSummary } from '../skillLoader.js';
import { runAgentLoop } from '../agentLoop.js';

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
 * Generates a random error message string.
 */
function arbErrorMessage() {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-:.!'.split('')
    ),
    { minLength: 5, maxLength: 80 }
  );
}

/**
 * Helper: creates a mock callbacks object that records phase invocations and errors.
 */
function createMockCallbacks() {
  const phases = [];
  const errors = [];
  return {
    phases,
    errors,
    callbacks: {
      onPhase: vi.fn((phase) => phases.push(phase)),
      onToken: vi.fn(),
      onStatus: vi.fn(),
      onToolStatus: vi.fn(),
      onSkillActive: vi.fn(),
      onPlanUpdate: vi.fn(),
      onDocumentReady: vi.fn(),
      onError: vi.fn((err) => errors.push(err)),
      onComplete: vi.fn(),
    },
  };
}

/**
 * Helper: creates a mock LLM response for preflight classification (on-topic).
 */
function makeOnTopicLlmResponse() {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify({
      onTopic: true,
      intent: 'technical support',
      toolTags: ['jira'],
      skillIds: [],
    }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 50, output_tokens: 30 },
  };
}

/**
 * Helper: creates a mock async iterable stream that yields a complete response.
 */
function createMockStream(finalText) {
  return (async function* () {
    yield { type: 'text', text: finalText };
    yield {
      type: 'message_complete',
      response: {
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };
  })();
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 17: Phase Transition Callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 8.2
   *
   * For any complete Agent_Loop execution, callbacks.onPhase SHALL be invoked
   * at each major phase transition (preflight, skill_loading, research|multi_node, synthesis)
   * with the correct phase name.
   */
  it('For any complete execution, onPhase is invoked at each major phase transition with correct phase name', async () => {
    await fc.assert(
      fc.asyncProperty(arbAgentState(), async (state) => {
        // Reset mocks between iterations
        createMessage.mockReset();
        getSkillSummary.mockReset();
        streamMessage.mockReset();

        // Mock preflight to return on-topic classification
        createMessage.mockResolvedValue(makeOnTopicLlmResponse());

        // Mock getSkillSummary to return empty (research path)
        getSkillSummary.mockReturnValue(null);

        // Mock streamMessage to return a valid stream for synthesis
        streamMessage.mockReturnValue(createMockStream('Test response'));

        const { phases, callbacks } = createMockCallbacks();

        await runAgentLoop(state, callbacks);

        // Verify onPhase was called with the expected phases in order
        expect(phases.length).toBe(4);
        expect(phases[0]).toBe('preflight');
        expect(phases[1]).toBe('skill_loading');
        expect(phases[2]).toBe('research');
        expect(phases[3]).toBe('synthesis');
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 8.2
   *
   * For any complete execution with skills loaded (multi-node path),
   * onPhase is invoked with 'multi_node' instead of 'research'.
   */
  it('For any complete execution with skills, onPhase includes multi_node phase', async () => {
    await fc.assert(
      fc.asyncProperty(arbAgentState(), async (state) => {
        // Reset mocks between iterations
        createMessage.mockReset();
        getSkillSummary.mockReset();
        streamMessage.mockReset();

        // Mock preflight to return on-topic with skillIds
        createMessage.mockResolvedValue({
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({
            onTopic: true,
            intent: 'troubleshooting',
            toolTags: [],
            skillIds: ['troubleshooting'],
          }) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 30 },
        });

        // Mock getSkillSummary to return a skill (triggers multi-node path)
        getSkillSummary.mockImplementation((id) => id === 'troubleshooting' ? { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps', referenceFiles: [] } : null);

        // Mock streamMessage for synthesis
        streamMessage.mockReturnValue(createMockStream('Skill response'));

        const { phases, callbacks } = createMockCallbacks();

        await runAgentLoop(state, callbacks);

        // Verify phase order with multi_node path
        expect(phases.length).toBe(4);
        expect(phases[0]).toBe('preflight');
        expect(phases[1]).toBe('skill_loading');
        expect(phases[2]).toBe('multi_node');
        expect(phases[3]).toBe('synthesis');
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 18: Unrecoverable Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 8.4
   *
   * For any unrecoverable error during Agent_Loop execution, callbacks.onError
   * SHALL be invoked with error details and execution SHALL terminate gracefully
   * (no further node execution).
   */
  it('For any unrecoverable error, onError is invoked and no further nodes execute', async () => {
    await fc.assert(
      fc.asyncProperty(arbAgentState(), arbErrorMessage(), async (state, errorMsg) => {
        // Reset mocks between iterations
        createMessage.mockReset();
        getSkillSummary.mockReset();
        streamMessage.mockReset();

        // Mock preflight to return on-topic with skillIds so getSkillSummary is called
        createMessage.mockResolvedValue({
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({
            onTopic: true,
            intent: 'technical support',
            toolTags: ['jira'],
            skillIds: ['troubleshooting'],
          }) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 30 },
        });

        // Make getSkillSummary throw an unrecoverable error
        // This happens AFTER preflight, so it will be caught by runAgentLoop's try/catch
        getSkillSummary.mockImplementation(() => {
          throw new Error(errorMsg);
        });

        const { phases, errors, callbacks } = createMockCallbacks();

        const result = await runAgentLoop(state, callbacks);

        // onError should be called exactly once
        expect(callbacks.onError).toHaveBeenCalledTimes(1);
        expect(errors.length).toBe(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect(errors[0].message).toBe(errorMsg);

        // No further phases should execute after the error
        // Only 'preflight' and 'skill_loading' should have been called
        // (skill_loading is called before getSkillSummary throws inside loadSkillsNode)
        expect(phases).toContain('preflight');
        expect(phases).toContain('skill_loading');
        // research, multi_node, and synthesis should NOT be invoked
        expect(phases).not.toContain('research');
        expect(phases).not.toContain('multi_node');
        expect(phases).not.toContain('synthesis');

        // Execution should terminate gracefully (return state, not throw)
        expect(result).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 8.4
   *
   * For any error during synthesis, onError is invoked exactly once
   * and execution terminates gracefully.
   */
  it('For any error during synthesis, onError is invoked exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(arbAgentState(), arbErrorMessage(), async (state, errorMsg) => {
        // Reset mocks between iterations
        createMessage.mockReset();
        getSkillSummary.mockReset();
        streamMessage.mockReset();

        // Mock preflight to return on-topic
        createMessage.mockResolvedValue(makeOnTopicLlmResponse());

        // Mock getSkillSummary to return empty (research path)
        getSkillSummary.mockReturnValue(null);

        // Make streamMessage throw an error during synthesis
        streamMessage.mockImplementation(() => {
          throw new Error(errorMsg);
        });

        const { phases, errors, callbacks } = createMockCallbacks();

        const result = await runAgentLoop(state, callbacks);

        // onError should be called exactly once
        expect(callbacks.onError).toHaveBeenCalledTimes(1);
        expect(errors.length).toBe(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect(errors[0].message).toBe(errorMsg);

        // Execution should terminate gracefully (return state, not throw)
        expect(result).toBeDefined();

        // onComplete should NOT be called (error terminated execution)
        expect(callbacks.onComplete).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });
});
