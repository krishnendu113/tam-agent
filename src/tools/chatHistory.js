/**
 * Chat History Tools - lookup_chat_history and get_session_summary.
 *
 * These tools allow the LLM to query original uncompacted chat history
 * from sessions. They use an in-memory session store that the agent loop
 * populates during operation.
 *
 * Exports:
 * - lookupChatHistoryTool — tool definition for lookup_chat_history
 * - getSessionSummaryTool — tool definition for get_session_summary
 * - sessionStore — in-memory session store for populating session data
 */

/**
 * In-memory session store.
 * The agent loop populates this with session data during operation.
 *
 * Structure:
 * sessionStore.sessions = Map<sessionId, SessionData>
 *
 * SessionData:
 * {
 *   messages: Array<{ role, content, turnNumber, timestamp }>,
 *   compactionEvents: Array<{ timestamp, turnRangeStart, turnRangeEnd, tokensBefore, tokensAfter }>,
 *   contextUtilization: number (percentage 0-100)
 * }
 */
export const sessionStore = {
  sessions: new Map(),

  /**
   * Register or update a session's data.
   * @param {string} sessionId
   * @param {object} data - { messages, compactionEvents, contextUtilization }
   */
  setSession(sessionId, data) {
    this.sessions.set(sessionId, data);
  },

  /**
   * Get session data by ID.
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  },

  /**
   * Check if a session exists.
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasSession(sessionId) {
    return this.sessions.has(sessionId);
  },

  /**
   * Clear all sessions (useful for testing).
   */
  clear() {
    this.sessions.clear();
  }
};

/**
 * Tool: lookup_chat_history
 *
 * Look up original uncompacted messages from the session history.
 * Supports search by term (case-insensitive substring match) and
 * range query by turn positions (inclusive).
 */
export const lookupChatHistoryTool = {
  name: 'lookup_chat_history',
  description: 'Look up original uncompacted messages from the session history. Use when you need verbatim details from earlier in the conversation.',
  tags: ['history'],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID to look up'
      },
      startTurn: {
        type: 'integer',
        description: 'Starting turn number (inclusive)'
      },
      endTurn: {
        type: 'integer',
        description: 'Ending turn number (inclusive)'
      },
      searchTerm: {
        type: 'string',
        description: 'Search for messages containing this text'
      }
    },
    required: ['sessionId']
  },
  async handler(input) {
    const { sessionId, startTurn, endTurn, searchTerm } = input;

    if (!sessionId || typeof sessionId !== 'string') {
      return { error: 'sessionId is required and must be a string.' };
    }

    if (!sessionStore.hasSession(sessionId)) {
      return { error: `Session "${sessionId}" not found.` };
    }

    const session = sessionStore.getSession(sessionId);
    let messages = session.messages || [];

    // Search by term: case-insensitive substring match
    if (searchTerm && typeof searchTerm === 'string') {
      const term = searchTerm.toLowerCase();
      messages = messages.filter(msg => {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        return content.toLowerCase().includes(term);
      });

      return {
        sessionId,
        searchTerm,
        matchCount: messages.length,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          turnNumber: msg.turnNumber,
          timestamp: msg.timestamp
        }))
      };
    }

    // Range query: return messages at specified turn positions (inclusive)
    if (startTurn !== undefined || endTurn !== undefined) {
      const start = startTurn !== undefined ? startTurn : 1;
      const end = endTurn !== undefined ? endTurn : messages.length;

      messages = messages.filter(msg =>
        msg.turnNumber >= start && msg.turnNumber <= end
      );

      return {
        sessionId,
        startTurn: start,
        endTurn: end,
        matchCount: messages.length,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          turnNumber: msg.turnNumber,
          timestamp: msg.timestamp
        }))
      };
    }

    // No filter — return all messages
    return {
      sessionId,
      matchCount: messages.length,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        turnNumber: msg.turnNumber,
        timestamp: msg.timestamp
      }))
    };
  }
};

/**
 * Tool: get_session_summary
 *
 * Returns metadata about the current session including turn count,
 * compaction events, and context utilization.
 */
export const getSessionSummaryTool = {
  name: 'get_session_summary',
  description: 'Get metadata about the current session including turn count, compaction history, and context utilization.',
  tags: ['history'],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID'
      }
    },
    required: ['sessionId']
  },
  async handler(input) {
    const { sessionId } = input;

    if (!sessionId || typeof sessionId !== 'string') {
      return { error: 'sessionId is required and must be a string.' };
    }

    if (!sessionStore.hasSession(sessionId)) {
      return { error: `Session "${sessionId}" not found.` };
    }

    const session = sessionStore.getSession(sessionId);
    const messages = session.messages || [];
    const compactionEvents = session.compactionEvents || [];
    const contextUtilization = session.contextUtilization !== undefined
      ? session.contextUtilization
      : 0;

    return {
      sessionId,
      turnCount: messages.length,
      compactionEvents,
      currentContextUtilization: contextUtilization
    };
  }
};

export default { lookupChatHistoryTool, getSessionSummaryTool, sessionStore };
