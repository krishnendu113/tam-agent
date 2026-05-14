import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  REQUIRED_CALLBACKS,
  createCallbackInterface,
  validateCallbacks,
} from '../callbacks.js';
import { runAgentLoop } from '../agentLoop.js';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock the skillLoader module
vi.mock('../skillLoader.js', () => ({
  loadSkillsById: vi.fn(() => []),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

import { createMessage } from '../llm.js';

describe('Callback Interface — REQUIRED_CALLBACKS', () => {
  it('contains all expected callback names', () => {
    expect(REQUIRED_CALLBACKS).toContain('onToken');
    expect(REQUIRED_CALLBACKS).toContain('onStatus');
    expect(REQUIRED_CALLBACKS).toContain('onPhase');
    expect(REQUIRED_CALLBACKS).toContain('onToolStatus');
    expect(REQUIRED_CALLBACKS).toContain('onSkillActive');
    expect(REQUIRED_CALLBACKS).toContain('onPlanUpdate');
    expect(REQUIRED_CALLBACKS).toContain('onDocumentReady');
    expect(REQUIRED_CALLBACKS).toContain('onError');
    expect(REQUIRED_CALLBACKS).toContain('onComplete');
  });

  it('has exactly 9 required callbacks', () => {
    expect(REQUIRED_CALLBACKS).toHaveLength(9);
  });
});

describe('Callback Interface — createCallbackInterface', () => {
  it('returns an object with all required callback functions when all are provided', () => {
    const overrides = {};
    for (const name of REQUIRED_CALLBACKS) {
      overrides[name] = vi.fn();
    }

    const result = createCallbackInterface(overrides);

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
      expect(result[name]).toBe(overrides[name]);
    }
  });

  it('fills missing callbacks with no-op defaults', () => {
    const onToken = vi.fn();
    const result = createCallbackInterface({ onToken });

    expect(result.onToken).toBe(onToken);
    // All other callbacks should be no-op functions
    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
    // Calling no-op defaults should not throw
    result.onStatus('test');
    result.onPhase('preflight');
    result.onToolStatus('tool', 'started');
    result.onSkillActive('skill-1');
    result.onPlanUpdate({});
    result.onDocumentReady({});
    result.onError(new Error('test'));
    result.onComplete('done');
  });

  it('returns all no-op defaults when called with no arguments', () => {
    const result = createCallbackInterface();

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
      // Calling should not throw
      result[name]();
    }
  });

  it('returns all no-op defaults when called with empty object', () => {
    const result = createCallbackInterface({});

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
  });

  it('replaces non-function values with no-op defaults', () => {
    const result = createCallbackInterface({
      onToken: 'not a function',
      onStatus: 42,
      onPhase: null,
      onToolStatus: undefined,
      onSkillActive: {},
      onPlanUpdate: [],
      onDocumentReady: true,
      onError: Symbol('err'),
      onComplete: /regex/,
    });

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
      // Should not throw when called
      result[name]();
    }
  });

  it('preserves only valid function overrides', () => {
    const onPhase = vi.fn();
    const onError = vi.fn();

    const result = createCallbackInterface({
      onToken: 'invalid',
      onPhase,
      onError,
      onStatus: 123,
    });

    expect(result.onPhase).toBe(onPhase);
    expect(result.onError).toBe(onError);
    expect(result.onToken).not.toBe('invalid');
    expect(typeof result.onToken).toBe('function');
    expect(typeof result.onStatus).toBe('function');
  });
});

describe('Callback Interface — validateCallbacks', () => {
  it('returns all no-op defaults when given null', () => {
    const result = validateCallbacks(null);

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
  });

  it('returns all no-op defaults when given undefined', () => {
    const result = validateCallbacks(undefined);

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
  });

  it('returns all no-op defaults when given a non-object (string)', () => {
    const result = validateCallbacks('not an object');

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
  });

  it('returns all no-op defaults when given a non-object (number)', () => {
    const result = validateCallbacks(42);

    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
  });

  it('normalizes a partial callbacks object', () => {
    const onToken = vi.fn();
    const onError = vi.fn();

    const result = validateCallbacks({ onToken, onError });

    expect(result.onToken).toBe(onToken);
    expect(result.onError).toBe(onError);
    for (const name of REQUIRED_CALLBACKS) {
      expect(typeof result[name]).toBe('function');
    }
  });

  it('normalizes a complete callbacks object', () => {
    const overrides = {};
    for (const name of REQUIRED_CALLBACKS) {
      overrides[name] = vi.fn();
    }

    const result = validateCallbacks(overrides);

    for (const name of REQUIRED_CALLBACKS) {
      expect(result[name]).toBe(overrides[name]);
    }
  });

  it('replaces non-function values with no-ops', () => {
    const result = validateCallbacks({
      onToken: null,
      onStatus: 'string',
      onPhase: vi.fn(), // only this one is valid
    });

    expect(typeof result.onToken).toBe('function');
    expect(typeof result.onStatus).toBe('function');
    expect(typeof result.onPhase).toBe('function');
    // onPhase should be the provided function
    expect(result.onPhase).not.toBe(null);
  });
});

describe('runAgentLoop — callback validation integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not crash when callbacks is null', async () => {
    // Mock preflight to return off-topic so we terminate early
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: false,
        intent: 'casual chat',
        toolTags: [],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Hello there' }],
      problemText: 'Hello there',
    };

    // Should not throw
    const result = await runAgentLoop(state, null);
    expect(result.onTopic).toBe(false);
  });

  it('does not crash when callbacks is undefined', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: false,
        intent: 'off-topic',
        toolTags: [],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const state = {
      messages: [{ role: 'user', content: 'What is the weather?' }],
      problemText: 'What is the weather?',
    };

    const result = await runAgentLoop(state, undefined);
    expect(result.onTopic).toBe(false);
  });

  it('does not crash when callbacks is an empty object', async () => {
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: false,
        intent: 'off-topic',
        toolTags: [],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Tell me a joke' }],
      problemText: 'Tell me a joke',
    };

    const result = await runAgentLoop(state, {});
    expect(result.onTopic).toBe(false);
  });

  it('does not crash with partial callbacks (only onPhase provided)', async () => {
    const onPhase = vi.fn();

    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: false,
        intent: 'off-topic',
        toolTags: [],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Random question' }],
      problemText: 'Random question',
    };

    const result = await runAgentLoop(state, { onPhase });
    expect(result.onTopic).toBe(false);
    expect(onPhase).toHaveBeenCalledWith('preflight');
    expect(onPhase).toHaveBeenCalledWith('refusal');
  });

  it('invokes callbacks.onPhase at phase transitions for off-topic path', async () => {
    const onPhase = vi.fn();
    const onToken = vi.fn();
    const onComplete = vi.fn();

    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: false,
        intent: 'casual',
        toolTags: [],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Hi' }],
      problemText: 'Hi',
    };

    await runAgentLoop(state, { onPhase, onToken, onComplete });

    expect(onPhase).toHaveBeenCalledWith('preflight');
    expect(onPhase).toHaveBeenCalledWith('refusal');
  });

  it('invokes callbacks.onError on unrecoverable errors and terminates gracefully', async () => {
    const onPhase = vi.fn();
    const onError = vi.fn();

    // Make preflight throw to trigger the catch block in runAgentLoop
    // We need to make it throw in a way that isn't caught by preflightNode's internal try/catch
    // preflightNode catches LLM errors internally (fail-open), so we need to cause
    // an error after preflight — e.g., by making the state trigger an error in a later node.
    // The simplest approach: mock createMessage to return on-topic, then the synthesis
    // loop will fail because streamMessage is not properly mocked.
    createMessage.mockResolvedValue({
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({
        onTopic: true,
        intent: 'search jira',
        toolTags: ['jira'],
        skillIds: [],
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const state = {
      messages: [{ role: 'user', content: 'Search Jira' }],
      problemText: 'Search Jira',
    };

    const result = await runAgentLoop(state, { onPhase, onError });

    // onError should have been called with some error (streamMessage not mocked properly)
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    // Should still return state (graceful termination, no throw)
    expect(result).toBeDefined();
  });
});
