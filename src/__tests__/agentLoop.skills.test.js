import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the skillLoader module
vi.mock('../skillLoader.js', () => ({
  loadSkillsById: vi.fn(),
}));

// Mock the llm module (required since agentLoop.js imports it)
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
}));

import { loadSkillsById } from '../skillLoader.js';
import { loadSkillsNode, skillRouterNode } from '../agentLoop.js';

describe('loadSkillsNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load skills for valid skillIds and return them in state', async () => {
    const mockSkills = [
      { id: 'troubleshooting', name: 'Troubleshooting', path: './skills/troubleshooting' },
      { id: 'onboarding', name: 'Onboarding', path: './skills/onboarding' }
    ];
    loadSkillsById.mockReturnValue(mockSkills);

    const state = { skillIds: ['troubleshooting', 'onboarding'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(loadSkillsById).toHaveBeenCalledWith(['troubleshooting', 'onboarding']);
    expect(result.skills).toEqual(mockSkills);
  });

  it('should return empty skills array when skillIds is empty', async () => {
    const state = { skillIds: [], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.skills).toEqual([]);
    expect(loadSkillsById).not.toHaveBeenCalled();
    expect(callbacks.onSkillActive).not.toHaveBeenCalled();
  });

  it('should return empty skills array when skillIds is undefined', async () => {
    const state = { messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.skills).toEqual([]);
    expect(loadSkillsById).not.toHaveBeenCalled();
  });

  it('should invoke callbacks.onSkillActive for each loaded skill', async () => {
    const mockSkills = [
      { id: 'troubleshooting', name: 'Troubleshooting', path: './skills/troubleshooting' },
      { id: 'onboarding', name: 'Onboarding', path: './skills/onboarding' }
    ];
    loadSkillsById.mockReturnValue(mockSkills);

    const state = { skillIds: ['troubleshooting', 'onboarding'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    await loadSkillsNode(state, callbacks);

    expect(callbacks.onSkillActive).toHaveBeenCalledTimes(2);
    expect(callbacks.onSkillActive).toHaveBeenCalledWith('troubleshooting');
    expect(callbacks.onSkillActive).toHaveBeenCalledWith('onboarding');
  });

  it('should handle case where skillLoader returns fewer skills than requested', async () => {
    const mockSkills = [
      { id: 'troubleshooting', name: 'Troubleshooting', path: './skills/troubleshooting' }
    ];
    loadSkillsById.mockReturnValue(mockSkills);

    const state = { skillIds: ['troubleshooting', 'nonexistent'], messages: [] };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.skills).toEqual(mockSkills);
    expect(callbacks.onSkillActive).toHaveBeenCalledTimes(1);
    expect(callbacks.onSkillActive).toHaveBeenCalledWith('troubleshooting');
  });

  it('should preserve existing state properties', async () => {
    loadSkillsById.mockReturnValue([]);

    const state = { skillIds: ['test'], messages: [{ role: 'user', content: 'hi' }], intent: 'help' };
    const callbacks = { onSkillActive: vi.fn() };

    const result = await loadSkillsNode(state, callbacks);

    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.intent).toBe('help');
    expect(result.skillIds).toEqual(['test']);
  });
});

describe('skillRouterNode', () => {
  it('should return executionMode "multi-node" when skills are loaded', () => {
    const state = {
      skills: [
        { id: 'troubleshooting', name: 'Troubleshooting', path: './skills/troubleshooting' }
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
      skills: [{ id: 'troubleshooting', name: 'Troubleshooting' }],
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
        { id: 'troubleshooting', name: 'Troubleshooting' },
        { id: 'onboarding', name: 'Onboarding' }
      ],
      messages: []
    };

    const result = skillRouterNode(state);

    expect(result.executionMode).toBe('multi-node');
  });
});
