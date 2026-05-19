import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock external dependencies (LLM, skills, tools)
vi.mock('../../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));
vi.mock('../../skillLoader.js', () => ({
  loadSkillsById: vi.fn(() => []),
}));
vi.mock('../../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

import { createMessage, streamMessage } from '../../llm.js';
import { executeTool, getToolDefinitions } from '../../tools/index.js';
import { loadSkillsById } from '../../skillLoader.js';
import { runAgentLoop } from '../../agentLoop.js';
import { app } from '../../server.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const testToken = jwt.sign({ email: 'test@capillarytech.com', name: 'Test User' }, JWT_SECRET, { expiresIn: '1h' });

/**
 * Helper: creates a mock preflight response indicating on-topic classification.
 */
function mockOnTopicPreflight({ intent = 'troubleshooting', toolTags = ['jira'], skillIds = [] } = {}) {
  return {
    role: 'assistant',
    content: [{
      type: 'text',
      text: JSON.stringify({ onTopic: true, intent, toolTags, skillIds }),
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 50, output_tokens: 30 },
  };
}

/**
 * Helper: creates a mock preflight response indicating off-topic classification.
 */
function mockOffTopicPreflight() {
  return {
    role: 'assistant',
    content: [{
      type: 'text',
      text: JSON.stringify({ onTopic: false, intent: 'casual chat', toolTags: [], skillIds: [] }),
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 50, output_tokens: 20 },
  };
}

/**
 * Helper: creates a mock research sub-agent response (text summary, no tool use).
 */
function mockResearchResponse(domain) {
  return {
    role: 'assistant',
    content: [{
      type: 'text',
      text: JSON.stringify({
        domain,
        found: true,
        summary: `Found relevant ${domain} results for the query.`,
        details: [{ title: `${domain} result 1`, url: `https://${domain}.example.com/1` }],
      }),
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 80 },
  };
}

/**
 * Helper: creates a mock async iterable for streamMessage that yields text events
 * and a final message_complete with end_turn.
 */
function createMockTextStream(text) {
  const events = [
    { type: 'text', text },
    {
      type: 'message_complete',
      response: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    },
  ];

  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

/**
 * Helper: creates a mock async iterable for streamMessage that yields a tool_use block.
 */
function createMockToolUseStream(toolName, toolId, toolInput) {
  const events = [
    { type: 'tool_use_start', name: toolName, id: toolId },
    {
      type: 'message_complete',
      response: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input: toolInput,
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 50 },
      },
    },
  ];

  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

/**
 * Helper: parses SSE text into an array of { event, data } objects.
 */
function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = null;
  let currentData = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent !== null) {
      events.push({ event: currentEvent, data: currentData ? JSON.parse(currentData) : null });
      currentEvent = null;
      currentData = null;
    }
  }

  return events;
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration: End-to-End Agent Loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Full on-topic research path', () => {
    it('executes preflight → research → synthesis and produces correct callbacks', async () => {
      // Setup: preflight returns on-topic with jira toolTag
      // Research sub-agents return results (createMessage called multiple times)
      // Synthesis streams final response

      let createMessageCallCount = 0;
      createMessage.mockImplementation(async (params) => {
        createMessageCallCount++;
        if (createMessageCallCount === 1) {
          // First call: preflight classification
          return mockOnTopicPreflight({ toolTags: ['jira'] });
        }
        // Subsequent calls: research sub-agent responses
        return mockResearchResponse('jira');
      });

      getToolDefinitions.mockReturnValue([]);
      loadSkillsById.mockReturnValue([]);

      // Synthesis stream returns a final text response
      streamMessage.mockReturnValue(createMockTextStream('Based on my research, here is the answer to your question.'));

      const state = {
        conversationId: 'integration-test-1',
        messages: [{ role: 'user', content: 'How do I reset my Jira password?' }],
        systemPrompt: 'You are a helpful TAM agent.',
        problemText: 'How do I reset my Jira password?',
      };

      const phases = [];
      const tokens = [];
      let completedText = null;

      const callbacks = {
        onToken: (text) => tokens.push(text),
        onStatus: vi.fn(),
        onPhase: (phase) => phases.push(phase),
        onToolStatus: vi.fn(),
        onSkillActive: vi.fn(),
        onPlanUpdate: vi.fn(),
        onDocumentReady: vi.fn(),
        onError: vi.fn(),
        onComplete: (text) => { completedText = text; },
      };

      const result = await runAgentLoop(state, callbacks);

      // Verify phase transitions occurred in correct order
      expect(phases).toContain('preflight');
      expect(phases).toContain('research');
      expect(phases).toContain('synthesis');
      expect(phases.indexOf('preflight')).toBeLessThan(phases.indexOf('research'));
      expect(phases.indexOf('research')).toBeLessThan(phases.indexOf('synthesis'));

      // Verify preflight was called (first createMessage call)
      expect(createMessage).toHaveBeenCalled();

      // Verify synthesis produced tokens and completed
      expect(tokens.length).toBeGreaterThan(0);
      expect(completedText).toBe('Based on my research, here is the answer to your question.');

      // Verify no errors occurred
      expect(callbacks.onError).not.toHaveBeenCalled();
    });
  });

  describe('Off-topic rejection path', () => {
    it('terminates early with refusal message when query is off-topic', async () => {
      // Preflight returns off-topic
      createMessage.mockResolvedValue(mockOffTopicPreflight());

      const state = {
        conversationId: 'integration-test-2',
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        systemPrompt: 'You are a helpful TAM agent.',
        problemText: 'What is the meaning of life?',
      };

      const phases = [];
      const tokens = [];
      let completedText = null;

      const callbacks = {
        onToken: (text) => tokens.push(text),
        onStatus: vi.fn(),
        onPhase: (phase) => phases.push(phase),
        onToolStatus: vi.fn(),
        onSkillActive: vi.fn(),
        onPlanUpdate: vi.fn(),
        onDocumentReady: vi.fn(),
        onError: vi.fn(),
        onComplete: (text) => { completedText = text; },
      };

      await runAgentLoop(state, callbacks);

      // Verify preflight phase occurred
      expect(phases).toContain('preflight');
      expect(phases).toContain('refusal');

      // Verify research and synthesis phases did NOT occur
      expect(phases).not.toContain('research');
      expect(phases).not.toContain('synthesis');

      // Verify refusal message was emitted
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens[0]).toContain("I'm sorry");
      expect(completedText).toContain("I can only help with technical support");

      // Verify streamMessage was never called (no synthesis)
      expect(streamMessage).not.toHaveBeenCalled();

      // Verify no errors
      expect(callbacks.onError).not.toHaveBeenCalled();
    });
  });

  describe('Tool-use synthesis loop with mock tools', () => {
    it('executes tools during synthesis and re-invokes LLM with results', async () => {
      // Preflight: on-topic
      let createMessageCallCount = 0;
      createMessage.mockImplementation(async () => {
        createMessageCallCount++;
        if (createMessageCallCount === 1) {
          return mockOnTopicPreflight({ toolTags: ['jira'] });
        }
        // Research sub-agent responses
        return mockResearchResponse('jira');
      });

      loadSkillsById.mockReturnValue([]);
      getToolDefinitions.mockReturnValue([
        { name: 'search_jira', description: 'Search Jira issues', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
      ]);

      // First synthesis call: returns tool_use
      // Second synthesis call: returns final text
      let streamCallCount = 0;
      streamMessage.mockImplementation(() => {
        streamCallCount++;
        if (streamCallCount === 1) {
          return createMockToolUseStream('search_jira', 'tool-call-1', { query: 'password reset' });
        }
        return createMockTextStream('I found the answer: go to Settings > Security > Reset Password.');
      });

      // Mock tool execution
      executeTool.mockResolvedValue({ results: [{ key: 'JIRA-123', summary: 'Password reset guide' }] });

      const state = {
        conversationId: 'integration-test-3',
        messages: [{ role: 'user', content: 'How do I reset my password?' }],
        systemPrompt: 'You are a helpful TAM agent.',
        problemText: 'How do I reset my password?',
      };

      const phases = [];
      const tokens = [];
      const toolStatuses = [];
      let completedText = null;

      const callbacks = {
        onToken: (text) => tokens.push(text),
        onStatus: vi.fn(),
        onPhase: (phase) => phases.push(phase),
        onToolStatus: (name, status) => toolStatuses.push({ name, status }),
        onSkillActive: vi.fn(),
        onPlanUpdate: vi.fn(),
        onDocumentReady: vi.fn(),
        onError: vi.fn(),
        onComplete: (text) => { completedText = text; },
      };

      await runAgentLoop(state, callbacks);

      // Verify tool was executed
      expect(executeTool).toHaveBeenCalledWith('search_jira', { query: 'password reset' });

      // Verify tool status callbacks were invoked
      expect(toolStatuses).toContainEqual({ name: 'search_jira', status: 'started' });
      expect(toolStatuses).toContainEqual({ name: 'search_jira', status: 'completed' });

      // Verify synthesis completed with final text after tool use
      expect(completedText).toBe('I found the answer: go to Settings > Security > Reset Password.');

      // Verify streamMessage was called twice (first for tool_use, second for final response)
      expect(streamMessage).toHaveBeenCalledTimes(2);

      // Verify phases include synthesis
      expect(phases).toContain('synthesis');

      // Verify no errors
      expect(callbacks.onError).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// SSE Streaming Integration Test (Express Server)
// ============================================================================

describe('Integration: SSE Streaming from Express Server', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address();
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams SSE events for a full on-topic research flow', async () => {
    // Mock preflight: on-topic
    let createMessageCallCount = 0;
    createMessage.mockImplementation(async () => {
      createMessageCallCount++;
      if (createMessageCallCount === 1) {
        return mockOnTopicPreflight({ toolTags: ['jira'] });
      }
      return mockResearchResponse('jira');
    });

    loadSkillsById.mockReturnValue([]);
    getToolDefinitions.mockReturnValue([]);

    // Synthesis: stream final text
    streamMessage.mockReturnValue(createMockTextStream('Here is your answer about Jira.'));

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        conversationId: 'sse-test-1',
        messages: [{ role: 'user', content: 'Search Jira for password issues' }],
        systemPrompt: 'You are a TAM agent.',
        problemText: 'Search Jira for password issues',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const text = await response.text();
    const events = parseSSE(text);

    // Verify phase events are present
    const phaseEvents = events.filter(e => e.event === 'phase');
    const phaseNames = phaseEvents.map(e => e.data.phase);
    expect(phaseNames).toContain('preflight');
    expect(phaseNames).toContain('research');
    expect(phaseNames).toContain('synthesis');

    // Verify token events are present
    const tokenEvents = events.filter(e => e.event === 'token');
    expect(tokenEvents.length).toBeGreaterThan(0);

    // Verify complete event is present with final text
    const completeEvents = events.filter(e => e.event === 'complete');
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].data.text).toBe('Here is your answer about Jira.');
  });

  it('streams SSE events for off-topic rejection', async () => {
    createMessage.mockResolvedValue(mockOffTopicPreflight());

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        conversationId: 'sse-test-2',
        messages: [{ role: 'user', content: 'Tell me a joke' }],
        systemPrompt: 'You are a TAM agent.',
        problemText: 'Tell me a joke',
      }),
    });

    expect(response.status).toBe(200);

    const text = await response.text();
    const events = parseSSE(text);

    // Verify phase events include preflight and refusal
    const phaseEvents = events.filter(e => e.event === 'phase');
    const phaseNames = phaseEvents.map(e => e.data.phase);
    expect(phaseNames).toContain('preflight');
    expect(phaseNames).toContain('refusal');

    // Verify no research or synthesis phases
    expect(phaseNames).not.toContain('research');
    expect(phaseNames).not.toContain('synthesis');

    // Verify token event contains refusal message
    const tokenEvents = events.filter(e => e.event === 'token');
    expect(tokenEvents.length).toBeGreaterThan(0);
    const tokenText = tokenEvents.map(e => e.data.text).join('');
    expect(tokenText).toContain("I'm sorry");

    // Verify complete event
    const completeEvents = events.filter(e => e.event === 'complete');
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].data.text).toContain('technical support');
  });

  it('streams SSE events with tool status during synthesis', async () => {
    // Preflight: on-topic
    let createMessageCallCount = 0;
    createMessage.mockImplementation(async () => {
      createMessageCallCount++;
      if (createMessageCallCount === 1) {
        return mockOnTopicPreflight({ toolTags: ['jira'] });
      }
      return mockResearchResponse('jira');
    });

    loadSkillsById.mockReturnValue([]);
    getToolDefinitions.mockReturnValue([
      { name: 'search_jira', description: 'Search Jira', input_schema: { type: 'object' } },
    ]);

    // First synthesis: tool_use, second: final text
    let streamCallCount = 0;
    streamMessage.mockImplementation(() => {
      streamCallCount++;
      if (streamCallCount === 1) {
        return createMockToolUseStream('search_jira', 'tool-1', { query: 'test' });
      }
      return createMockTextStream('Found the result.');
    });

    executeTool.mockResolvedValue({ results: [] });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        conversationId: 'sse-test-3',
        messages: [{ role: 'user', content: 'Search for issues' }],
        systemPrompt: 'You are a TAM agent.',
        problemText: 'Search for issues',
      }),
    });

    expect(response.status).toBe(200);

    const text = await response.text();
    const events = parseSSE(text);

    // Verify tool_status events are present
    const toolStatusEvents = events.filter(e => e.event === 'tool_status');
    expect(toolStatusEvents.length).toBeGreaterThanOrEqual(2);

    const toolNames = toolStatusEvents.map(e => e.data.name);
    expect(toolNames).toContain('search_jira');

    const toolStatuses = toolStatusEvents.map(e => e.data.status);
    expect(toolStatuses).toContain('started');
    expect(toolStatuses).toContain('completed');

    // Verify complete event
    const completeEvents = events.filter(e => e.event === 'complete');
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].data.text).toBe('Found the result.');
  });
});
