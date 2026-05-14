/**
 * Context Compaction module.
 * Estimates token usage and summarizes older messages when the context window threshold is exceeded.
 * Uses the LLM Abstraction (Haiku model) for summarization.
 */

import { createMessage } from './llm.js';

/**
 * Default token threshold for triggering compaction.
 * When estimated tokens exceed this, older messages are summarized.
 */
export const DEFAULT_TOKEN_THRESHOLD = 100000;

/**
 * Rough token estimation — approximately 4 characters per token.
 * @param {Array} messages - Conversation messages
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
 * Compacts conversation history by summarizing older messages.
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

/**
 * Summarizes a set of messages using the Haiku model.
 * @param {Array} messages - Messages to summarize
 * @returns {Promise<string>} Summary text
 */
async function summarizeMessages(messages) {
  const formattedMessages = messages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');

  const response = await createMessage({
    model: 'haiku',
    system: 'Summarize the following conversation concisely, preserving key facts, decisions, and context that would be needed to continue the conversation.',
    messages: [{ role: 'user', content: formattedMessages }],
    maxTokens: 512,
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : 'Previous conversation context.';
}
