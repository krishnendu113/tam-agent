import { createMessage, streamMessage } from './llm.js';
import { getSkillSummary, getRegistryTriggers } from './skillLoader.js';
import { executeTool, getToolDefinitions } from './tools/index.js';
import { validateCallbacks } from './callbacks.js';
import { shouldCompact, compactHistory, buildCompactedContext, estimateTokenCount } from './compaction.js';
import { createTrace, startSpan, endSpan, flushTracing } from './tracing.js';
import { logLLMCall, logRequestComplete, logEvent } from './logger.js';
import { extractClientTag } from './clientTag.js';
import { listSessionPlans } from './planManager.js';

/**
 * System prompt for the preflight classification LLM call.
 * Instructs the Haiku model to classify the user's query and return structured JSON.
 */
const PREFLIGHT_SYSTEM_PROMPT = `You are a query classifier for a Technical Account Manager (TAM) agent. Your job is to analyze the user's message and determine:

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
 * Parses the LLM response text into a structured preflight result.
 * Attempts to extract JSON from the response content.
 *
 * @param {object} response - Normalized LLM response from createMessage
 * @returns {object|null} Parsed result or null if parsing fails
 */
function parsePreflightResponse(response) {
  // Extract text content from the response
  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    return null;
  }

  const text = textBlock.text.trim();

  try {
    // Try parsing the entire text as JSON first
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
 * Validates that a parsed object has the expected preflight result structure.
 *
 * @param {object} parsed - Parsed JSON object
 * @returns {object|null} Validated result or null if invalid
 */
function validatePreflightResult(parsed) {
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
 * Fail-open default result used when preflight parsing fails.
 * Treats the query as on-topic to avoid blocking legitimate requests.
 */
const FAIL_OPEN_RESULT = {
  onTopic: true,
  intent: 'unknown',
  toolTags: [],
  skillIds: [],
};

/**
 * Matches user query text against trigger keywords from the Skill_Registry.
 * Case-insensitive substring matching: lowercases the query and checks if
 * each trigger keyword (already lowercase) is contained as a substring.
 *
 * @param {string} queryText - The user's query text
 * @returns {string[]} Array of skill IDs whose triggers matched the query
 */
export function matchTriggerSkills(queryText) {
  if (!queryText || typeof queryText !== 'string') return [];

  const lowerQuery = queryText.toLowerCase();
  const triggersMap = getRegistryTriggers();
  const matchedSkillIds = [];

  for (const [skillId, triggers] of triggersMap) {
    if (!Array.isArray(triggers)) continue;
    const hasMatch = triggers.some(trigger =>
      lowerQuery.includes(trigger.toLowerCase())
    );
    if (hasMatch) {
      matchedSkillIds.push(skillId);
    }
  }

  return matchedSkillIds;
}

/**
 * Preflight Gate — classifies user intent before expensive operations.
 * Makes a single Haiku LLM call to determine:
 * - Whether the query is on-topic
 * - The user's intent
 * - Required tool tags
 * - Required skill IDs
 *
 * Also matches query against Skill_Registry trigger keywords and merges
 * trigger-matched skill IDs with LLM-classified ones.
 *
 * @param {AgentState} state - Current agent state with messages and systemPrompt
 * @returns {Promise<AgentState>} Updated state with preflight classification
 */
export async function preflightNode(state) {
  // Get the latest user message from the state
  const userMessage = state.messages
    ? state.messages.filter(m => m.role === 'user').pop()
    : null;

  const problemText = state.problemText || (userMessage ? (typeof userMessage.content === 'string' ? userMessage.content : '') : '');

  try {
    const response = await createMessage({
      model: 'haiku',
      system: PREFLIGHT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: problemText }],
      maxTokens: 256,
    });

    const result = parsePreflightResponse(response);

    if (result) {
      // Match query against Skill_Registry trigger keywords
      const triggerMatchedSkillIds = matchTriggerSkills(problemText);

      // Merge LLM-classified skillIds with trigger-matched skillIds (union)
      const mergedSkillIds = [...new Set([...result.skillIds, ...triggerMatchedSkillIds])];

      return {
        ...state,
        onTopic: result.onTopic,
        intent: result.intent,
        toolTags: result.toolTags,
        skillIds: mergedSkillIds,
      };
    }

    // Parse failure — fail-open
    console.warn('[Preflight] Failed to parse LLM response, treating as on-topic (fail-open)');
    return {
      ...state,
      ...FAIL_OPEN_RESULT,
    };
  } catch (error) {
    // LLM call failure — fail-open
    console.warn('[Preflight] LLM call failed, treating as on-topic (fail-open):', error.message);
    return {
      ...state,
      ...FAIL_OPEN_RESULT,
    };
  }
}

export { PREFLIGHT_SYSTEM_PROMPT, parsePreflightResponse, validatePreflightResult, FAIL_OPEN_RESULT };

/** Refusal message for off-topic queries (fallback if Haiku call fails). */
const REFUSAL_MESSAGE = "🤖 That's outside my wheelhouse! I'm built for Jira tickets, Capillary docs, and technical troubleshooting. Try pasting a ticket ID or describing a technical issue.";

/** System prompt for generating dynamic refusal messages. */
const REFUSAL_SYSTEM_PROMPT = `You are a witty, friendly assistant that redirects users back to your core purpose. You ONLY help with:
- Jira tickets and issues
- Capillary Technologies documentation
- Technical troubleshooting for Capillary products

The user asked something off-topic. Write a SHORT (1-2 sentences max), quirky/fun response that:
1. Acknowledges what they said with humor
2. Redirects them to paste a Jira ticket ID or describe a technical problem

Keep it light and playful. No emojis. No apologies. Just redirect with personality.`;

export { REFUSAL_MESSAGE };

/**
 * Loads skills based on preflight classification results.
 * Uses summary-only loading — only the skill name, description, and list of
 * available reference file names are loaded into context. Full SKILL.md body
 * and reference file contents are NOT loaded (lazy loading via tools).
 *
 * @param {AgentState} state - State with skillIds from preflight
 * @param {CallbackInterface} callbacks - Callbacks for SSE events
 * @returns {Promise<AgentState>} Updated state with loaded skill summaries
 */
export async function loadSkillsNode(state, callbacks) {
  const skillIds = state.skillIds || [];

  if (skillIds.length === 0) {
    return { ...state, skills: [] };
  }

  const loadedSkills = [];
  for (const skillId of skillIds) {
    const summary = getSkillSummary(skillId);
    if (summary) {
      loadedSkills.push(summary);
    }
  }

  for (const skill of loadedSkills) {
    if (callbacks && typeof callbacks.onSkillActive === 'function') {
      callbacks.onSkillActive(skill.id);
    }
  }

  return { ...state, skills: loadedSkills };
}

/**
 * Determines execution mode based on loaded skills and intent.
 * If skills are loaded and non-empty, routes to "multi-node" path.
 * Otherwise, routes to "research" path.
 *
 * @param {AgentState} state - State with loaded skills and intent
 * @returns {AgentState} Updated state with executionMode set
 */
export function skillRouterNode(state) {
  const skills = state.skills || [];

  if (skills.length > 0) {
    return { ...state, executionMode: 'multi-node' };
  }

  return { ...state, executionMode: 'research' };
}

/**
 * Multi-node execution path.
 * Loads available tools based on preflight toolTags and prepares state for synthesis.
 *
 * @param {AgentState} state - Current agent state
 * @param {CallbackInterface} callbacks - SSE event emitters
 * @returns {Promise<AgentState>} Updated state with availableTools
 */
export async function multiNodePath(state, callbacks) {
  // Load tools based on preflight classification toolTags
  const toolDefs = getToolDefinitions(state.toolTags);
  return { ...state, availableTools: toolDefs };
}

/**
 * Mapping from toolTag to the sub-agent domain and its relevant tool tags.
 */
const RESEARCH_DOMAIN_MAP = {
  jira: { domain: 'jira', tags: ['jira'] },
  confluence: { domain: 'confluence', tags: ['confluence'] },
  docs: { domain: 'docs', tags: ['docs'] },
  web: { domain: 'web', tags: ['web'] },
};

/**
 * Maximum number of multi-turn tool-calling iterations per sub-agent.
 */
const MAX_SUB_AGENT_TURNS = 3;

/**
 * System prompt template for research sub-agents.
 * @param {string} domain - The research domain (e.g., "jira", "confluence")
 * @returns {string} System prompt for the sub-agent
 */
function getResearchSystemPrompt(domain) {
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
 * Runs a single research sub-agent with multi-turn tool-calling.
 * Makes LLM calls via createMessage with Haiku model, executing tools as needed.
 *
 * @param {string} domain - The research domain (e.g., "jira", "confluence")
 * @param {Array<string>} tags - Tool tags for this domain
 * @param {string} query - The user's query/problem text
 * @returns {Promise<object>} Structured JSON summary from the sub-agent
 */
async function runSubAgent(domain, tags, query) {
  const tools = getToolDefinitions(tags);
  const systemPrompt = getResearchSystemPrompt(domain);
  const messages = [{ role: 'user', content: query }];

  let turn = 0;

  while (turn < MAX_SUB_AGENT_TURNS) {
    const response = await createMessage({
      model: 'haiku',
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
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

      // Try to parse as JSON, fall back to raw text summary
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch {
        // Fall through to text summary
      }

      return {
        domain,
        found: text.length > 0,
        summary: text,
        details: [],
      };
    }
  }

  // Max turns reached — return what we have
  return {
    domain,
    found: false,
    summary: `Research for ${domain} reached maximum turns without a final answer.`,
    details: [],
  };
}

/**
 * Runs Jira research sub-agent.
 * @param {AgentState} state - State with user query context
 * @returns {Promise<object>} Structured JSON summary of Jira findings
 */
export async function runJiraResearch(state) {
  const query = state.problemText || '';
  return runSubAgent('jira', ['jira'], query);
}

/**
 * Runs Confluence research sub-agent.
 * @param {AgentState} state - State with user query context
 * @returns {Promise<object>} Structured JSON summary of Confluence findings
 */
export async function runConfluenceResearch(state) {
  const query = state.problemText || '';
  return runSubAgent('confluence', ['confluence'], query);
}

/**
 * Runs Docs (Kapa) research sub-agent.
 * @param {AgentState} state - State with user query context
 * @returns {Promise<object>} Structured JSON summary of documentation findings
 */
export async function runDocsResearch(state) {
  const query = state.problemText || '';
  return runSubAgent('docs', ['docs'], query);
}

/**
 * Runs Web research sub-agent.
 * @param {AgentState} state - State with user query context
 * @returns {Promise<object>} Structured JSON summary of web search findings
 */
export async function runWebResearch(state) {
  const query = state.problemText || '';
  return runSubAgent('web', ['web'], query);
}

/**
 * Maps a domain name to its sub-agent runner function.
 */
const SUB_AGENT_RUNNERS = {
  jira: runJiraResearch,
  confluence: runConfluenceResearch,
  docs: runDocsResearch,
  web: runWebResearch,
};

/**
 * Dispatches domain-specific research sub-agents in parallel.
 * Each sub-agent uses Haiku model for multi-turn tool-calling research.
 *
 * @param {AgentState} state - State with toolTags indicating which domains to research
 * @param {CallbackInterface} callbacks - SSE event emitters
 * @returns {Promise<AgentState>} Updated state with researchContext
 */
export async function parallelResearchNode(state, callbacks) {
  // 1. Determine which sub-agents to dispatch based on state.toolTags
  const toolTags = state.toolTags || [];
  const domainsToResearch = toolTags.filter(tag => RESEARCH_DOMAIN_MAP[tag]);

  // If no specific domains identified, dispatch all
  const domains = domainsToResearch.length > 0
    ? domainsToResearch
    : Object.keys(RESEARCH_DOMAIN_MAP);

  // 2. Create sub-agent promises for each relevant domain
  const subAgentPromises = domains.map(domain => {
    const runner = SUB_AGENT_RUNNERS[domain];
    if (!runner) return Promise.reject(new Error(`Unknown domain: ${domain}`));
    return runner(state);
  });

  // 3. Use Promise.allSettled to run them concurrently
  const results = await Promise.allSettled(subAgentPromises);

  // 4. Collect results from fulfilled promises
  const researchResults = [];
  const failures = [];

  results.forEach((result, index) => {
    const domain = domains[index];
    if (result.status === 'fulfilled') {
      researchResults.push(result.value);
    } else {
      // 5. Log rejected promises (failures/timeouts)
      const errorMessage = result.reason?.message || 'Unknown error';
      console.warn(`[Research] Sub-agent "${domain}" failed: ${errorMessage}`);
      failures.push({ domain, error: errorMessage });
    }
  });

  // 6. Set state.researchContext with aggregated results
  const researchContext = {
    results: researchResults,
    failures,
    domainsSearched: domains,
    successCount: researchResults.length,
    failureCount: failures.length,
  };

  // 7. Set state.fallbackToSequential = true if ALL sub-agents failed
  const fallbackToSequential = researchResults.length === 0 && domains.length > 0;

  // 8. Invoke callbacks.onStatus with research summary
  if (callbacks && typeof callbacks.onStatus === 'function') {
    const summary = fallbackToSequential
      ? `Research complete: all ${domains.length} sub-agents failed, falling back to sequential mode`
      : `Research complete: ${researchResults.length}/${domains.length} sub-agents succeeded`;
    callbacks.onStatus(summary);
  }

  // 9. Return updated state
  return {
    ...state,
    researchContext,
    fallbackToSequential,
  };
}

/**
 * Sequential research fallback — runs sub-agents one at a time.
 * Used when parallel research fails completely (all sub-agents fail).
 * Tries each domain sequentially, stopping when at least one succeeds.
 *
 * @param {AgentState} state - State with fallbackToSequential = true
 * @param {CallbackInterface} callbacks - SSE event emitters
 * @returns {Promise<AgentState>} Updated state with researchContext
 */
export async function sequentialResearchFallback(state, callbacks) {
  // 1. Invoke callbacks.onStatus with fallback notification
  if (callbacks && typeof callbacks.onStatus === 'function') {
    callbacks.onStatus('Falling back to sequential research...');
  }

  const domains = ['jira', 'confluence', 'docs', 'web'];

  // 2. Try each domain one at a time
  for (const domain of domains) {
    const runner = SUB_AGENT_RUNNERS[domain];
    if (!runner) continue;

    if (callbacks && typeof callbacks.onStatus === 'function') {
      callbacks.onStatus(`Sequential research: trying ${domain}...`);
    }

    try {
      const result = await runner(state);

      // 3. On first success, add result to researchContext and stop
      const researchContext = {
        ...state.researchContext,
        results: [result],
        successCount: 1,
        failureCount: (state.researchContext?.failures?.length || 0),
      };

      if (callbacks && typeof callbacks.onStatus === 'function') {
        callbacks.onStatus(`Sequential research: ${domain} succeeded`);
      }

      return {
        ...state,
        researchContext,
        fallbackToSequential: true,
      };
    } catch (error) {
      // 4. On failure, log and try next domain
      console.warn(`[Sequential Research] Sub-agent "${domain}" failed: ${error.message}`);
    }
  }

  // 5. If all fail again, proceed with empty context (log warning)
  console.warn('[Sequential Research] All domains failed in sequential mode, proceeding with empty context');

  if (callbacks && typeof callbacks.onStatus === 'function') {
    callbacks.onStatus('Sequential research: all domains failed, proceeding with empty context');
  }

  const researchContext = {
    ...state.researchContext,
    results: [],
    successCount: 0,
  };

  return {
    ...state,
    researchContext,
    fallbackToSequential: true,
  };
}

/**
 * Builds the system prompt for the synthesis loop by combining the base
 * system prompt with aggregated research context.
 *
 * @param {AgentState} state - State with systemPrompt and researchContext
 * @returns {string} Combined system prompt for synthesis
 */
export function buildSynthesisSystemPrompt(state) {
  const basePrompt = state.systemPrompt || 'You are a helpful Technical Account Manager agent.';

  const instructions = `\n\n## Response Guidelines

- NEVER mention internal tool names, function names, or implementation details to the user (e.g., do not say "jira_get_issue", "confluence_search", "kapa_search", etc.)
- Present information naturally as if you already know it — do not describe your process of looking things up
- Focus on delivering actionable insights and solutions
- If you used tools to gather information, just present the findings directly`;

  // Build skill context section from loaded skill summaries
  let skillContext = '';
  const skills = state.skills || [];
  if (skills.length > 0) {
    const skillSections = skills.map(skill => {
      let section = `### ${skill.name}\n${skill.description}`;
      if (skill.referenceFiles && skill.referenceFiles.length > 0) {
        section += `\nAvailable reference files (use load_skill_reference to access): ${skill.referenceFiles.join(', ')}`;
      }
      return section;
    }).join('\n\n');
    skillContext = `\n\n## Active Skills\n\n${skillSections}`;
  }

  const researchContext = state.researchContext;
  if (!researchContext || !researchContext.results || researchContext.results.length === 0) {
    return basePrompt + instructions + skillContext;
  }

  const researchSummary = researchContext.results
    .map(result => {
      const domain = result.domain || 'unknown';
      const summary = result.summary || 'No summary available';
      const details = result.details && result.details.length > 0
        ? `\nDetails: ${JSON.stringify(result.details)}`
        : '';
      return `[${domain}] ${summary}${details}`;
    })
    .join('\n\n');

  return `${basePrompt}${instructions}${skillContext}\n\n## Research Context\n\nThe following research has been gathered to help answer the user's question:\n\n${researchSummary}`;
}

/**
 * Synthesis loop — generates final response with streaming and tool use.
 * Uses streamMessage for real-time token delivery and handles multi-turn tool calling.
 *
 * @param {AgentState} state - State with researchContext, messages, systemPrompt, availableTools
 * @param {CallbackInterface} callbacks - SSE event emitters
 * @returns {Promise<AgentState>} Updated state with final response
 */
export async function synthesisLoop(state, callbacks) {
  const MAX_ITERATIONS = 10;
  let iteration = 0;
  let messages = [...state.messages];

  // Build system prompt with research context
  const systemPrompt = buildSynthesisSystemPrompt(state);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Stream the LLM response
    const stream = streamMessage({
      model: 'sonnet',
      system: systemPrompt,
      messages,
      tools: state.availableTools,
      maxTokens: 4096,
    });

    let fullResponse = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'text':
          callbacks.onToken(event.text);
          break;
        case 'tool_use_start':
          callbacks.onToolStatus(event.name, 'started');
          break;
        case 'message_complete':
          fullResponse = event.response;
          break;
        case 'error':
          throw new Error(event.error.message);
      }
    }

    if (!fullResponse) break;

    // Append assistant response to messages
    messages.push({ role: 'assistant', content: fullResponse.content });

    // Check stop reason
    if (fullResponse.stop_reason === 'tool_use') {
      // Execute tools and append results
      for (const block of fullResponse.content) {
        if (block.type === 'tool_use') {
          let toolResult;
          try {
            toolResult = await executeTool(block.name, block.input);
            callbacks.onToolStatus(block.name, 'completed');
          } catch (error) {
            toolResult = { error: error.message };
            callbacks.onToolStatus(block.name, 'failed');
          }

          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(toolResult),
            }],
          });
        }
      }
      // Continue loop — re-invoke LLM with tool results
    } else {
      // stop_reason is "end_turn" or "max_tokens" — finalize
      const finalText = fullResponse.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      callbacks.onComplete(finalText);
      return { ...state, messages, finalResponse: fullResponse };
    }
  }

  // Max iterations reached
  callbacks.onStatus('Warning: maximum synthesis iterations reached');
  const lastText = messages[messages.length - 1]?.content
    ?.filter?.(b => b.type === 'text')
    ?.map?.(b => b.text)
    ?.join?.('') || '';
  callbacks.onComplete(lastText);
  return { ...state, messages, finalResponse: null };
}

/**
 * Main orchestration entry point. Replaces LangGraph StateGraph.
 * Executes nodes in order: Preflight → Skill Loading → Skill Router → path execution.
 *
 * Enhanced with:
 * - Tracing hooks (createTrace, startSpan/endSpan per phase, flushTracing on completion)
 * - Structured logging (logLLMCall after Bedrock calls, logRequestComplete at end)
 * - Client_Tag extraction from Jira context in query
 * - Context compaction check before synthesis
 * - Plan-awareness: inform LLM of existing session plans (IDs and titles only)
 *
 * @param {AgentState} state - Current agent state
 * @param {CallbackInterface} callbacks - SSE event emitters
 * @returns {Promise<AgentState>} Final state after execution
 */
export async function runAgentLoop(state, callbacks) {
  // Validate and normalize callbacks — ensures no crashes from missing callbacks
  callbacks = validateCallbacks(callbacks);

  const requestStartTime = Date.now();
  let llmCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Extract Client_Tag from query text (Jira project key)
  const problemText = state.problemText || '';
  const clientTag = state.clientTag || extractClientTag(problemText) || 'untagged';
  state = { ...state, clientTag };

  // Generate a request ID for tracing/logging
  const requestId = state.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state = { ...state, requestId };

  // Create a LangFuse trace for this request
  const trace = createTrace({
    requestId,
    userId: state.userId || 'anonymous',
    sessionId: state.sessionId || 'unknown',
    clientTag,
    queryText: problemText,
  });

  try {
    // 1. Preflight phase
    callbacks.onPhase('preflight');
    const preflightSpan = startSpan(trace, 'preflight', { query: problemText });
    state = await preflightNode(state);
    endSpan(preflightSpan, { onTopic: state.onTopic, intent: state.intent, skillIds: state.skillIds });

    // 2. Off-topic early termination
    if (!state.onTopic) {
      callbacks.onPhase('refusal');
      const refusalSpan = startSpan(trace, 'refusal', { reason: 'off-topic' });

      // Generate a dynamic, quirky refusal via Haiku (cheap and fast)
      let refusalText = REFUSAL_MESSAGE;
      try {
        const userQuery = state.messages.length > 0
          ? state.messages[state.messages.length - 1].content
          : '';
        const refusalStart = Date.now();
        const response = await createMessage({
          model: 'haiku',
          system: REFUSAL_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userQuery }],
          maxTokens: 100,
        });
        const refusalLatency = Date.now() - refusalStart;
        llmCallCount++;
        if (response.usage) {
          totalInputTokens += response.usage.input_tokens || 0;
          totalOutputTokens += response.usage.output_tokens || 0;
        }
        logLLMCall({
          model: 'haiku',
          input_tokens: response.usage?.input_tokens || 0,
          output_tokens: response.usage?.output_tokens || 0,
          latency_ms: refusalLatency,
          client_tag: clientTag,
          session_id: state.sessionId || 'unknown',
          request_id: requestId,
        });
        const textBlock = response.content.find(b => b.type === 'text');
        if (textBlock && textBlock.text && textBlock.text.trim()) {
          refusalText = textBlock.text.trim();
        }
      } catch (e) {
        // Fall back to static message if Haiku fails
      }

      endSpan(refusalSpan, { refusalText });
      callbacks.onToken(refusalText);
      callbacks.onComplete(refusalText);

      // Log request completion and flush tracing
      logRequestComplete({
        total_latency_ms: Date.now() - requestStartTime,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        llm_call_count: llmCallCount,
        client_tag: clientTag,
        session_id: state.sessionId || 'unknown',
        request_id: requestId,
      });
      await flushTracing();
      return state;
    }

    // 3. Skill loading phase
    callbacks.onPhase('skill_loading');
    const skillSpan = startSpan(trace, 'skill_loading', { skillIds: state.skillIds });
    state = await loadSkillsNode(state, callbacks);
    endSpan(skillSpan, { loadedSkills: (state.skills || []).map(s => s.id) });

    // 4. Skill routing
    state = skillRouterNode(state);

    // 5. Path execution based on executionMode
    if (state.executionMode === 'multi-node') {
      callbacks.onPhase('multi_node');
      const multiNodeSpan = startSpan(trace, 'multi_node', { toolTags: state.toolTags });
      state = await multiNodePath(state, callbacks);
      endSpan(multiNodeSpan, { toolCount: (state.availableTools || []).length });
    } else {
      callbacks.onPhase('research');
      const researchSpan = startSpan(trace, 'research', { toolTags: state.toolTags });
      state = await parallelResearchNode(state, callbacks);

      // 5b. Sequential fallback if parallel research failed completely
      if (state.fallbackToSequential) {
        state = await sequentialResearchFallback(state, callbacks);
      }
      endSpan(researchSpan, {
        successCount: state.researchContext?.successCount || 0,
        failureCount: state.researchContext?.failureCount || 0,
      });
    }

    // 6. Compaction check before synthesis
    let compactionOccurred = false;
    if (state.messages && shouldCompact(state.messages)) {
      const compactionSpan = startSpan(trace, 'compaction', { messageCount: state.messages.length });
      const tokensBefore = estimateTokenCount(state.messages);
      const turnRangeStart = 1;
      const turnRangeEnd = state.messages.length;

      try {
        const compactionResult = await compactHistory(state.messages);
        if (compactionResult.summary) {
          const compactedMessages = buildCompactedContext(compactionResult.summary, compactionResult.recentMessages);
          const tokensAfter = estimateTokenCount(compactedMessages);

          // Store compaction metadata on state
          state = {
            ...state,
            messages: compactedMessages,
            compactedHistory: compactionResult.summary,
            originalMessages: state.messages, // Preserve originals (not mutated)
          };
          compactionOccurred = true;

          // Log the compaction event
          logEvent('info', 'context_compaction', {
            session_id: state.sessionId || 'unknown',
            turn_range_start: turnRangeStart,
            turn_range_end: turnRangeEnd,
            tokens_before: tokensBefore,
            tokens_after: tokensAfter,
          });
        }
      } catch (compactionError) {
        // Fail-open: skip compaction if it fails, continue with full history
        logEvent('warn', 'compaction_failed', {
          session_id: state.sessionId || 'unknown',
          error: compactionError.message,
        });
      }
      endSpan(compactionSpan, { compactionOccurred });
    }

    // 7. Plan-awareness: inform LLM of existing session plans (IDs and titles only)
    let planContext = '';
    if (state.sessionId) {
      try {
        const existingPlans = listSessionPlans(state.sessionId);
        if (existingPlans.length > 0) {
          const planList = existingPlans
            .map(p => `- Plan "${p.title}" (ID: ${p.planId}, ${p.completedCount}/${p.taskCount} tasks done)`)
            .join('\n');
          planContext = `\n\n## Existing Plans for This Session\n\nThe following plans exist for this session. Use read_plan to view details if relevant:\n${planList}`;
        }
      } catch {
        // Non-critical: if plan listing fails, continue without plan context
      }
    }

    // 8. Add compaction notification and plan instruction to state
    let contextAdditions = '';
    if (compactionOccurred) {
      contextAdditions += '\n\n## Context Notice\n\nEarlier conversation turns have been summarized to fit within the context window. Use the lookup_chat_history tool if you need verbatim details from earlier turns.';
    }
    if (planContext) {
      contextAdditions += planContext;
    }
    // Instruct LLM to use create_plan for complex queries
    contextAdditions += '\n\n## Plan Instruction\n\nFor complex queries requiring multiple steps or tool calls, use the create_plan tool to create a structured execution plan before proceeding.';

    if (contextAdditions) {
      state = {
        ...state,
        systemPrompt: (state.systemPrompt || 'You are a helpful Technical Account Manager agent.') + contextAdditions,
      };
    }

    // 9. Synthesis phase — ensure tools are available
    if (!state.availableTools || state.availableTools.length === 0) {
      state = { ...state, availableTools: getToolDefinitions(state.toolTags) };
    }
    callbacks.onPhase('synthesis');
    const synthesisSpan = startSpan(trace, 'synthesis', { toolCount: (state.availableTools || []).length });
    state = await synthesisLoop(state, callbacks);
    endSpan(synthesisSpan, { finalResponseReceived: !!state.finalResponse });

    // 10. Log request completion and flush tracing
    logRequestComplete({
      total_latency_ms: Date.now() - requestStartTime,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      llm_call_count: llmCallCount,
      client_tag: clientTag,
      session_id: state.sessionId || 'unknown',
      request_id: requestId,
    });
    await flushTracing();

    return state;
  } catch (error) {
    callbacks.onError(error);

    // Log request completion even on error
    logRequestComplete({
      total_latency_ms: Date.now() - requestStartTime,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      llm_call_count: llmCallCount,
      client_tag: clientTag,
      session_id: state.sessionId || 'unknown',
      request_id: requestId,
    });
    await flushTracing();

    return state;
  }
}
