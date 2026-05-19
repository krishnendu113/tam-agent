// Kapa/Docs MCP tool - queries the Capillary documentation MCP server.

const CAPILLARY_DOCS_MCP_URL = process.env.CAPILLARY_DOCS_MCP_URL;
const CAPILLARY_DOCS_MCP_TOKEN = process.env.CAPILLARY_DOCS_MCP_TOKEN;

function checkConfig() {
  if (!CAPILLARY_DOCS_MCP_URL || !CAPILLARY_DOCS_MCP_TOKEN) {
    return 'Kapa/Docs MCP tool is not configured. Set CAPILLARY_DOCS_MCP_URL and CAPILLARY_DOCS_MCP_TOKEN environment variables.';
  }
  return null;
}

// Log warning at module load if not configured
const configWarning = checkConfig();
if (configWarning) {
  console.warn(`[kapa] ${configWarning}`);
}

// Cache discovered tools from the MCP server
let mcpTools = null;

/**
 * Sends a JSON-RPC request to the MCP server.
 */
async function mcpRequest(method, params = {}, id = 1) {
  const body = {
    jsonrpc: '2.0',
    method,
    id
  };
  if (Object.keys(params).length > 0) {
    body.params = params;
  }

  const response = await fetch(`${CAPILLARY_DOCS_MCP_URL}/mcp/v1`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CAPILLARY_DOCS_MCP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP server error (${response.status}): ${text}`);
  }

  const result = await response.json();
  if (result.error) {
    throw new Error(`MCP error: ${result.error.message || JSON.stringify(result.error)}`);
  }

  return result.result;
}

/**
 * Discovers available tools from the MCP server.
 */
async function discoverTools() {
  if (mcpTools) return mcpTools;
  const result = await mcpRequest('tools/list');
  mcpTools = result.tools || result || [];
  return mcpTools;
}

/**
 * Kapa query tool definition.
 */
export const kapaTool = {
  name: 'kapa_query',
  description: 'Query the Capillary documentation via MCP server. Returns answers with source references.',
  tags: ['docs', 'research'],
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Natural language question to ask the documentation assistant'
      }
    },
    required: ['question']
  },
  async handler(input) {
    const error = checkConfig();
    if (error) return { error };

    const { question } = input;

    try {
      // Discover available tools on the MCP server
      const tools = await discoverTools();

      // Find the most appropriate tool (search/query tool)
      const queryTool = tools.find(t =>
        t.name.includes('query') ||
        t.name.includes('search') ||
        t.name.includes('ask')
      ) || tools[0];

      if (!queryTool) {
        return { error: 'No tools available on the MCP server' };
      }

      // Call the discovered tool
      const result = await mcpRequest('tools/call', {
        name: queryTool.name,
        arguments: { question }
      }, 2);

      // Extract answer and sources from the result
      // MCP tools/call returns { content: [...] }
      const content = result.content || result;
      let answer = '';
      let sources = [];

      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'text') {
            answer += item.text;
          }
        }
      } else if (typeof content === 'string') {
        answer = content;
      } else if (content.answer) {
        answer = content.answer;
        sources = content.sources || [];
      }

      return { answer, sources, question };
    } catch (err) {
      return { error: `Kapa/Docs MCP query failed: ${err.message}` };
    }
  }
};

export default kapaTool;
