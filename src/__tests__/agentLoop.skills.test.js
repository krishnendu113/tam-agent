import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the skillLoader module
vi.mock('../skillLoader.js', () => ({
  getSkillSummary: vi.fn(),
  getRegistryTriggers: vi.fn(() => new Map()),
}));

// Mock the llm module (required since agentLoop.js imports it)
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock compaction module
vi.mock('../compaction.js', () => ({
  shouldCompact: vi.fn(() => false),
  compactHistory: vi.fn(),
  buildCompactedContext: vi.fn(),
  estimateTokenCount: vi.fn(() => 0),
}));

// Mock tracing module
vi.mock('../tracing.js', () => ({
  createTrace: vi.fn(() => ({})),
  startSpan: vi.fn(() => ({})),
  endSpan: vi.fn(),
  flushTracing: vi.fn(),
}));

// Mock logger module
vi.mock('../logger.js', () => ({
  logLLMCall: vi.fn(),
  logRequestComplete: vi.fn(),
  logEvent: vi.fn(),
}));

// Mock clientTag module
vi.mock('../clientTag.js', () => ({
  extractClientTag: vi.fn(() => null),
}));

// Mock planManager module
vi.mock('../planManager.js', () => ({
  listSessionPlans: vi.fn(() => []),
}));

import { getSkillSummary } from '../skillLoader.js';
import { loadSkillsNode, skillRouterNode } from '../agentLoop.js';

describe('loadSkillsNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load skill summaries for valid skillIds and return them in state', async () => {
    const mockSummaries = {
      troubleshooting: { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps troubleshoot issues', referenceFiles: ['guide.md'] },
      onboarding: { id: 'onboarding', name: 'Onboarding', description: 'Onboarding workflow', referenceFiles: [] },
    };
    getSkillSummary.mockImplementation((skillId) => mockSummaries[skillId] || null);

    const state = { skillIds: ['troubleshooting', 'onboarding'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(getSkillSummary).toHaveBeenCalledWith('troubleshooting');
    expect(getSkillSummary).toHaveBeenCalledWith('onboarding');
    expect(result.skills).toEqual([
      { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps troubleshoot issues', referenceFiles: ['guide.md'] },
      { id: 'onboarding', name: 'Onboarding', description: 'Onboarding workflow', referenceFiles: [] },
    ]);
  });

  it('should return empty skills array when skillIds is empty', async () => {
    const state = { skillIds: [], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.skills).toEqual([]);
    expect(getSkillSummary).not.toHaveBeenCalled();
    expect(callbacks.onSkillActive).not.toHaveBeenCalled();
  });

  it('should return empty skills array when skillIds is undefined', async () => {
    const state = { messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.skills).toEqual([]);
    expect(getSkillSummary).not.toHaveBeenCalled();
  });

  it('should invoke callbacks.onSkillActive for each loaded skill', async () => {
    const mockSummaries = {
      troubleshooting: { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps troubleshoot issues', referenceFiles: [] },
      onboarding: { id: 'onboarding', name: 'Onboarding', description: 'Onboarding workflow', referenceFiles: [] },
    };
    getSkillSummary.mockImplementation((skillId) => mockSummaries[skillId] || null);

    const state = { skillIds: ['troubleshooting', 'onboarding'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    await loadSkillsNode(state, callbacks);

    expect(callbacks.onSkillActive).toHaveBeenCalledTimes(2);
    expect(callbacks.onSkillActive).toHaveBeenCalledWith('troubleshooting');
    expect(callbacks.onSkillActive).toHaveBeenCalledWith('onboarding');
  });

  it('should skip skills that getSkillSummary returns null for (nonexistent skills)', async () => {
    const mockSummaries = {
      troubleshooting: { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps troubleshoot issues', referenceFiles: [] },
    };
    getSkillSummary.mockImplementation((skillId) => mockSummaries[skillId] || null);

    const state = { skillIds: ['troubleshooting', 'nonexistent'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.skills).toEqual([
      { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps troubleshoot issues', referenceFiles: [] },
    ]);
    expect(callbacks.onSkillActive).toHaveBeenCalledTimes(1);
    expect(callbacks.onSkillActive).toHaveBeenCalledWith('troubleshooting');
  });

  it('should preserve existing state properties', async () => {
    getSkillSummary.mockReturnValue(null);

    const state = { skillIds: ['test'], messages: [{ role: 'user', content: 'hi' }], intent: 'help' };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.intent).toBe('help');
    expect(result.skillIds).toEqual(['test']);
  });

  it('should only include summary data (id, name, description, referenceFiles) - not full body', async () => {
    getSkillSummary.mockReturnValue({
      id: 'brd',
      name: 'BRD Writer',
      description: 'Creates Business Requirements Documents',
      referenceFiles: ['guardrails.md', 'customer-journey.md'],
    });

    const state = { skillIds: ['brd'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    // Verify the loaded skill has only summary fields
    expect(result.skills[0]).toEqual({
      id: 'brd',
      name: 'BRD Writer',
      description: 'Creates Business Requirements Documents',
      referenceFiles: ['guardrails.md', 'customer-journey.md'],
    });
    // Ensure no full body content (path, triggers, alwaysLoad are not present)
    expect(result.skills[0]).not.toHaveProperty('path');
    expect(result.skills[0]).not.toHaveProperty('triggers');
    expect(result.skills[0]).not.toHaveProperty('alwaysLoad');
  });
});

describe('skillRouterNode', () => {
  it('should return executionMode "multi-node" when skills are loaded', () => {
    const state = {
      skills: [
        { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps', referenceFiles: [] }
      ],
      messages: []
    };

    const result = skillRouterNode(state);

    expect(result.executionMode).toBe('multi-node');
  });

  it('should return executionMode "research" when no skills are loaded', () => {
    const state = { skills: [], messages: [] };

    const result = skillRouterNode(state);

    expect(result.executionMode).toBe('research');
  });

  it('should return executionMode "research" when skills is undefined', () => {
    const state = { messages: [] };

    const result = skillRouterNode(state);

    expect(result.executionMode).toBe('research');
  });

  it('should preserve existing state properties', () => {
    const state = {
      skills: [{ id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps', referenceFiles: [] }],
      messages: [{ role: 'user', content: 'hi' }],
      intent: 'troubleshoot',
      onTopic: true
    };

    const result = skillRouterNode(state);

    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.intent).toBe('troubleshoot');
    expect(result.onTopic).toBe(true);
    expect(result.executionMode).toBe('multi-node');
  });

  it('should return executionMode "multi-node" with multiple skills loaded', () => {
    const state = {
      skills: [
        { id: 'troubleshooting', name: 'Troubleshooting', description: 'Helps', referenceFiles: [] },
        { id: 'onboarding', name: 'Onboarding', description: 'Onboards', referenceFiles: [] }
      ],
      messages: []
    };

    const result = skillRouterNode(state);

    expect(result.executionMode).toBe('multi-node');
  });
});
