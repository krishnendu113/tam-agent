import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';

// Mock db.js
const mockFind = vi.fn();
const mockFindOne = vi.fn();
const mockCreateIndex = vi.fn();
const mockCollection = vi.fn((name) => ({
  find: mockFind,
  findOne: mockFindOne,
  createIndex: mockCreateIndex,
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
}));

import { conversationsRouter, createConversationIndexes } from '../conversations.js';

// Helper to create a test app with the router
function createTestApp(user) {
  const app = express();
  app.use(express.json());
  // Simulate auth middleware attaching req.user
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/conversations', conversationsRouter);
  return app;
}

let server;
let baseUrl;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/conversations', () => {
  it('returns conversations for the authenticated user sorted by updatedAt descending', async () => {
    const mockConversations = [
      { _id: new ObjectId(), title: 'Recent chat', updatedAt: new Date('2024-01-15'), createdAt: new Date('2024-01-14') },
      { _id: new ObjectId(), title: 'Older chat', updatedAt: new Date('2024-01-10'), createdAt: new Date('2024-01-09') },
    ];

    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockConversations),
      }),
    });

    const app = createTestApp({ email: 'user@example.com', name: 'Test', role: 'user' });
    const srv = app.listen(0);
    const port = srv.address().port;

    try {
      const response = await fetch(`http://localhost:${port}/api/conversations`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].title).toBe('Recent chat');
      expect(body[1].title).toBe('Older chat');

      // Verify the query filters by userId
      expect(mockFind).toHaveBeenCalledWith(
        { userId: 'user@example.com' },
        { projection: { _id: 1, title: 1, updatedAt: 1, createdAt: 1 } }
      );
    } finally {
      srv.close();
    }
  });

  it('returns empty array when user has no conversations', async () => {
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    });

    const app = createTestApp({ email: 'new@example.com', name: 'New', role: 'user' });
    const srv = app.listen(0);
    const port = srv.address().port;

    try {
      const response = await fetch(`http://localhost:${port}/api/conversations`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    } finally {
      srv.close();
    }
  });
});

describe('GET /api/conversations/:id', () => {
  it('returns the full conversation when it belongs to the user', async () => {
    const convId = new ObjectId();
    const mockConversation = {
      _id: convId,
      userId: 'user@example.com',
      title: 'Test conversation',
      messages: [
        { role: 'user', content: 'Hello', timestamp: new Date() },
        { role: 'assistant', content: 'Hi there!', timestamp: new Date() },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindOne.mockResolvedValue(mockConversation);

    const app = createTestApp({ email: 'user@example.com', name: 'Test', role: 'user' });
    const srv = app.listen(0);
    const port = srv.address().port;

    try {
      const response = await fetch(`http://localhost:${port}/api/conversations/${convId.toHexString()}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.title).toBe('Test conversation');
      expect(body.messages).toHaveLength(2);
    } finally {
      srv.close();
    }
  });

  it('returns 403 when conversation belongs to another user', async () => {
    const convId = new ObjectId();
    const mockConversation = {
      _id: convId,
      userId: 'other@example.com',
      title: 'Other user conversation',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockFindOne.mockResolvedValue(mockConversation);

    const app = createTestApp({ email: 'user@example.com', name: 'Test', role: 'user' });
    const srv = app.listen(0);
    const port = srv.address().port;

    try {
      const response = await fetch(`http://localhost:${port}/api/conversations/${convId.toHexString()}`);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied');
    } finally {
      srv.close();
    }
  });

  it('returns 404 when conversation does not exist', async () => {
    const convId = new ObjectId();
    mockFindOne.mockResolvedValue(null);

    const app = createTestApp({ email: 'user@example.com', name: 'Test', role: 'user' });
    const srv = app.listen(0);
    const port = srv.address().port;

    try {
      const response = await fetch(`http://localhost:${port}/api/conversations/${convId.toHexString()}`);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    } finally {
      srv.close();
    }
  });

  it('returns 404 for invalid ObjectId format', async () => {
    const app = createTestApp({ email: 'user@example.com', name: 'Test', role: 'user' });
    const srv = app.listen(0);
    const port = srv.address().port;

    try {
      const response = await fetch(`http://localhost:${port}/api/conversations/invalid-id`);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    } finally {
      srv.close();
    }
  });
});

describe('createConversationIndexes', () => {
  it('creates the userId + updatedAt compound index', async () => {
    mockCreateIndex.mockResolvedValue('userId_1_updatedAt_-1');

    await createConversationIndexes();

    expect(mockCollection).toHaveBeenCalledWith('conversations');
    expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1, updatedAt: -1 });
  });
});
