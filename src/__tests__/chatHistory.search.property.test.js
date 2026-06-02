import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { lookupChatHistoryTool, sessionStore } from '../tools/chatHistory.js';

// --- Generators ---

/**
 * Generates a random message with role, content, turnNumber, and timestamp.
 */
function arbMessage(turnNumber) {
  return fc.record({
    role: fc.constantFrom('user', 'assistant'),
    content: fc.string({ minLength: 1, maxLength: 500 }),
    turnNumber: fc.constant(turnNumber),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
      .map(d => d.toISOString())
  });
}

/**
 * Generates an array of messages with sequential turn numbers.
 */
function arbMessages() {
  return fc.integer({ min: 1, max: 20 }).chain(n =>
    fc.tuple(...Array.from({ length: n }, (_, i) => arbMessage(i + 1)))
  );
}

/**
 * Generates a non-empty search term (1-20 chars, printable ASCII to avoid
 * regex-like or locale-dependent edge cases).
 */
function arbSearchTerm() {
  return fc.stringOf(
    fc.char().filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126),
    { minLength: 1, maxLength: 20 }
  );
}

// --- Property Tests ---

describe('Property 14: Chat History Search Returns Exact Matches', () => {
  afterEach(() => {
    sessionStore.clear();
  });

  /**
   * **Validates: Requirements 8.8**
   *
   * For any session with N messages and any search term, lookup_chat_history SHALL
   * return exactly those messages whose content contains the search term
   * (case-insensitive substring match), with correct turn numbers.
   */
  it('lookup_chat_history with searchTerm returns exactly messages whose content contains the term (case-insensitive)', () => {
    fc.assert(
      fc.asyncProperty(arbMessages(), arbSearchTerm(), async (messages, searchTerm) => {
        const sessionId = 'prop-test-session';

        // Populate the session store
        sessionStore.setSession(sessionId, {
          messages,
          compactionEvents: [],
          contextUtilization: 0
        });

        // Call the handler with the search term
        const result = await lookupChatHistoryTool.handler({ sessionId, searchTerm });

        // Compute the expected matches: messages whose content contains the term (case-insensitive)
        const termLower = searchTerm.toLowerCase();
        const expectedMessages = messages.filter(msg => {
          const content = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
          return content.toLowerCase().includes(termLower);
        });

        // Verify: returned count matches expected count
        expect(result.matchCount).toBe(expectedMessages.length);
        expect(result.messages).toHaveLength(expectedMessages.length);

        // Verify: each returned message has correct turnNumber and timestamp
        for (let i = 0; i < result.messages.length; i++) {
          const returned = result.messages[i];
          const expected = expectedMessages[i];

          expect(returned.turnNumber).toBe(expected.turnNumber);
          expect(returned.timestamp).toBe(expected.timestamp);
          expect(returned.role).toBe(expected.role);
          expect(returned.content).toBe(expected.content);
        }

        // Verify: no message that should have matched is missing
        // (covered by length check + ordered comparison above)

        // Cleanup for next iteration
        sessionStore.clear();
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 8.8**
   *
   * For any session where a known substring is injected into specific messages,
   * lookup_chat_history SHALL return exactly those injected messages.
   */
  it('lookup_chat_history finds messages with a known injected term regardless of case', () => {
    fc.assert(
      fc.asyncProperty(
        arbMessages(),
        arbSearchTerm(),
        fc.constantFrom('lower', 'upper', 'mixed'),
        async (messages, baseTerm, caseStyle) => {
          const sessionId = 'prop-test-inject';

          // Decide which messages will contain the term (at least 1 if possible)
          const injectIndices = new Set();
          for (let i = 0; i < messages.length; i++) {
            if (i % 2 === 0) injectIndices.add(i);
          }

          // Apply case transformation to the injected term
          let injectedTerm;
          if (caseStyle === 'lower') injectedTerm = baseTerm.toLowerCase();
          else if (caseStyle === 'upper') injectedTerm = baseTerm.toUpperCase();
          else injectedTerm = baseTerm.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join('');

          // Inject term into selected messages
          const modifiedMessages = messages.map((msg, i) => {
            if (injectIndices.has(i)) {
              return { ...msg, content: msg.content + injectedTerm };
            }
            return msg;
          });

          sessionStore.setSession(sessionId, {
            messages: modifiedMessages,
            compactionEvents: [],
            contextUtilization: 0
          });

          // Search with the original baseTerm (case-insensitive should still match)
          const result = await lookupChatHistoryTool.handler({
            sessionId,
            searchTerm: baseTerm
          });

          // The result should include at least all injected messages
          // (and possibly others if they happened to contain the term naturally)
          const termLower = baseTerm.toLowerCase();
          const expectedMessages = modifiedMessages.filter(msg => {
            const content = typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content);
            return content.toLowerCase().includes(termLower);
          });

          expect(result.matchCount).toBe(expectedMessages.length);
          expect(result.messages).toHaveLength(expectedMessages.length);

          // All injected messages should be in the results
          for (const idx of injectIndices) {
            const injectedMsg = modifiedMessages[idx];
            const found = result.messages.some(
              m => m.turnNumber === injectedMsg.turnNumber
            );
            expect(found).toBe(true);
          }

          sessionStore.clear();
        }
      ),
      { numRuns: 200 }
    );
  });
});
