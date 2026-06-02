// Sub-Agent Delegation Tool — delegate_to_subagent
// Refactored from the runSubAgent pattern in agentLoop.js into a standalone tool.

import { createMessage } from '../llm.js';

// Lazy import to avoid circular dependency (subAgent.js <-> index.js).
// executeTool and getToolDefinitions are only needed at runtime, not at import time.
let _executeTool;
let _getToolDefinitions;

async function getToolRegistry() {
  if (!_executeTool || !_getToolDefinitions) {
    const toolIndex = await import('./index.js');
    _executeTool = toolIndex.executeTool;
    _getToolDefinitions = toolIndex.getToolDefinitions;
  }
  return { executeTool: _executeTool, getToolDefinitions: _getToolDefinitions };
}

/**
 * Clamps maxTurns to the valid range [1, 10].
 * Exported separately for property-based testing.
 *
 * @param {number|undefined|null} maxTurns - The requested max turns value
 * @returns {number} Clamped value in [1, 10]
 */
export function clampTurns(maxTurns) {
  return Math.min(Math.max(maxTurns || 5, 1), 10);
}

/**
 * Builds a system prompt for the sub-agent.
 *
 * @param {string} taskDescription - What the sub-agent should accomplish
 * @param {string} [context] - Additional context for the sub-agent
 * @returns {string} System prompt
 */
function buildSubAgentSystemPrompt(taskDescription, context) {
  let prompt = `You are a research and execution sub-agent. Your task is:

${taskDescription}

Instructions:
- Use the provided tools to accomplish the task
- Be concise and focused on completing the task
- Return your final answer as clear, structured text
- If you cannot complete the task, explain what you found and what blocked you`;

  if (context) {
    prompt += `\n\nAdditional context:\n${context}`;
  }

  return prompt;
}

/**
 * Executes the sub-agent multi-turn tool loop.
 *
 * @param {object} input - Tool input
 * @param {string} input.taskDescription - What the sub-agent should accomplish
 * @param {string} [input.context] - Additional context
 * @param {number} [input.maxTurns] - Max tool-calling turns (default 5, clamped to [1, 10])
 * @returns {Promise<object>} Result with output text and metadata
 */
async function executeSubAgent({ taskDescription, context, maxTurns }) {
  const effectiveMaxTurns = clampTurns(maxTurns);
  const systemPrompt = buildSubAgentSystemPrompt(taskDescription, context);
  const { executeTool, getToolDefinitions } = await getToolRegistry();
  const tools = getToolDefinitions();
  const messages = [{ role: 'user', content: taskDescription }];

  let turn = 0;
  let lastTextOutput = '';

  while (turn < effectiveMaxTurns) {
    let response;
    try {
      response = await createMessage({
        model: 'haiku',
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens: 2048,
      });
    } catch (error) {
      return {
        output: lastTextOutput || `Sub-agent encountered an error: ${error.message}`,
        turnsUsed: turn,
        maxTurnsReached: false,
        error: error.message,
      };
    }

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

      // Track any text that was also in the response
      const textBlock = response.content.find(block => block.type === 'text');
      if (textBlock && textBlock.text) {
        lastTextOutput = textBlock.text;
      }

      turn++;
    } else {
      // LLM returned a text response (end_turn) — extract final output
      const textBlock = response.content.find(block => block.type === 'text');
      const finalText = textBlock ? textBlock.text : '';

      return {
        output: finalText,
        turnsUsed: turn + 1,
        maxTurnsReached: false,
      };
    }
  }

  // Max turns exceeded — return partial result with warning
  return {
    output: lastTextOutput || 'Sub-agent reached maximum turns without producing a final answer.',
    turnsUsed: effectiveMaxTurns,
    maxTurnsReached: true,
    warning: `Sub-agent terminated after reaching the maximum of ${effectiveMaxTurns} tool-calling turns. The result may be incomplete.`,
  };
}

/**
 * Tool definition for delegate_to_subagent.
 */
export const delegateToSubagentTool = {
  name: 'delegate_to_subagent',
  description: 'Delegate a research or execution task to a sub-agent. The sub-agent uses a cheaper model and has access to all tools.',
  tags: ['agent'],
  inputSchema: {
    type: 'object',
    properties: {
      taskDescription: {
        type: 'string',
        description: 'What the sub-agent should accomplish',
      },
      context: {
        type: 'string',
        description: 'Additional context to provide the sub-agent',
      },
      maxTurns: {
        type: 'integer',
        description: 'Max tool-calling turns (default 5, max 10)',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['taskDescription'],
  },
  handler: executeSubAgent,
};

export default delegateToSubagentTool;
