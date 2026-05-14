import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'http';

// Mock the agentLoop module before importing the server
vi.mock('../agentLoop.js', () => ({
  runAgentLoop: vi.fn(async (state, callbacks) => {
    callbacks.onPhase('preflight');
    callbacks.onToken('Hello');
    callbacks.onComplete('Hello');
    return state;
  }),
}));

// Mock the llm module (required by agentLoop transitive deps)
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

import { app } from '../server.js';
import { runAgentLoop } from '../agentLoop.js';

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

describe('Server — Health Check', () => {
  it('GET /health returns 200 with status ok', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('Server — POST /api/chat', () => {
  it('accepts POST requests and returns SSE stream', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'test-123',
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'You are a helpful assistant.',
        problemText: 'Hello',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const text = await response.text();
    expect(text).toContain('event: phase');
    expect(text).toContain('event: token');
    expect(text).toContain('event: complete');
  });

  it('calls runAgentLoop with correct state from request body', async () => {
    await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conv-456',
        messages: [{ role: 'user', content: 'Search Jira' }],
        systemPrompt: 'TAM prompt',
        problemText: 'Search Jira',
      }),
    });

    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    const [state, callbacks] = runAgentLoop.mock.calls[0];

    expect(state.conversationId).toBe('conv-456');
    expect(state.messages).toEqual([{ role: 'user', content: 'Search Jira' }]);
    expect(state.systemPrompt).toBe('TAM prompt');
    expect(state.problemText).toBe('Search Jira');

    // Verify callbacks are functions
    expect(typeof callbacks.onToken).toBe('function');
    expect(typeof callbacks.onStatus).toBe('function');
    expect(typeof callbacks.onPhase).toBe('function');
    expect(typeof callbacks.onToolStatus).toBe('function');
    expect(typeof callbacks.onSkillActive).toBe('function');
    expect(typeof callbacks.onPlanUpdate).toBe('function');
    expect(typeof callbacks.onDocumentReady).toBe('function');
    expect(typeof callbacks.onError).toBe('function');
    expect(typeof callbacks.onComplete).toBe('function');
  });

  it('handles missing request body fields gracefully', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);

    const [state] = runAgentLoop.mock.calls[0];
    expect(state.conversationId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.systemPrompt).toBe('');
    expect(state.problemText).toBe('');
  });

  it('handles errors from runAgentLoop gracefully', async () => {
    runAgentLoop.mockImplementationOnce(async () => {
      throw new Error('LLM service unavailable');
    });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'test',
        messages: [],
        systemPrompt: '',
        problemText: 'test',
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: error');
    expect(text).toContain('LLM service unavailable');
  });
});

describe('Server — Static Files', () => {
  it('serves static files from public directory', async () => {
    const response = await fetch(`${baseUrl}/index.html`);
    // Should serve the file if it exists in public/
    expect(response.status).toBe(200);
  });
});
