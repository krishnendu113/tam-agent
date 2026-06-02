import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { lookupChatHistoryTool, sessionStore } from '../tools/chatHistory.js';

// --- Generators ---

/**
 * Generates a single message object with a specified turnNumber.
 */
function arbMessageAtTurn(turnNumber) {
  return fc.record({
    role: fc.constantFrom('user', 'assistant'),
    content: fc.string({ minLength: 1, maxLength: 200 }),
    turnNumber: fc.constant(turnNumber),
    timestamp: fc.constant(`2024-01-01T00:00:${String(turnNumber).padStart(2, '0')}Z`),
  });
}

/**
 * Generates a session with N messages (sequential turnNumbers 1..N)
 * and a valid [startTurn, endTurn] range within [1, N].
 *
 * Returns { messages, startTurn, endTurn, sessionId }.
 */
function arbSessionWithRange() {
  return fc
    .integer({ min: 1, max: 30 })
    .chain((n) => {
      // Generate N messages with sequential turn numbers 1..N
      const messagesArb = fc.tuple(
        ...Array.from({ length: n }, (_, i) => arbMessageAtTurn(i + 1))
      );

      // Generate a valid range [startTurn, endTurn] where 1 <= startTurn <= endTurn <= N
      const rangeArb = fc
        .integer({ min: 1, max: n })
        .chain((startTurn) =>
          fc
            .integer({ min: startTurn, max: n })
            .map((endTurn) => ({ startTurn, endTurn }))
        );

      return fc.tuple(messagesArb, rangeArb).map(([messages, range]) => ({
        messages,
        startTurn: range.startTurn,
        endTurn: range.endTurn,
        sessionId: 'prop-range-session',
      }));
    });
}

// --- Property Tests ---

describe('Feature: skill-system-enhancement, Property 15: Chat History Range Query Returns Correct Slice', () => {
  afterEach(() => {
    sessionStore.clear();
  });

  /**
   * **Validates: Requirements 8.9**
   *
   * For any valid range [startTurn, endTurn], lookup_chat_history SHALL return
   * exactly messages at those turn positions (inclusive), in order.
   */
  it('returns exactly the messages at turn positions [startTurn, endTurn] inclusive, in ascending order', async () => {
    await fc.assert(
      fc.asyncProperty(arbSessionWithRange(), async ({ messages, startTurn, endTurn, sessionId }) => {
        // Set up the session store with messages
        sessionStore.clear();
        sessionStore.setSession(sessionId, {
          messages,
          compactionEvents: [],
          contextUtilization: 0,
        });

        // Call the handler with the range query
        const result = await lookupChatHistoryTool.handler({
          sessionId,
          startTurn,
          endTurn,
        });

        // Expected: messages with turnNumbers in [startTurn, endTurn]
        const expectedMessages = messages.filter(
          (msg) => msg.turnNumber >= startTurn && msg.turnNumber <= endTurn
        );

        // Verify: correct count
        expect(result.matchCount).toBe(expectedMessages.length);
        expect(result.messages.length).toBe(expectedMessages.length);

        // Verify: exact messages at turn positions (content, role, turnNumber, timestamp)
        for (let i = 0; i < expectedMessages.length; i++) {
          expect(result.messages[i].turnNumber).toBe(expectedMessages[i].turnNumber);
          expect(result.messages[i].content).toBe(expectedMessages[i].content);
          expect(result.messages[i].role).toBe(expectedMessages[i].role);
          expect(result.messages[i].timestamp).toBe(expectedMessages[i].timestamp);
        }

        // Verify: messages are returned in ascending turnNumber order
        for (let i = 0; i < result.messages.length - 1; i++) {
          expect(result.messages[i].turnNumber).toBeLessThan(
            result.messages[i + 1].turnNumber
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});
