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
  getSkillSummary: vi.fn(() => null),
  getRegistryTriggers: vi.fn(() => new Map()),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

// Mock the db module for enhancedAuthMiddleware and conversation persistence
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: { toString: () => 'mock-conv-id' } });
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockFindOneUser = vi.fn().mockResolvedValue({ email: 'test@capillarytech.com', name: 'Test User', role: 'user', status: 'active' });
const mockCollection = vi.fn((name) => ({
  findOne: mockFindOneUser,
  insertOne: mockInsertOne,
  updateOne: mockUpdateOne,
  createIndex: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  connectDb: vi.fn().mockResolvedValue({}),
}));

import jwt from 'jsonwebtoken';
import { app } from '../server.js';
import { runAgentLoop } from '../agentLoop.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const testToken = jwt.sign({ email: 'test@capillarytech.com', name: 'Test User' }, JWT_SECRET, { expiresIn: '1h' });

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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
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
    // Verify conversationId is included in complete event
    expect(text).toContain('"conversationId"');
  });

  it('calls runAgentLoop with correct state from request body', async () => {
    await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);

    const [state] = runAgentLoop.mock.calls[0];
    // When conversationId is missing, a new one is created from DB
    expect(state.conversationId).toBe('mock-conv-id');
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
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

  it('creates a new conversation when conversationId is null', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        conversationId: null,
        messages: [{ role: 'user', content: 'Hello, this is my first message to the agent' }],
        systemPrompt: 'You are helpful.',
        problemText: 'Hello',
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();

    // Verify conversation was created in DB
    expect(mockCollection).toHaveBeenCalledWith('conversations');
    expect(mockInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test@capillarytech.com',
      title: 'Hello, this is my first message to the agent',
      messages: [],
    }));

    // Verify conversationId is returned in complete event
    expect(text).toContain('"conversationId":"mock-conv-id"');
  });

  it('appends messages to conversation on complete', async () => {
    const { ObjectId } = await import('mongodb');
    const existingConvId = new ObjectId().toHexString();

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        conversationId: existingConvId,
        messages: [{ role: 'user', content: 'What is the weather?' }],
        systemPrompt: '',
        problemText: 'weather',
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();

    // Verify messages were appended to the conversation
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({
        $push: { messages: { $each: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'What is the weather?' }),
          expect.objectContaining({ role: 'assistant', content: 'Hello' }),
        ]) } },
        $set: { updatedAt: expect.any(Date) },
      })
    );

    // Verify conversationId is in the complete event
    expect(text).toContain(`"conversationId":"${existingConvId}"`);
  });

  it('generates title from first 50 chars of first user message', async () => {
    const longMessage = 'This is a very long message that exceeds fifty characters and should be truncated for the title';

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        conversationId: null,
        messages: [{ role: 'user', content: longMessage }],
        systemPrompt: '',
        problemText: '',
      }),
    });

    expect(response.status).toBe(200);

    // Verify title is truncated to 50 chars
    expect(mockInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      title: longMessage.substring(0, 50).trim(),
    }));
  });
});

describe('Server — Static Files', () => {
  it('serves static files from public directory', async () => {
    const response = await fetch(`${baseUrl}/index.html`);
    // Should serve the file if it exists in public/
    expect(response.status).toBe(200);
  });
});
