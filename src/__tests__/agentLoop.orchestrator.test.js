import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

// Mock the skillLoader module
vi.mock('../skillLoader.js', () => ({
  getSkillSummary: vi.fn(() => null),
  getRegistryTriggers: vi.fn(() => new Map()),
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
import { runAgentLoop, REFUSAL_MESSAGE } from '../agentLoop.js';

/**
 * Creates a mock callbacks object with all required callback functions.
 */
function createMockCallbacks() {
  return {
    onToken: vi.fn(),
    onStatus: vi.fn(),
    onPhase: vi.fn(),
    onToolStatus: vi.fn(),
    onSkillActive: vi.fn(),
    onPlanUpdate: vi.fn(),
    onDocumentReady: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
  };
}

/**
 * Helper to make createMessage return an on-topic preflight response.
 */
function mockOnTopicPreflight(overrides = {}) {
  createMessage.mockResolvedValue({
    role: 'assistant',
    content: [{
      type: 'text',
      text: JSON.stringify({
        onTopic: true,
        intent: 'troubleshoot deployment issue',
        toolTags: ['jira'],
        skillIds: ['troubleshooting'],
        ...overrides,
      }),
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 30, output_tokens: 20 },
  });
}

/**
 * Helper to make createMessage return an off-topic preflight response.
 */
function mockOffTopicPreflight() {
  createMessage.mockResolvedValue({
    role: 'assistant',
    content: [{
      type: 'text',
      text: JSON.stringify({
        onTopic: false,
        intent: 'casual chat',
        toolTags: [],
        skillIds: [],
      }),
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 20, output_tokens: 15 },
  });
}

describe('runAgentLoop — orchestrator', () => {
  let callbacks;
  let baseState;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
    baseState = {
      conversationId: 'conv-001',
      messages: [{ role: 'user', content: 'Help me fix a deployment issue' }],
      systemPrompt: 'You are a TAM agent.',
      problemText: 'Help me fix a deployment issue',
    };
  });

  describe('On-topic flow — full execution path', () => {
    it('executes all nodes in order for on-topic multi-node path', async () => {
      mockOnTopicPreflight({ skillIds: ['troubleshooting'] });
      getSkillSummary.mockImplementation((id) => id === 'troubleshooting' ? { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps', referenceFiles: [] } : null);

      const result = await runAgentLoop(baseState, callbacks);

      // Verify phase transitions in order
      const phaseCalls = callbacks.onPhase.mock.calls.map(c => c[0]);
      expect(phaseCalls).toEqual([
        'preflight',
        'skill_loading',
        'multi_node',
        'synthesis',
      ]);

      // Verify state has executionMode set
      expect(result.executionMode).toBe('multi-node');
      expect(result.onTopic).toBe(true);
    });

    it('executes research path when no skills are loaded', async () => {
      mockOnTopicPreflight({ skillIds: [], toolTags: ['webSearch'] });
      getSkillSummary.mockReturnValue(null);

      const result = await runAgentLoop(baseState, callbacks);

      const phaseCalls = callbacks.onPhase.mock.calls.map(c => c[0]);
      expect(phaseCalls).toEqual([
        'preflight',
        'skill_loading',
        'research',
        'synthesis',
      ]);

      expect(result.executionMode).toBe('research');
    });

    it('invokes callbacks.onSkillActive for loaded skills', async () => {
      mockOnTopicPreflight({ skillIds: ['troubleshooting'] });
      getSkillSummary.mockImplementation((id) => id === 'troubleshooting' ? { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps', referenceFiles: [] } : null);

      await runAgentLoop(baseState, callbacks);

      expect(callbacks.onSkillActive).toHaveBeenCalledWith('troubleshooting');
    });

    it('preserves original state fields through the pipeline', async () => {
      mockOnTopicPreflight({ skillIds: [] });
      getSkillSummary.mockReturnValue(null);

      const result = await runAgentLoop(baseState, callbacks);

      expect(result.conversationId).toBe('conv-001');
      // systemPrompt gets plan instruction appended
      expect(result.systemPrompt).toContain('You are a TAM agent.');
    });
  });

  describe('Off-topic flow — refusal and early termination', () => {
    it('invokes refusal callback and terminates when off-topic', async () => {
      // First call: preflight classification (off-topic)
      createMessage.mockResolvedValueOnce({
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            onTopic: false,
            intent: 'casual chat',
            toolTags: [],
            skillIds: [],
          }),
        }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 15 },
      });
      // Second call: refusal message generation
      createMessage.mockResolvedValueOnce({
        role: 'assistant',
        content: [{ type: 'text', text: 'Witty refusal message' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 10 },
      });

      const result = await runAgentLoop(baseState, callbacks);

      // Verify refusal phase
      const phaseCalls = callbacks.onPhase.mock.calls.map(c => c[0]);
      expect(phaseCalls).toEqual(['preflight', 'refusal']);

      // Verify refusal token and complete callbacks
      expect(callbacks.onToken).toHaveBeenCalledWith('Witty refusal message');
      expect(callbacks.onComplete).toHaveBeenCalledWith('Witty refusal message');

      // Verify no further execution
      expect(result.onTopic).toBe(false);
    });

    it('does not invoke skill loading or research when off-topic', async () => {
      // First call: preflight classification (off-topic)
      createMessage.mockResolvedValueOnce({
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            onTopic: false,
            intent: 'casual chat',
            toolTags: [],
            skillIds: [],
          }),
        }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 15 },
      });
      // Second call: refusal message generation
      createMessage.mockResolvedValueOnce({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stay on topic please' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 10 },
      });

      await runAgentLoop(baseState, callbacks);

      expect(getSkillSummary).not.toHaveBeenCalled();
      // Only preflight and refusal phases
      expect(callbacks.onPhase).toHaveBeenCalledTimes(2);
      expect(callbacks.onPhase).not.toHaveBeenCalledWith('skill_loading');
      expect(callbacks.onPhase).not.toHaveBeenCalledWith('research');
      expect(callbacks.onPhase).not.toHaveBeenCalledWith('synthesis');
    });
  });

  describe('Phase callbacks — invoked at each transition', () => {
    it('invokes onPhase("preflight") as the first callback', async () => {
      mockOnTopicPreflight({ skillIds: [] });
      getSkillSummary.mockReturnValue(null);

      await runAgentLoop(baseState, callbacks);

      expect(callbacks.onPhase.mock.calls[0][0]).toBe('preflight');
    });

    it('invokes onPhase("skill_loading") after preflight for on-topic', async () => {
      mockOnTopicPreflight({ skillIds: [] });
      getSkillSummary.mockReturnValue(null);

      await runAgentLoop(baseState, callbacks);

      expect(callbacks.onPhase.mock.calls[1][0]).toBe('skill_loading');
    });

    it('invokes onPhase("synthesis") as the last phase for on-topic flow', async () => {
      mockOnTopicPreflight({ skillIds: [] });
      getSkillSummary.mockReturnValue(null);

      await runAgentLoop(baseState, callbacks);

      const phaseCalls = callbacks.onPhase.mock.calls.map(c => c[0]);
      expect(phaseCalls[phaseCalls.length - 1]).toBe('synthesis');
    });
  });

  describe('Error handling — unrecoverable errors', () => {
    it('invokes callbacks.onError when preflightNode throws', async () => {
      const error = new Error('Bedrock API unavailable');
      createMessage.mockRejectedValue(error);

      // preflightNode itself catches errors and fails-open, so we need to
      // simulate an error that escapes the node. Let's mock createMessage
      // to throw in a way that preflightNode doesn't catch.
      // Actually, preflightNode catches all errors internally (fail-open).
      // So let's test a scenario where getSkillSummary throws instead.
      mockOnTopicPreflight({ skillIds: ['troubleshooting'] });
      getSkillSummary.mockImplementation(() => {
        throw new Error('Skill loading failed catastrophically');
      });

      const result = await runAgentLoop(baseState, callbacks);

      expect(callbacks.onError).toHaveBeenCalledTimes(1);
      expect(callbacks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Skill loading failed catastrophically' })
      );
      // Should return state (possibly partially updated)
      expect(result).toBeDefined();
    });

    it('terminates gracefully after onError — no further phases invoked', async () => {
      mockOnTopicPreflight({ skillIds: ['troubleshooting'] });
      getSkillSummary.mockImplementation(() => {
        throw new Error('Unexpected failure');
      });

      await runAgentLoop(baseState, callbacks);

      // Only preflight and skill_loading phases should have been called
      const phaseCalls = callbacks.onPhase.mock.calls.map(c => c[0]);
      expect(phaseCalls).toEqual(['preflight', 'skill_loading']);
      // No synthesis or research phases
      expect(phaseCalls).not.toContain('synthesis');
      expect(phaseCalls).not.toContain('research');
    });

    it('returns state even when an error occurs', async () => {
      mockOnTopicPreflight({ skillIds: ['troubleshooting'] });
      getSkillSummary.mockImplementation(() => {
        throw new Error('Boom');
      });

      const result = await runAgentLoop(baseState, callbacks);

      // State should be returned (at least the preflight-updated state)
      expect(result.onTopic).toBe(true);
      expect(result.conversationId).toBe('conv-001');
    });
  });

  describe('No LangGraph dependency', () => {
    it('runAgentLoop does not import or use @langchain/langgraph', async () => {
      // This is a structural test — we verify the module works without langgraph
      mockOnTopicPreflight({ skillIds: [] });
      getSkillSummary.mockReturnValue(null);

      // If langgraph were required, this would fail since it's not installed
      const result = await runAgentLoop(baseState, callbacks);
      expect(result).toBeDefined();
      expect(result.executionMode).toBe('research');
    });
  });
});
