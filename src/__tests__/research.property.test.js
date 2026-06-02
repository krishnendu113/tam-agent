import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
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

import { createMessage } from '../llm.js';
import { getSkillSummary } from '../skillLoader.js';
import { executeTool, getToolDefinitions } from '../tools/index.js';
import {
  parallelResearchNode,
  sequentialResearchFallback,
  runAgentLoop,
} from '../agentLoop.js';

// --- Generators ---

/**
 * Known research domains that parallelResearchNode dispatches sub-agents for.
 */
const RESEARCH_DOMAINS = ['jira', 'confluence', 'docs', 'web'];

/**
 * Generates a random research domain result — either a success (with a random summary)
 * or a failure (throws an error).
 *
 * @returns {fc.Arbitrary<{ domain: string, success: boolean, summary?: string, error?: string }>}
 */
function arbDomainResult() {
  return fc.record({
    domain: fc.constantFrom(...RESEARCH_DOMAINS),
    success: fc.boolean(),
    summary: fc.string({ minLength: 1, maxLength: 100 }),
    error: fc.string({ minLength: 1, maxLength: 50 }),
  });
}

/**
 * Generates a random set of domain results where each domain either succeeds or fails.
 * For Property 11: at least one must fail (partial failure scenario).
 *
 * @returns {fc.Arbitrary<Array<{ domain: string, success: boolean, summary: string, error: string }>>}
 */
function arbResearchResultsPartialFailure() {
  // Generate a result for each domain, then ensure at least one fails and at least one succeeds
  return fc.tuple(
    fc.boolean(), // jira success
    fc.boolean(), // confluence success
    fc.boolean(), // docs success
    fc.boolean(), // web success
    fc.string({ minLength: 1, maxLength: 80 }), // summary for successes
    fc.string({ minLength: 1, maxLength: 50 }), // error message for failures
  ).filter(([jira, confluence, docs, web]) => {
    // At least one must fail AND at least one must succeed
    const results = [jira, confluence, docs, web];
    const hasFailure = results.some(r => !r);
    const hasSuccess = results.some(r => r);
    return hasFailure && hasSuccess;
  }).map(([jira, confluence, docs, web, summary, error]) => {
    return RESEARCH_DOMAINS.map((domain, i) => ({
      domain,
      success: [jira, confluence, docs, web][i],
      summary,
      error,
    }));
  });
}

/**
 * Generates a random set of domain results where ALL domains fail.
 * For Property 12: all sub-agents fail scenario.
 *
 * @returns {fc.Arbitrary<Array<{ domain: string, success: false, error: string }>>}
 */
function arbResearchResultsAllFail() {
  return fc.string({ minLength: 1, maxLength: 50 }).map(error => {
    return RESEARCH_DOMAINS.map(domain => ({
      domain,
      success: false,
      summary: '',
      error,
    }));
  });
}

/**
 * Generates a random subset of tool tags (1-4 domains).
 */
function arbToolTags() {
  return fc.subarray(RESEARCH_DOMAINS, { minLength: 1, maxLength: 4 });
}

/**
 * Helper: creates a mock callbacks object that records invocations.
 */
function createMockCallbacks() {
  return {
    onPhase: vi.fn(),
    onToken: vi.fn(),
    onStatus: vi.fn(),
    onToolStatus: vi.fn(),
    onSkillActive: vi.fn(),
    onPlanUpdate: vi.fn(),
    onDocumentReady: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
  };
}

/**
 * Helper: creates a base agent state for research tests.
 */
function createBaseState(toolTags) {
  return {
    conversationId: 'test-conv',
    messages: [{ role: 'user', content: 'Test query' }],
    systemPrompt: 'You are a TAM agent.',
    problemText: 'How do I fix the login issue?',
    toolTags,
  };
}

/**
 * Helper: configures createMessage mock based on domain success/failure map.
 * Uses the system prompt content to determine which domain is being called.
 */
function configureMockByDomainResults(domainResults) {
  createMessage.mockImplementation(async ({ system }) => {
    for (const result of domainResults) {
      if (system && system.includes(result.domain)) {
        if (result.success) {
          return {
            role: 'assistant',
            content: [{
              type: 'text',
              text: JSON.stringify({
                domain: result.domain,
                found: true,
                summary: result.summary,
                details: [],
              }),
            }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 20 },
          };
        } else {
          throw new Error(result.error);
        }
      }
    }
    // Fallback — should not be reached in normal operation
    return {
      role: 'assistant',
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
    };
  });
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 11: Research Fault Tolerance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 6.3, 6.4, 6.5
   *
   * For any set of dispatched research sub-agents where at least one fails or times out,
   * the Research_Dispatcher SHALL still collect results from all successful sub-agents
   * and SHALL invoke callbacks.onStatus upon completion.
   */
  it('when at least one sub-agent fails, results from successful sub-agents are still collected and onStatus is invoked', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbResearchResultsPartialFailure(),
        async (domainResults) => {
          // Reset mocks between iterations
          createMessage.mockReset();

          // Configure mock to succeed/fail based on generated domain results
          configureMockByDomainResults(domainResults);

          const state = createBaseState(RESEARCH_DOMAINS);
          const callbacks = createMockCallbacks();

          const result = await parallelResearchNode(state, callbacks);

          // Count expected successes and failures
          const expectedSuccesses = domainResults.filter(r => r.success).length;
          const expectedFailures = domainResults.filter(r => !r.success).length;

          // Results from successful sub-agents are collected
          expect(result.researchContext).toBeDefined();
          expect(result.researchContext.results).toHaveLength(expectedSuccesses);
          expect(result.researchContext.successCount).toBe(expectedSuccesses);

          // Failures are recorded
          expect(result.researchContext.failures).toHaveLength(expectedFailures);
          expect(result.researchContext.failureCount).toBe(expectedFailures);

          // Since at least one succeeded, fallbackToSequential should be false
          expect(result.fallbackToSequential).toBe(false);

          // callbacks.onStatus is invoked upon completion
          expect(callbacks.onStatus).toHaveBeenCalled();
          const statusMessage = callbacks.onStatus.mock.calls[0][0];
          expect(statusMessage).toContain(`${expectedSuccesses}/${RESEARCH_DOMAINS.length} sub-agents succeeded`);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 12: Parallel Research Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 4.6
   *
   * For any scenario where parallel research returns insufficient results (all sub-agents fail),
   * the Agent_Loop SHALL fall back to sequential research mode.
   */
  it('when all sub-agents fail, state.fallbackToSequential is set to true', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbResearchResultsAllFail(),
        arbToolTags(),
        async (domainResults, toolTags) => {
          // Reset mocks between iterations
          createMessage.mockReset();

          // Configure mock so all domains fail
          configureMockByDomainResults(domainResults);

          const state = createBaseState(toolTags);
          const callbacks = createMockCallbacks();

          const result = await parallelResearchNode(state, callbacks);

          // All sub-agents failed — fallbackToSequential must be true
          expect(result.fallbackToSequential).toBe(true);

          // No successful results
          expect(result.researchContext.results).toHaveLength(0);
          expect(result.researchContext.successCount).toBe(0);

          // Failures recorded for each dispatched domain
          expect(result.researchContext.failures.length).toBe(toolTags.length);
          expect(result.researchContext.failureCount).toBe(toolTags.length);

          // callbacks.onStatus is invoked with fallback message
          expect(callbacks.onStatus).toHaveBeenCalled();
          const statusMessage = callbacks.onStatus.mock.calls[0][0];
          expect(statusMessage).toContain('falling back to sequential mode');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('when all sub-agents fail in parallel, runAgentLoop invokes sequentialResearchFallback', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbResearchResultsAllFail(),
        async (domainResults) => {
          // Reset mocks between iterations
          createMessage.mockReset();
          getSkillSummary.mockReset();
          getSkillSummary.mockReturnValue(null);

          let callIndex = 0;

          createMessage.mockImplementation(async ({ system }) => {
            callIndex++;
            if (callIndex === 1) {
              // First call is the preflight classification
              return {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    onTopic: true,
                    intent: 'troubleshooting',
                    toolTags: RESEARCH_DOMAINS,
                    skillIds: [],
                  }),
                }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 50, output_tokens: 30 },
              };
            }

            // All subsequent calls (research sub-agents) fail
            throw new Error(domainResults[0].error);
          });

          const state = {
            conversationId: 'test-conv',
            messages: [{ role: 'user', content: 'Test query' }],
            systemPrompt: 'You are a TAM agent.',
            problemText: 'How do I fix the login issue?',
          };
          const callbacks = createMockCallbacks();

          const result = await runAgentLoop(state, callbacks);

          // Verify that fallbackToSequential was triggered
          expect(result.fallbackToSequential).toBe(true);

          // Verify that sequential fallback status message was emitted
          const statusCalls = callbacks.onStatus.mock.calls.map(c => c[0]);
          expect(statusCalls).toContain('Falling back to sequential research...');
        }
      ),
      { numRuns: 100 }
    );
  });
});
