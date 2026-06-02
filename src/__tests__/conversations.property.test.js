import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import { ObjectId } from 'mongodb';

// --- Mock Setup ---

const mockFind = vi.fn();
const mockFindOne = vi.fn();
const mockInsertOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreateIndex = vi.fn();
const mockCollection = vi.fn(() => ({
  find: mockFind,
  findOne: mockFindOne,
  insertOne: mockInsertOne,
  updateOne: mockUpdateOne,
  createIndex: mockCreateIndex,
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
}));

import { conversationsRouter } from '../conversations.js';

// --- Helpers ---

/**
 * Creates a test Express app with the conversations router and a simulated auth user.
 */
function createTestApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/conversations', conversationsRouter);
  return app;
}

/**
 * Starts a test server and returns the port and a close function.
 */
function startServer(app) {
  const srv = app.listen(0);
  const port = srv.address().port;
  return { port, close: () => srv.close() };
}

// --- Generators ---

/**
 * Generates a valid email address.
 */
function arbEmail() {
  return fc
    .tuple(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 3,
        maxLength: 12,
      }),
      fc.constantFrom('example.com', 'test.org', 'company.io', 'domain.net')
    )
    .map(([local, domain]) => `${local}@${domain}`);
}

/**
 * Generates a pair of distinct email addresses (owner and other user).
 */
function arbDistinctEmails() {
  return fc
    .tuple(arbEmail(), arbEmail())
    .filter(([a, b]) => a !== b);
}

/**
 * Generates a conversation title (non-empty printable string).
 */
function arbTitle() {
  return fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_'.split('')),
    { minLength: 1, maxLength: 50 }
  );
}

/**
 * Generates a message content string (non-empty).
 */
function arbContent() {
  return fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-_\n'.split('')),
    { minLength: 1, maxLength: 200 }
  );
}

/**
 * Generates a message role.
 */
function arbRole() {
  return fc.constantFrom('user', 'assistant');
}

/**
 * Generates a single message object with role, content, and timestamp.
 */
function arbMessage() {
  return fc.record({
    role: arbRole(),
    content: arbContent(),
    timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-01-01') }),
  });
}

/**
 * Generates a non-empty array of messages.
 */
function arbMessages() {
  return fc.array(arbMessage(), { minLength: 1, maxLength: 20 });
}

/**
 * Generates a set of distinct dates for updatedAt timestamps.
 */
function arbDistinctDates(count) {
  return fc
    .uniqueArray(
      fc.integer({ min: 1704067200000, max: 1735689600000 }), // 2024-01-01 to 2025-01-01
      { minLength: count, maxLength: count }
    )
    .map((timestamps) => timestamps.map((ts) => new Date(ts)));
}

/**
 * Generates a number of conversations between 2 and 10.
 */
function arbConversationCount() {
  return fc.integer({ min: 2, max: 10 });
}

// --- Property Tests ---

describe('Feature: frontend-auth-admin, Property 5: Conversation ownership isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Validates: Requirements 9.1, 9.2, 9.3
   *
   * For any authenticated user, GET /api/conversations SHALL return only
   * conversations where userId matches the authenticated user's email,
   * and GET /api/conversations/:id SHALL return 403 for any conversation
   * where userId does not match the authenticated user's email.
   */
  it('GET /api/conversations returns only conversations owned by the authenticated user, and GET /api/conversations/:id returns 403 for non-owned conversations', async () => {
    await fc.assert(
      fc.asyncProperty(arbDistinctEmails(), arbTitle(), async ([ownerEmail, otherEmail], title) => {
        vi.clearAllMocks();

        const ownedConvId = new ObjectId();
        const otherConvId = new ObjectId();

        // Mock: GET /api/conversations returns only the owner's conversations
        const ownedConversations = [
          { _id: ownedConvId, title, updatedAt: new Date(), createdAt: new Date() },
        ];

        mockFind.mockReturnValue({
          sort: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(ownedConversations),
          }),
        });

        const app = createTestApp({ email: ownerEmail, name: 'Owner', role: 'user' });
        const { port, close } = startServer(app);

        try {
          // Test 1: GET /api/conversations returns only owned conversations
          const listResponse = await fetch(`http://localhost:${port}/api/conversations`);
          const listBody = await listResponse.json();

          expect(listResponse.status).toBe(200);
          expect(listBody).toHaveLength(1);
          expect(listBody[0]._id).toBe(ownedConvId.toHexString());

          // Verify the query filtered by the authenticated user's email
          expect(mockFind).toHaveBeenCalledWith(
            { userId: ownerEmail },
            { projection: { _id: 1, title: 1, updatedAt: 1, createdAt: 1 } }
          );

          // Test 2: GET /api/conversations/:id returns 403 for non-owned conversation
          const otherConversation = {
            _id: otherConvId,
            userId: otherEmail,
            title: 'Other user conversation',
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockFindOne.mockResolvedValue(otherConversation);

          const getResponse = await fetch(
            `http://localhost:${port}/api/conversations/${otherConvId.toHexString()}`
          );
          const getBody = await getResponse.json();

          expect(getResponse.status).toBe(403);
          expect(getBody.error).toBe('Access denied');
        } finally {
          close();
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: frontend-auth-admin, Property 9: Conversation message persistence preserves structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Validates: Requirements 7.1, 7.2, 7.3
   *
   * For any sequence of user and assistant messages appended to a conversation,
   * retrieving that conversation SHALL return all messages in order, each containing
   * a role field ("user" or "assistant"), a content field matching the original text,
   * and a timestamp field.
   */
  it('retrieving a conversation returns all messages in order with role, content, and timestamp fields preserved', async () => {
    await fc.assert(
      fc.asyncProperty(arbEmail(), arbTitle(), arbMessages(), async (email, title, messages) => {
        vi.clearAllMocks();

        const convId = new ObjectId();

        // Simulate a conversation document stored in the DB with the given messages
        const storedConversation = {
          _id: convId,
          userId: email,
          title,
          messages,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-06-01'),
        };

        mockFindOne.mockResolvedValue(storedConversation);

        const app = createTestApp({ email, name: 'Test User', role: 'user' });
        const { port, close } = startServer(app);

        try {
          const response = await fetch(
            `http://localhost:${port}/api/conversations/${convId.toHexString()}`
          );
          const body = await response.json();

          expect(response.status).toBe(200);

          // All messages are returned
          expect(body.messages).toHaveLength(messages.length);

          // Each message preserves structure: role, content, and timestamp
          for (let i = 0; i < messages.length; i++) {
            const returned = body.messages[i];
            const original = messages[i];

            // Role is preserved and is either "user" or "assistant"
            expect(returned.role).toBe(original.role);
            expect(['user', 'assistant']).toContain(returned.role);

            // Content matches the original text
            expect(returned.content).toBe(original.content);

            // Timestamp field exists
            expect(returned.timestamp).toBeDefined();
          }

          // Messages are in the same order as stored
          const returnedContents = body.messages.map((m) => m.content);
          const originalContents = messages.map((m) => m.content);
          expect(returnedContents).toEqual(originalContents);
        } finally {
          close();
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: frontend-auth-admin, Property 10: Conversation list is sorted by updatedAt descending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Validates: Requirements 8.1, 9.1
   *
   * For any set of conversations belonging to a user with distinct updatedAt
   * timestamps, GET /api/conversations SHALL return them in strictly descending
   * updatedAt order.
   */
  it('GET /api/conversations returns conversations in strictly descending updatedAt order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEmail(),
        arbConversationCount().chain((count) =>
          fc.tuple(fc.constant(count), arbDistinctDates(count))
        ),
        async (email, [count, dates]) => {
          vi.clearAllMocks();

          // Create conversations with distinct updatedAt timestamps in random order
          const conversations = dates.map((date, i) => ({
            _id: new ObjectId(),
            title: `Conversation ${i}`,
            updatedAt: date,
            createdAt: new Date('2024-01-01'),
          }));

          // Sort descending by updatedAt (simulating what the DB would return)
          const sortedConversations = [...conversations].sort(
            (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
          );

          mockFind.mockReturnValue({
            sort: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(sortedConversations),
            }),
          });

          const app = createTestApp({ email, name: 'Test User', role: 'user' });
          const { port, close } = startServer(app);

          try {
            const response = await fetch(`http://localhost:${port}/api/conversations`);
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body).toHaveLength(count);

            // Verify strictly descending updatedAt order
            for (let i = 0; i < body.length - 1; i++) {
              const currentUpdatedAt = new Date(body[i].updatedAt).getTime();
              const nextUpdatedAt = new Date(body[i + 1].updatedAt).getTime();
              expect(currentUpdatedAt).toBeGreaterThan(nextUpdatedAt);
            }

            // Verify the sort parameter was passed correctly to the DB query
            const sortCall = mockFind.mock.results[0].value.sort;
            expect(sortCall).toHaveBeenCalledWith({ updatedAt: -1 });
          } finally {
            close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
