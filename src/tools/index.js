// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Tool registry - manages available tools and their execution.

import { jiraTool } from './jira.js';
import { confluenceTool } from './confluence.js';
import { kapaTool } from './kapa.js';
import { webSearchTool } from './webSearch.js';

/**
 * Registry of all available tools.
 */
const toolRegistry = new Map();

/**
 * Registers a tool in the registry.
 * @param {object} tool - Tool definition with name, description, inputSchema, handler
 */
export function registerTool(tool) {
  toolRegistry.set(tool.name, tool);
}

/**
 * Returns all registered tools.
 * @returns {Array} Array of tool definitions
 */
export function getAllTools() {
  return Array.from(toolRegistry.values());
}

/**
 * Returns tools filtered by tags.
 * @param {Array<string>} tags - Tags to filter by
 * @returns {Array} Filtered tool definitions
 */
export function getToolsByTags(tags) {
  if (!tags || tags.length === 0) return getAllTools();
  return getAllTools().filter(tool =>
    tool.tags && tool.tags.some(tag => tags.includes(tag))
  );
}

/**
 * Executes a tool by name with the given input.
 * @param {string} name - Tool name
 * @param {object} input - Tool input parameters
 * @returns {Promise<object>} Tool execution result
 */
export async function executeTool(name, input) {
  const tool = toolRegistry.get(name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool.handler(input);
}

/**
 * Returns tool definitions formatted for the LLM (Anthropic Messages API format).
 * @param {Array<string>} [tags] - Optional tags to filter tools
 * @returns {Array} Tool definitions in LLM format
 */
export function getToolDefinitions(tags) {
  const tools = getToolsByTags(tags);
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

// Register built-in tools
registerTool(jiraTool);
registerTool(confluenceTool);
registerTool(kapaTool);
registerTool(webSearchTool);

export default { registerTool, getAllTools, getToolsByTags, executeTool, getToolDefinitions };
