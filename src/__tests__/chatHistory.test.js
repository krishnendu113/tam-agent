/**
 * Unit tests for src/tools/chatHistory.js — lookup_chat_history and get_session_summary tools
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  lookupChatHistoryTool,
  getSessionSummaryTool,
  sessionStore
} from '../tools/chatHistory.js';

describe('chatHistory tools', () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  describe('lookupChatHistoryTool', () => {
    it('has correct tool metadata', () => {
      expect(lookupChatHistoryTool.name).toBe('lookup_chat_history');
      expect(lookupChatHistoryTool.tags).toEqual(['history']);
      expect(lookupChatHistoryTool.inputSchema.required).toContain('sessionId');
      expect(lookupChatHistoryTool.inputSchema.properties).toHaveProperty('startTurn');
      expect(lookupChatHistoryTool.inputSchema.properties).toHaveProperty('endTurn');
      expect(lookupChatHistoryTool.inputSchema.properties).toHaveProperty('searchTerm');
    });

    it('returns error when sessionId is not provided', async () => {
      const result = await lookupChatHistoryTool.handler({});
      expect(result.error).toBeTruthy();
    });

    it('returns error when sessionId is empty string', async () => {
      const result = await lookupChatHistoryTool.handler({ sessionId: '' });
      expect(result.error).toBeTruthy();
    });

    it('returns error when sessionId is not a string', async () => {
      const result = await lookupChatHistoryTool.handler({ sessionId: 123 });
      expect(result.error).toBeTruthy();
    });

    it('returns error when session does not exist', async () => {
      const result = await lookupChatHistoryTool.handler({ sessionId: 'nonexistent' });
      expect(result.error).toMatch(/not found/i);
    });

    it('returns all messages when no filter is provided', async () => {
      sessionStore.setSession('sess-1', {
        messages: [
          { role: 'user', content: 'Hello', turnNumber: 1, timestamp: '2024-01-01T00:00:00Z' },
          { role: 'assistant', content: 'Hi there', turnNumber: 2, timestamp: '2024-01-01T00:00:01Z' }
        ],
        compactionEvents: [],
        contextUtilization: 10
      });

      const result = await lookupChatHistoryTool.handler({ sessionId: 'sess-1' });
      expect(result.error).toBeUndefined();
      expect(result.sessionId).toBe('sess-1');
      expect(result.matchCount).toBe(2);
      expect(result.messages).toHaveLength(2);
    });

    describe('search by term', () => {
      beforeEach(() => {
        sessionStore.setSession('sess-search', {
          messages: [
            { role: 'user', content: 'Tell me about AWS Lambda', turnNumber: 1, timestamp: '2024-01-01T00:00:00Z' },
            { role: 'assistant', content: 'Lambda is a serverless compute service', turnNumber: 2, timestamp: '2024-01-01T00:00:01Z' },
            { role: 'user', content: 'What about DynamoDB?', turnNumber: 3, timestamp: '2024-01-01T00:00:02Z' },
            { role: 'assistant', content: 'DynamoDB is a NoSQL database', turnNumber: 4, timestamp: '2024-01-01T00:00:03Z' }
          ],
          compactionEvents: [],
          contextUtilization: 20
        });
      });

      it('performs case-insensitive substring match', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-search',
          searchTerm: 'lambda'
        });

        expect(result.error).toBeUndefined();
        expect(result.searchTerm).toBe('lambda');
        expect(result.matchCount).toBe(2);
        expect(result.messages[0].turnNumber).toBe(1);
        expect(result.messages[1].turnNumber).toBe(2);
      });

      it('returns matching messages with turn numbers and timestamps', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-search',
          searchTerm: 'dynamodb'
        });

        expect(result.matchCount).toBe(2);
        for (const msg of result.messages) {
          expect(msg).toHaveProperty('role');
          expect(msg).toHaveProperty('content');
          expect(msg).toHaveProperty('turnNumber');
          expect(msg).toHaveProperty('timestamp');
        }
      });

      it('returns empty results when search term not found', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-search',
          searchTerm: 'kubernetes'
        });

        expect(result.matchCount).toBe(0);
        expect(result.messages).toHaveLength(0);
      });

      it('handles search term with mixed case', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-search',
          searchTerm: 'LAMBDA'
        });

        expect(result.matchCount).toBe(2);
      });
    });

    describe('range query', () => {
      beforeEach(() => {
        sessionStore.setSession('sess-range', {
          messages: [
            { role: 'user', content: 'Turn 1', turnNumber: 1, timestamp: '2024-01-01T00:00:00Z' },
            { role: 'assistant', content: 'Turn 2', turnNumber: 2, timestamp: '2024-01-01T00:00:01Z' },
            { role: 'user', content: 'Turn 3', turnNumber: 3, timestamp: '2024-01-01T00:00:02Z' },
            { role: 'assistant', content: 'Turn 4', turnNumber: 4, timestamp: '2024-01-01T00:00:03Z' },
            { role: 'user', content: 'Turn 5', turnNumber: 5, timestamp: '2024-01-01T00:00:04Z' }
          ],
          compactionEvents: [],
          contextUtilization: 30
        });
      });

      it('returns messages within specified turn range (inclusive)', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-range',
          startTurn: 2,
          endTurn: 4
        });

        expect(result.error).toBeUndefined();
        expect(result.startTurn).toBe(2);
        expect(result.endTurn).toBe(4);
        expect(result.matchCount).toBe(3);
        expect(result.messages[0].turnNumber).toBe(2);
        expect(result.messages[1].turnNumber).toBe(3);
        expect(result.messages[2].turnNumber).toBe(4);
      });

      it('returns messages in order', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-range',
          startTurn: 1,
          endTurn: 5
        });

        for (let i = 0; i < result.messages.length - 1; i++) {
          expect(result.messages[i].turnNumber).toBeLessThan(result.messages[i + 1].turnNumber);
        }
      });

      it('handles startTurn only (defaults endTurn to last message)', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-range',
          startTurn: 4
        });

        expect(result.matchCount).toBe(2);
        expect(result.messages[0].turnNumber).toBe(4);
        expect(result.messages[1].turnNumber).toBe(5);
      });

      it('handles endTurn only (defaults startTurn to 1)', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-range',
          endTurn: 2
        });

        expect(result.matchCount).toBe(2);
        expect(result.messages[0].turnNumber).toBe(1);
        expect(result.messages[1].turnNumber).toBe(2);
      });

      it('returns empty for out-of-range turns', async () => {
        const result = await lookupChatHistoryTool.handler({
          sessionId: 'sess-range',
          startTurn: 10,
          endTurn: 15
        });

        expect(result.matchCount).toBe(0);
        expect(result.messages).toHaveLength(0);
      });
    });
  });

  describe('getSessionSummaryTool', () => {
    it('has correct tool metadata', () => {
      expect(getSessionSummaryTool.name).toBe('get_session_summary');
      expect(getSessionSummaryTool.tags).toEqual(['history']);
      expect(getSessionSummaryTool.inputSchema.required).toContain('sessionId');
    });

    it('returns error when sessionId is not provided', async () => {
      const result = await getSessionSummaryTool.handler({});
      expect(result.error).toBeTruthy();
    });

    it('returns error when sessionId is empty string', async () => {
      const result = await getSessionSummaryTool.handler({ sessionId: '' });
      expect(result.error).toBeTruthy();
    });

    it('returns error when sessionId is not a string', async () => {
      const result = await getSessionSummaryTool.handler({ sessionId: 42 });
      expect(result.error).toBeTruthy();
    });

    it('returns error when session does not exist', async () => {
      const result = await getSessionSummaryTool.handler({ sessionId: 'nonexistent' });
      expect(result.error).toMatch(/not found/i);
    });

    it('returns turn count, compaction events, and context utilization', async () => {
      sessionStore.setSession('sess-summary', {
        messages: [
          { role: 'user', content: 'Hello', turnNumber: 1, timestamp: '2024-01-01T00:00:00Z' },
          { role: 'assistant', content: 'Hi', turnNumber: 2, timestamp: '2024-01-01T00:00:01Z' },
          { role: 'user', content: 'How are you?', turnNumber: 3, timestamp: '2024-01-01T00:00:02Z' }
        ],
        compactionEvents: [
          {
            timestamp: '2024-01-01T00:01:00Z',
            turnRangeStart: 1,
            turnRangeEnd: 10,
            tokensBefore: 5000,
            tokensAfter: 1000
          }
        ],
        contextUtilization: 45.5
      });

      const result = await getSessionSummaryTool.handler({ sessionId: 'sess-summary' });
      expect(result.error).toBeUndefined();
      expect(result.sessionId).toBe('sess-summary');
      expect(result.turnCount).toBe(3);
      expect(result.compactionEvents).toHaveLength(1);
      expect(result.compactionEvents[0].timestamp).toBe('2024-01-01T00:01:00Z');
      expect(result.compactionEvents[0].turnRangeStart).toBe(1);
      expect(result.compactionEvents[0].turnRangeEnd).toBe(10);
      expect(result.currentContextUtilization).toBe(45.5);
    });

    it('returns zero values for a new session with no compaction', async () => {
      sessionStore.setSession('sess-new', {
        messages: [
          { role: 'user', content: 'First message', turnNumber: 1, timestamp: '2024-01-01T00:00:00Z' }
        ],
        compactionEvents: [],
        contextUtilization: 5
      });

      const result = await getSessionSummaryTool.handler({ sessionId: 'sess-new' });
      expect(result.turnCount).toBe(1);
      expect(result.compactionEvents).toHaveLength(0);
      expect(result.currentContextUtilization).toBe(5);
    });

    it('defaults contextUtilization to 0 when not set', async () => {
      sessionStore.setSession('sess-noutil', {
        messages: [],
        compactionEvents: []
      });

      const result = await getSessionSummaryTool.handler({ sessionId: 'sess-noutil' });
      expect(result.currentContextUtilization).toBe(0);
    });
  });

  describe('sessionStore', () => {
    it('can set and get sessions', () => {
      sessionStore.setSession('test-id', { messages: [], compactionEvents: [] });
      expect(sessionStore.hasSession('test-id')).toBe(true);
      expect(sessionStore.getSession('test-id')).toEqual({ messages: [], compactionEvents: [] });
    });

    it('returns undefined for non-existent sessions', () => {
      expect(sessionStore.getSession('no-such-id')).toBeUndefined();
    });

    it('clear removes all sessions', () => {
      sessionStore.setSession('a', { messages: [] });
      sessionStore.setSession('b', { messages: [] });
      sessionStore.clear();
      expect(sessionStore.hasSession('a')).toBe(false);
      expect(sessionStore.hasSession('b')).toBe(false);
    });
  });
});
