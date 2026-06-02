import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { startGeneration, endGeneration } from './tracing.js';
import { logLLMCall } from './logger.js';

// --- Tracing Context ---

/**
 * Module-level active trace and context used by tracing hooks.
 * Set by the agent loop at the start of each request via setActiveTrace/setActiveContext.
 */
let activeTrace = null;
let activeContext = { session_id: '', request_id: '', client_tag: '' };

/**
 * Set the active LangFuse trace for the current request.
 * Called by the agent loop at the start of each request.
 * @param {object|null} trace - The trace object from createTrace(), or null to clear
 */
export function setActiveTrace(trace) {
  activeTrace = trace;
}

/**
 * Set the active request context for logging (session_id, request_id, client_tag).
 * Called by the agent loop at the start of each request.
 * @param {{ session_id?: string, request_id?: string, client_tag?: string }} ctx
 */
export function setActiveContext(ctx) {
  activeContext = {
    session_id: ctx.session_id || '',
    request_id: ctx.request_id || '',
    client_tag: ctx.client_tag || '',
  };
}

/**
 * Get the current active trace (for testing/inspection).
 * @returns {object|null}
 */
export function getActiveTrace() {
  return activeTrace;
}

/**
 * Get the current active context (for testing/inspection).
 * @returns {{ session_id: string, request_id: string, client_tag: string }}
 */
export function getActiveContext() {
  return { ...activeContext };
}

// --- Error Classes ---

/**
 * Thrown when AWS credentials are missing or invalid.
 */
export class AuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Thrown when a required configuration value (e.g. model alias env var) is missing.
 */
export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown when the Bedrock API returns an error.
 * @property {string} errorType - The type of error (e.g. "api_error", "network_error", "parse_error")
 * @property {string} message - Human-readable error description
 * @property {number} statusCode - HTTP status code from Bedrock
 */
export class LLMError extends Error {
  constructor({ errorType, message, statusCode }) {
    super(message);
    this.name = 'LLMError';
    this.errorType = errorType;
    this.statusCode = statusCode;
  }
}

// --- Model Alias Resolution ---

const MODEL_ALIASES = {
  sonnet: 'BEDROCK_SONNET_MODEL_ID',
  haiku: 'BEDROCK_HAIKU_MODEL_ID',
};

/**
 * Resolves a model alias to a full Bedrock model ID.
 * - "sonnet" → value of BEDROCK_SONNET_MODEL_ID env var
 * - "haiku" → value of BEDROCK_HAIKU_MODEL_ID env var
 * - Any other string is passed through as a literal model ID.
 *
 * @param {string} alias - Model alias or full model ID
 * @returns {string} Resolved Bedrock model ID
 * @throws {ConfigurationError} If the alias env var is not set
 */
export function resolveModelId(alias) {
  const envVarName = MODEL_ALIASES[alias];

  if (!envVarName) {
    // Not a known alias — pass through as literal model ID
    return alias;
  }

  const modelId = process.env[envVarName];

  if (!modelId) {
    throw new ConfigurationError(
      `Environment variable ${envVarName} is not set. Required for model alias "${alias}".`
    );
  }

  return modelId;
}

// --- Bedrock Client Initialization ---

let bedrockClient = null;

/**
 * Returns the singleton BedrockRuntimeClient instance.
 * Initializes on first call using AWS_REGION env var and default credential chain.
 *
 * @returns {BedrockRuntimeClient}
 * @throws {AuthenticationError} If AWS credentials are missing or invalid
 */
export function getBedrockClient() {
  if (bedrockClient) {
    return bedrockClient;
  }

  const region = process.env.AWS_REGION;

  if (!region) {
    throw new AuthenticationError(
      'AWS_REGION environment variable is not set. Cannot initialize Bedrock client.'
    );
  }

  bedrockClient = new BedrockRuntimeClient({ region });
  return bedrockClient;
}

/**
 * Resets the Bedrock client singleton. Used for testing.
 */
export function resetBedrockClient() {
  bedrockClient = null;
}

// --- Response Normalization ---

/**
 * Normalizes a raw Bedrock response into the internal message format.
 * Strips provider-specific fields and retains only the fields needed by downstream code.
 *
 * @param {Object} bedrockResponse - Raw parsed response body from Bedrock (Anthropic Messages API format)
 * @returns {NormalizedResponse} Normalized response with role, content, stop_reason, and usage
 */
export function normalizeResponse(bedrockResponse) {
  const { content, stop_reason, usage } = bedrockResponse;

  return {
    role: 'assistant',
    content: (content || []).map(normalizeContentBlock),
    stop_reason: stop_reason || null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  };
}

/**
 * Normalizes a single content block, keeping only the relevant fields.
 * @param {Object} block - Raw content block from Bedrock response
 * @returns {Object} Normalized content block
 */
function normalizeContentBlock(block) {
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }

  // Default to text block
  return {
    type: 'text',
    text: block.text,
  };
}

// --- Request Body Builder ---

/**
 * Constructs the Bedrock request envelope for the Anthropic Messages API.
 * @param {Object} params
 * @param {string} params.model - Resolved Bedrock model ID
 * @param {string|Array} params.system - System prompt (string or content blocks)
 * @param {Array} params.messages - Conversation messages in Anthropic format
 * @param {Array} [params.tools] - Tool definitions (omitted if empty/undefined)
 * @param {number} params.maxTokens - Maximum tokens to generate
 * @returns {Object} Bedrock request body
 */
export function buildBedrockRequestBody({ model, system, messages, tools, maxTokens }) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    system,
    messages,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  return body;
}

// --- Error Mapping ---

/**
 * Maps Bedrock error exceptions to structured LLMError instances.
 * @param {Error} error - Error from Bedrock client.send()
 * @returns {LLMError}
 */
function mapBedrockError(error) {
  const statusCode = error.$metadata?.httpStatusCode || error.statusCode || 500;
  const errorName = error.name || error.constructor?.name || 'UnknownError';

  let errorType;
  switch (errorName) {
    case 'AccessDeniedException':
      errorType = 'authentication_error';
      break;
    case 'ValidationException':
      errorType = 'validation_error';
      break;
    case 'ThrottlingException':
      errorType = 'rate_limit_error';
      break;
    case 'ModelTimeoutException':
      errorType = 'network_error';
      break;
    case 'InternalServerException':
      errorType = 'api_error';
      break;
    default:
      errorType = 'api_error';
      break;
  }

  return new LLMError({
    errorType,
    message: error.message || `Bedrock API error: ${errorName}`,
    statusCode,
  });
}

// --- createMessage and streamMessage ---

/**
 * Non-streaming LLM call via AWS Bedrock.
 * @param {Object} options
 * @param {string} options.model - Model alias ("sonnet" | "haiku") or full Bedrock model ID
 * @param {string|Array} options.system - System prompt (string or content blocks)
 * @param {Array} options.messages - Conversation messages in Anthropic format
 * @param {Array} [options.tools] - Tool definitions (omitted if empty)
 * @param {number} options.maxTokens - Maximum tokens to generate
 * @returns {Promise<NormalizedResponse>}
 */
export async function createMessage({ model, system, messages, tools, maxTokens }) {
  const resolvedModelId = resolveModelId(model);
  const requestBody = buildBedrockRequestBody({ model: resolvedModelId, system, messages, tools, maxTokens });
  const client = getBedrockClient();

  const command = new InvokeModelCommand({
    modelId: resolvedModelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  // Start tracing generation
  const generation = activeTrace
    ? startGeneration(activeTrace, {
        model,
        inputMessages: messages,
        modelId: resolvedModelId,
        clientTag: activeContext.client_tag,
      })
    : null;

  const startTime = Date.now();

  try {
    const response = await client.send(command);
    const latencyMs = Date.now() - startTime;
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const normalized = normalizeResponse(responseBody);

    // End tracing generation with output and usage
    if (generation) {
      endGeneration(generation, normalized.content, normalized.usage);
    }

    // Structured logging for the LLM call
    logLLMCall({
      model,
      input_tokens: normalized.usage.input_tokens,
      output_tokens: normalized.usage.output_tokens,
      latency_ms: latencyMs,
      client_tag: activeContext.client_tag,
      session_id: activeContext.session_id,
      request_id: activeContext.request_id,
    });

    return normalized;
  } catch (error) {
    const latencyMs = Date.now() - startTime;

    // End generation with error info if tracing is active
    if (generation) {
      endGeneration(generation, { error: error.message }, { input_tokens: 0, output_tokens: 0 });
    }

    // Log the failed LLM call with zero tokens
    logLLMCall({
      model,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: latencyMs,
      client_tag: activeContext.client_tag,
      session_id: activeContext.session_id,
      request_id: activeContext.request_id,
    });

    if (error instanceof LLMError) {
      throw error;
    }
    throw mapBedrockError(error);
  }
}

// --- Stream Event Normalization ---

/**
 * Normalizes a single Bedrock stream event and updates the accumulator state.
 * Returns an array of normalized events to yield (can be empty, one, or multiple).
 *
 * @param {Object} bedrockEvent - Parsed Bedrock stream event (Anthropic streaming format)
 * @param {Object} accumulator - Mutable accumulator tracking stream state
 * @returns {Array<StreamEvent>} Array of normalized events to yield
 */
export function normalizeStreamEvent(bedrockEvent, accumulator) {
  const events = [];

  switch (bedrockEvent.type) {
    case 'message_start': {
      const { message } = bedrockEvent;
      if (message?.usage) {
        accumulator.usage.input_tokens = message.usage.input_tokens ?? 0;
        accumulator.usage.output_tokens = message.usage.output_tokens ?? 0;
      }
      break;
    }

    case 'content_block_start': {
      const { index, content_block } = bedrockEvent;
      accumulator.currentBlockIndex = index;

      if (content_block.type === 'tool_use') {
        // Initialize the content block in the accumulator
        accumulator.contentBlocks[index] = {
          type: 'tool_use',
          id: content_block.id,
          name: content_block.name,
          input: {},
        };
        accumulator.inputJsonParts[index] = [];

        events.push({
          type: 'tool_use_start',
          id: content_block.id,
          name: content_block.name,
        });
      } else {
        // Text block
        accumulator.contentBlocks[index] = {
          type: 'text',
          text: '',
        };
      }
      break;
    }

    case 'content_block_delta': {
      const { index, delta } = bedrockEvent;

      if (delta.type === 'text_delta') {
        // Accumulate text
        if (accumulator.contentBlocks[index]) {
          accumulator.contentBlocks[index].text += delta.text;
        }
        events.push({
          type: 'text',
          text: delta.text,
        });
      } else if (delta.type === 'input_json_delta') {
        // Accumulate partial JSON for tool input
        if (accumulator.inputJsonParts[index]) {
          accumulator.inputJsonParts[index].push(delta.partial_json);
        }
        events.push({
          type: 'tool_input_delta',
          partialJson: delta.partial_json,
        });
      }
      break;
    }

    case 'content_block_stop': {
      const { index } = bedrockEvent;

      // If this was a tool_use block, parse the accumulated JSON input
      if (
        accumulator.contentBlocks[index]?.type === 'tool_use' &&
        accumulator.inputJsonParts[index]
      ) {
        const fullJson = accumulator.inputJsonParts[index].join('');
        try {
          accumulator.contentBlocks[index].input = fullJson ? JSON.parse(fullJson) : {};
        } catch {
          accumulator.contentBlocks[index].input = {};
        }
      }
      break;
    }

    case 'message_delta': {
      const { delta, usage } = bedrockEvent;
      if (delta?.stop_reason) {
        accumulator.stopReason = delta.stop_reason;
      }
      if (usage?.output_tokens !== undefined) {
        accumulator.usage.output_tokens = usage.output_tokens;
      }
      break;
    }

    case 'message_stop': {
      // Assemble the full response from accumulated state
      const response = {
        role: 'assistant',
        content: accumulator.contentBlocks.filter(Boolean),
        stop_reason: accumulator.stopReason || null,
        usage: { ...accumulator.usage },
      };

      events.push({
        type: 'message_complete',
        response,
      });
      break;
    }

    default:
      // Unknown event types are silently ignored
      break;
  }

  return events;
}

/**
 * Creates a fresh accumulator for stream event processing.
 * @returns {Object} New accumulator instance
 */
function createStreamAccumulator() {
  return {
    contentBlocks: [],
    currentBlockIndex: -1,
    inputJsonParts: [],
    stopReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Streaming LLM call via AWS Bedrock.
 * Returns an async iterable yielding normalized stream events.
 * @param {Object} options - Same as createMessage
 * @returns {AsyncIterable<StreamEvent>}
 */
export async function* streamMessage({ model, system, messages, tools, maxTokens }) {
  const resolvedModelId = resolveModelId(model);
  const requestBody = buildBedrockRequestBody({ model: resolvedModelId, system, messages, tools, maxTokens });
  const client = getBedrockClient();

  const command = new InvokeModelWithResponseStreamCommand({
    modelId: resolvedModelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  // Start tracing generation
  const generation = activeTrace
    ? startGeneration(activeTrace, {
        model,
        inputMessages: messages,
        modelId: resolvedModelId,
        clientTag: activeContext.client_tag,
      })
    : null;

  const startTime = Date.now();

  let response;
  try {
    response = await client.send(command);
  } catch (error) {
    const latencyMs = Date.now() - startTime;

    // End generation with error info if tracing is active
    if (generation) {
      endGeneration(generation, { error: error.message }, { input_tokens: 0, output_tokens: 0 });
    }

    // Log the failed LLM call
    logLLMCall({
      model,
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: latencyMs,
      client_tag: activeContext.client_tag,
      session_id: activeContext.session_id,
      request_id: activeContext.request_id,
    });

    const llmError = error instanceof LLMError ? error : mapBedrockError(error);
    yield {
      type: 'error',
      error: {
        errorType: llmError.errorType,
        message: llmError.message,
        statusCode: llmError.statusCode,
      },
    };
    return;
  }

  const accumulator = createStreamAccumulator();

  try {
    for await (const event of response.body) {
      if (event.chunk?.bytes) {
        const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        const normalizedEvents = normalizeStreamEvent(parsed, accumulator);

        for (const normalizedEvent of normalizedEvents) {
          // When message completes, record tracing and logging
          if (normalizedEvent.type === 'message_complete') {
            const latencyMs = Date.now() - startTime;
            const { response: completedResponse } = normalizedEvent;

            // End tracing generation with output and usage
            if (generation) {
              endGeneration(generation, completedResponse.content, completedResponse.usage);
            }

            // Structured logging for the LLM call
            logLLMCall({
              model,
              input_tokens: completedResponse.usage.input_tokens,
              output_tokens: completedResponse.usage.output_tokens,
              latency_ms: latencyMs,
              client_tag: activeContext.client_tag,
              session_id: activeContext.session_id,
              request_id: activeContext.request_id,
            });
          }

          yield normalizedEvent;
        }
      }
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime;

    // End generation with error info if tracing is active
    if (generation) {
      endGeneration(generation, { error: error.message }, accumulator.usage);
    }

    // Log the failed LLM call with whatever tokens were accumulated
    logLLMCall({
      model,
      input_tokens: accumulator.usage.input_tokens,
      output_tokens: accumulator.usage.output_tokens,
      latency_ms: latencyMs,
      client_tag: activeContext.client_tag,
      session_id: activeContext.session_id,
      request_id: activeContext.request_id,
    });

    const llmError = error instanceof LLMError ? error : mapBedrockError(error);
    yield {
      type: 'error',
      error: {
        errorType: llmError.errorType,
        message: llmError.message,
        statusCode: llmError.statusCode,
      },
    };
    return;
  }
}
