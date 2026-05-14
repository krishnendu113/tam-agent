import { createMessage } from './llm.js';

/**
 * System prompt for persona detection.
 * Instructs the Haiku model to analyze conversation context and identify the client persona.
 */
export const PERSONA_SYSTEM_PROMPT = `You are a client persona detector for a Technical Account Manager (TAM) agent. Analyze the conversation history and determine the client's persona based on their communication style, technical level, and needs.

Respond with ONLY a JSON object in the following format, no other text:
{
  "persona": "one of: technical-lead, developer, project-manager, executive, support-user, unknown",
  "confidence": 0.0 to 1.0,
  "traits": ["trait1", "trait2"]
}

Persona definitions:
- "technical-lead": Uses technical jargon, asks about architecture, system design, or infrastructure
- "developer": Asks about code, APIs, debugging, or implementation details
- "project-manager": Focuses on timelines, status updates, blockers, and coordination
- "executive": Asks high-level questions about impact, costs, or strategic decisions
- "support-user": Asks basic how-to questions, reports issues, needs step-by-step guidance
- "unknown": Cannot determine persona from available context

Traits should describe observable communication characteristics (e.g., "concise", "detail-oriented", "urgent", "technical", "non-technical").`;

/**
 * Default persona returned when detection fails or no messages are available.
 */
export const DEFAULT_PERSONA = {
  persona: 'unknown',
  confidence: 0,
  traits: [],
};

/**
 * Validates that a parsed object has the expected persona result structure.
 *
 * @param {object} parsed - Parsed JSON object
 * @returns {object|null} Validated result or null if invalid
 */
export function validatePersonaResult(parsed) {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  if (typeof parsed.persona !== 'string' || parsed.persona.length === 0) {
    return null;
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;

  return {
    persona: parsed.persona,
    confidence,
    traits: Array.isArray(parsed.traits) ? parsed.traits : [],
  };
}

/**
 * Parses the LLM response text into a structured persona result.
 *
 * @param {object} response - Normalized LLM response from createMessage
 * @returns {object|null} Parsed result or null if parsing fails
 */
export function parsePersonaResponse(response) {
  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    return null;
  }

  const text = textBlock.text.trim();

  try {
    const parsed = JSON.parse(text);
    return validatePersonaResult(parsed);
  } catch {
    // Try extracting JSON from within the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return validatePersonaResult(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Formats conversation messages into a concise summary for persona detection.
 * Takes the most recent messages to keep the context focused.
 *
 * @param {Array} messages - Conversation history
 * @returns {string} Formatted conversation summary
 */
function formatMessagesForDetection(messages) {
  // Take the last 10 messages to keep context manageable
  const recentMessages = messages.slice(-10);

  return recentMessages
    .map(msg => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
          : '';
      return `${role}: ${content}`;
    })
    .join('\n');
}

/**
 * Detects the client persona from conversation context.
 * Uses Haiku model via the LLM abstraction for fast classification.
 *
 * Returns a default persona on failure to avoid blocking the pipeline.
 *
 * @param {Array} messages - Conversation history
 * @returns {Promise<{ persona: string, confidence: number, traits: string[] }>}
 */
export async function detectPersona(messages) {
  // Return default if no messages provided
  if (!messages || messages.length === 0) {
    return { ...DEFAULT_PERSONA };
  }

  const conversationSummary = formatMessagesForDetection(messages);

  try {
    const response = await createMessage({
      model: 'haiku',
      system: PERSONA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Analyze this conversation and detect the client persona:\n\n${conversationSummary}` }],
      maxTokens: 256,
    });

    const result = parsePersonaResponse(response);

    if (result) {
      return result;
    }

    // Parse failure — return default
    console.warn('[ClientPersona] Failed to parse LLM response, returning default persona');
    return { ...DEFAULT_PERSONA };
  } catch (error) {
    // LLM call failure — return default
    console.warn('[ClientPersona] LLM call failed, returning default persona:', error.message);
    return { ...DEFAULT_PERSONA };
  }
}
