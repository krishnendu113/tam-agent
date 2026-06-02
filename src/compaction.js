/**
 * Context Compaction module.
 * Estimates token usage and summarizes older messages when the context window threshold is exceeded.
 * Uses the LLM Abstraction (Haiku model) for summarization.
 *
 * Exports:
 * - estimateTokenCount(messages) — character-based token estimation (4 chars ≈ 1 token)
 * - shouldCompact(messages, threshold) — returns true iff estimated tokens exceed threshold
 * - compactHistory(messages, preserveTurns) — summarizes older turns via Haiku
 * - buildCompactedContext(compactedSummary, recentMessages) — assembles context for LLM
 * - MAX_CONTEXT_TOKENS — maximum context window token count
 * - compactContext (legacy) — retained for backward compatibility
 */

import { createMessage } from './llm.js';

/**
 * Maximum context tokens for Claude's context window.
 * Used as the denominator for threshold-based compaction decisions.
 */
export const MAX_CONTEXT_TOKENS = 200000;

/**
 * Read compaction threshold from environment (percentage, default 75).
 */
function getCompactionThreshold() {
  const envVal = process.env.CONTEXT_COMPACTION_THRESHOLD;
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      return parsed;
    }
  }
  return 75;
}

/**
 * Read preserve turns from environment (default 5).
 */
function getPreserveTurns() {
  const envVal = process.env.CONTEXT_COMPACTION_PRESERVE_TURNS;
  if (envVal !== undefined && envVal !== '') {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 5;
}

/**
 * Default token threshold for triggering compaction (legacy).
 * Kept for backward compatibility with existing tests.
 */
export const DEFAULT_TOKEN_THRESHOLD = 100000;

/**
 * Rough token estimation — approximately 4 characters per token.
 * Sums all message content character lengths, divides by 4.
 *
 * @param {Array<{role: string, content: string|Array}>} messages - Conversation messages
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(messages) {
  let totalChars = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
    } else {
      totalChars += JSON.stringify(message.content).length;
    }
  }
  return Math.ceil(totalChars / 4);
}

/**
 * Determines whether compaction should be triggered.
 * Returns true iff estimated token count exceeds (threshold/100) * MAX_CONTEXT_TOKENS.
 *
 * This is a pure deterministic function of message content and threshold.
 *
 * @param {Array<{role: string, content: string|Array}>} messages - Conversation messages
 * @param {number} [threshold] - Percentage threshold (0-100). Defaults to CONTEXT_COMPACTION_THRESHOLD env or 75.
 * @returns {boolean} Whether compaction should be triggered
 */
export function shouldCompact(messages, threshold) {
  const effectiveThreshold = threshold !== undefined ? threshold : getCompactionThreshold();
  const tokenCount = estimateTokenCount(messages);
  const maxAllowed = (effectiveThreshold / 100) * MAX_CONTEXT_TOKENS;
  return tokenCount > maxAllowed;
}

/**
 * Compacts conversation history by summarizing older turns using the Haiku model.
 * Preserves the last `preserveTurns` messages verbatim and summarizes the rest.
 *
 * The summary preserves key facts, decisions, tool results, and contextual references.
 *
 * @param {Array<{role: string, content: string|Array}>} messages - Full conversation history
 * @param {number} [preserveTurns] - Number of recent turns to keep verbatim. Defaults to CONTEXT_COMPACTION_PRESERVE_TURNS env or 5.
 * @returns {Promise<{summary: string, recentMessages: Array, olderMessages: Array}>} Compacted result
 */
export async function compactHistory(messages, preserveTurns) {
  const effectivePreserveTurns = preserveTurns !== undefined ? preserveTurns : getPreserveTurns();

  // If messages are fewer than or equal to preserveTurns, nothing to compact
  if (messages.length <= effectivePreserveTurns) {
    return {
      summary: '',
      recentMessages: [...messages],
      olderMessages: [],
    };
  }

  const splitIndex = messages.length - effectivePreserveTurns;
  const olderMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  // Summarize older messages using Haiku with enhanced prompt
  const summary = await summarizeMessages(olderMessages, {
    systemPrompt: 'Summarize the following conversation concisely, preserving key facts, decisions, tool call results, and contextual references that would be needed to continue the conversation. Focus on retaining actionable information.',
    maxTokens: 1024,
  });

  return {
    summary,
    recentMessages,
    olderMessages,
  };
}

/**
 * Assembles a compacted context array for the LLM.
 * Returns a new messages array with [system summary message] + recent messages.
 *
 * @param {string} compactedSummary - The Haiku-generated summary of older turns
 * @param {Array<{role: string, content: string|Array}>} recentMessages - Recent messages to preserve verbatim
 * @returns {Array<{role: string, content: string|Array}>} Assembled context for LLM
 */
export function buildCompactedContext(compactedSummary, recentMessages) {
  const summaryMessage = {
    role: 'user',
    content: `[Previous conversation summary: ${compactedSummary}]`,
  };

  const acknowledgement = {
    role: 'assistant',
    content: 'I understand the context from our previous conversation. How can I help you now?',
  };

  return [summaryMessage, acknowledgement, ...recentMessages];
}

/**
 * Summarizes a set of messages using the Haiku model.
 * The summary preserves key facts, user decisions, tool call results, and contextual references.
 *
 * @param {Array<{role: string, content: string|Array}>} messages - Messages to summarize
 * @param {Object} [options] - Options for summarization
 * @param {string} [options.systemPrompt] - Custom system prompt
 * @param {number} [options.maxTokens] - Max tokens for response
 * @returns {Promise<string>} Summary text
 */
async function summarizeMessages(messages, options = {}) {
  const {
    systemPrompt = 'Summarize the following conversation concisely, preserving key facts, decisions, and context that would be needed to continue the conversation.',
    maxTokens = 512,
  } = options;

  const formattedMessages = messages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');

  const response = await createMessage({
    model: 'haiku',
    system: systemPrompt,
    messages: [{ role: 'user', content: formattedMessages }],
    maxTokens,
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : 'Previous conversation context.';
}

// =====================================================================
// Legacy API — retained for backward compatibility with existing tests
// =====================================================================

/**
 * Compacts conversation history by summarizing older messages (legacy API).
 * Preserves the full history in the database while returning a compacted version for LLM context.
 *
 * @param {Object} options
 * @param {Array} options.messages - Full conversation history
 * @param {number} [options.threshold] - Token threshold for triggering compaction
 * @param {Function} [options.onStatus] - Callback for status notifications
 * @returns {Promise<{ messages: Array, wasCompacted: boolean, fullHistory: Array }>}
 */
export async function compactContext({ messages, threshold = DEFAULT_TOKEN_THRESHOLD, onStatus }) {
  const estimatedTokens = estimateTokenCount(messages);

  if (estimatedTokens <= threshold) {
    return { messages, wasCompacted: false, fullHistory: messages };
  }

  // Invoke onStatus if provided
  if (onStatus) {
    onStatus('Compacting conversation context...');
  }

  // Split messages: keep recent messages, summarize older ones
  const recentCount = Math.min(4, messages.length);
  const olderMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);

  // Summarize older messages using Haiku
  const summary = await summarizeMessages(olderMessages);

  // Build compacted messages: summary + recent messages
  const compactedMessages = [
    { role: 'user', content: `[Previous conversation summary: ${summary}]` },
    { role: 'assistant', content: 'I understand the context from our previous conversation. How can I help you now?' },
    ...recentMessages,
  ];

  if (onStatus) {
    onStatus(`Context compacted: ${messages.length} messages → ${compactedMessages.length} messages`);
  }

  return {
    messages: compactedMessages,
    wasCompacted: true,
    fullHistory: messages, // Full history preserved for database storage
  };
}
