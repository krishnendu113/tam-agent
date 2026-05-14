import { createMessage } from './llm.js';

/**
 * System prompt for the preflight classification LLM call.
 * Instructs the Haiku model to classify the user's query and return structured JSON.
 */
export const PREFLIGHT_SYSTEM_PROMPT = `You are a query classifier for a Technical Account Manager (TAM) agent. Your job is to analyze the user's message and determine:

1. Whether the query is on-topic (related to technical support, troubleshooting, Jira, Confluence, documentation, or account management)
2. The user's intent (a brief description of what they want to accomplish)
3. Which tool tags are needed to fulfill the request (e.g., "jira", "confluence", "kapa", "webSearch")
4. Which skill IDs are relevant (e.g., "troubleshooting")

Respond with ONLY a JSON object in the following format, no other text:
{
  "onTopic": true or false,
  "intent": "brief description of the user's intent",
  "toolTags": ["tag1", "tag2"],
  "skillIds": ["skill1", "skill2"]
}

If the query is off-topic (e.g., casual chat, unrelated questions, harmful content), set onTopic to false and leave toolTags and skillIds as empty arrays.`;

/**
 * Fail-open default result used when preflight parsing fails.
 * Treats the query as on-topic to avoid blocking legitimate requests.
 */
export const FAIL_OPEN_RESULT = {
  onTopic: true,
  intent: 'unknown',
  toolTags: [],
  skillIds: [],
};

/**
 * Validates that a parsed object has the expected preflight result structure.
 *
 * @param {object} parsed - Parsed JSON object
 * @returns {object|null} Validated result or null if invalid
 */
export function validatePreflightResult(parsed) {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  if (typeof parsed.onTopic !== 'boolean') {
    return null;
  }

  return {
    onTopic: parsed.onTopic,
    intent: typeof parsed.intent === 'string' ? parsed.intent : 'unknown',
    toolTags: Array.isArray(parsed.toolTags) ? parsed.toolTags : [],
    skillIds: Array.isArray(parsed.skillIds) ? parsed.skillIds : [],
  };
}

/**
 * Parses the LLM response text into a structured preflight result.
 * Attempts to extract JSON from the response content.
 *
 * @param {object} response - Normalized LLM response from createMessage
 * @returns {object|null} Parsed result or null if parsing fails
 */
export function parsePreflightResponse(response) {
  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    return null;
  }

  const text = textBlock.text.trim();

  try {
    const parsed = JSON.parse(text);
    return validatePreflightResult(parsed);
  } catch {
    // Try extracting JSON from within the text (e.g., wrapped in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return validatePreflightResult(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Classifies a user query for topic relevance and intent.
 * Uses Haiku model via the LLM abstraction for fast classification.
 *
 * Fail-open behavior: if the LLM call fails or the response cannot be parsed,
 * the query is treated as on-topic to avoid blocking legitimate requests.
 *
 * @param {string} query - The user's message
 * @returns {Promise<{ onTopic: boolean, intent: string, toolTags: string[], skillIds: string[] }>}
 */
export async function classifyQuery(query) {
  try {
    const response = await createMessage({
      model: 'haiku',
      system: PREFLIGHT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: query }],
      maxTokens: 256,
    });

    const result = parsePreflightResponse(response);

    if (result) {
      return result;
    }

    // Parse failure — fail-open
    console.warn('[Preflight] Failed to parse LLM response, treating as on-topic (fail-open)');
    return { ...FAIL_OPEN_RESULT };
  } catch (error) {
    // LLM call failure — fail-open
    console.warn('[Preflight] LLM call failed, treating as on-topic (fail-open):', error.message);
    return { ...FAIL_OPEN_RESULT };
  }
}
