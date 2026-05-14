import { createMessage, streamMessage } from './llm.js';
import { executeTool, getToolDefinitions } from './tools/index.js';

/**
 * Maximum number of tool-calling turns per research agent.
 */
const MAX_RESEARCH_TURNS = 5;

/**
 * Reformulates a user query for better search results.
 * Uses Haiku model for fast query reformulation.
 *
 * @param {string} originalQuery - The user's original query
 * @param {string} domain - The search domain (jira, confluence, docs, web)
 * @returns {Promise<string>} Reformulated query optimized for the domain
 */
export async function reformulateQuery(originalQuery, domain) {
  try {
    const response = await createMessage({
      model: 'haiku',
      system: `You are a query reformulation expert. Rewrite the following query to be more effective for searching ${domain}. Return ONLY the reformulated query, nothing else.`,
      messages: [{ role: 'user', content: originalQuery }],
      maxTokens: 128,
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text.trim() : originalQuery;
  } catch {
    // On any error, fall back to the original query
    return originalQuery;
  }
}

/**
 * System prompt template for research agents.
 * @param {string} domain - The research domain
 * @returns {string} System prompt for the research agent
 */
function getDefaultSystemPrompt(domain) {
  return `You are a research sub-agent specializing in ${domain} searches. Your job is to find relevant information for the user's query using the available tools.

Instructions:
- Use the provided tools to search for relevant information
- Summarize your findings as a structured JSON object
- Be concise and focus on the most relevant results
- If no relevant results are found, indicate that clearly

Respond with a JSON summary of your findings in this format:
{
  "domain": "${domain}",
  "found": true/false,
  "summary": "brief summary of findings",
  "details": [array of relevant items/results]
}`;
}

/**
 * Runs a research agent with multi-turn tool calling.
 * Uses createMessage from the LLM abstraction (NOT Anthropic SDK).
 *
 * @param {Object} options
 * @param {string} options.query - The search query
 * @param {string} options.domain - The research domain
 * @param {Array} [options.tools] - Available tools for this domain
 * @param {string} [options.systemPrompt] - Custom system prompt
 * @returns {Promise<{ summary: string, sources: Array, success: boolean }>}
 */
export async function runResearchAgent({ query, domain, tools, systemPrompt }) {
  // 1. Reformulate query for the domain
  const reformulatedQuery = await reformulateQuery(query, domain);

  // 2. Resolve tools — use provided tools or get defaults for the domain
  const resolvedTools = tools || getToolDefinitions([domain]);

  // 3. Build messages with reformulated query
  const system = systemPrompt || getDefaultSystemPrompt(domain);
  const messages = [{ role: 'user', content: reformulatedQuery }];

  // 4. Multi-turn loop: call createMessage, execute tools, append results
  let turn = 0;

  while (turn < MAX_RESEARCH_TURNS) {
    const response = await createMessage({
      model: 'haiku',
      system,
      messages,
      tools: resolvedTools.length > 0 ? resolvedTools : undefined,
      maxTokens: 1024,
    });

    // Check if the LLM wants to use a tool
    const toolUseBlock = response.content.find(block => block.type === 'tool_use');

    if (toolUseBlock && response.stop_reason === 'tool_use') {
      // Execute the tool
      let toolResult;
      try {
        toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input);
      } catch (toolError) {
        toolResult = { error: toolError.message };
      }

      // Append assistant response and tool result to messages for next turn
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify(toolResult),
        }],
      });

      turn++;
    } else {
      // LLM returned a text response — extract the summary
      const textBlock = response.content.find(block => block.type === 'text');
      const text = textBlock ? textBlock.text : '';

      // Try to parse as JSON for structured sources
      let sources = [];
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          sources = parsed.details || [];
        }
      } catch {
        // Fall through — no structured sources
      }

      return {
        summary: text,
        sources,
        success: text.length > 0,
      };
    }
  }

  // Max turns reached — return what we have
  return {
    summary: `Research for ${domain} reached maximum turns without a final answer.`,
    sources: [],
    success: false,
  };
}

/**
 * Runs a streaming research agent for real-time output.
 * Uses streamMessage from the LLM abstraction.
 *
 * @param {Object} options - Same as runResearchAgent
 * @param {Function} onToken - Callback for streaming tokens
 * @returns {Promise<{ summary: string, sources: Array, success: boolean }>}
 */
export async function runStreamingResearchAgent({ query, domain, tools, systemPrompt }, onToken) {
  // 1. Reformulate query for the domain
  const reformulatedQuery = await reformulateQuery(query, domain);

  // 2. Resolve tools
  const resolvedTools = tools || getToolDefinitions([domain]);

  // 3. Build messages with reformulated query
  const system = systemPrompt || getDefaultSystemPrompt(domain);
  const messages = [{ role: 'user', content: reformulatedQuery }];

  // 4. Multi-turn loop using streamMessage
  let turn = 0;

  while (turn < MAX_RESEARCH_TURNS) {
    const stream = streamMessage({
      model: 'haiku',
      system,
      messages,
      tools: resolvedTools.length > 0 ? resolvedTools : undefined,
      maxTokens: 1024,
    });

    let fullResponse = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'text':
          if (onToken) onToken(event.text);
          break;
        case 'message_complete':
          fullResponse = event.response;
          break;
        case 'error':
          return {
            summary: `Stream error: ${event.error.message}`,
            sources: [],
            success: false,
          };
      }
    }

    if (!fullResponse) break;

    // Check if the LLM wants to use a tool
    const toolUseBlock = fullResponse.content.find(block => block.type === 'tool_use');

    if (toolUseBlock && fullResponse.stop_reason === 'tool_use') {
      // Execute the tool
      let toolResult;
      try {
        toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input);
      } catch (toolError) {
        toolResult = { error: toolError.message };
      }

      // Append assistant response and tool result to messages for next turn
      messages.push({ role: 'assistant', content: fullResponse.content });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify(toolResult),
        }],
      });

      turn++;
    } else {
      // LLM returned a text response — extract the summary
      const textBlock = fullResponse.content.find(block => block.type === 'text');
      const text = textBlock ? textBlock.text : '';

      let sources = [];
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          sources = parsed.details || [];
        }
      } catch {
        // Fall through
      }

      return {
        summary: text,
        sources,
        success: text.length > 0,
      };
    }
  }

  // Max turns reached
  return {
    summary: `Research for ${domain} reached maximum turns without a final answer.`,
    sources: [],
    success: false,
  };
}
