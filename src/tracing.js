/**
 * LangFuse Tracing Module
 *
 * Wraps the LangFuse SDK to provide observability helpers for the Agent Loop.
 * When LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL are not
 * all configured, operates in no-op mode where every call succeeds silently
 * without emitting network requests.
 *
 * Requirements: 11.1, 11.2, 11.13, 11.14, 11.20, 11.21
 */

import { Langfuse } from 'langfuse';

// ---------------------------------------------------------------------------
// Model Pricing Configuration
// ---------------------------------------------------------------------------

const MODEL_PRICING = {
  haiku: {
    input: parseFloat(process.env.HAIKU_INPUT_COST_PER_1K || '0.00025'),
    output: parseFloat(process.env.HAIKU_OUTPUT_COST_PER_1K || '0.00125'),
  },
  sonnet: {
    input: parseFloat(process.env.SONNET_INPUT_COST_PER_1K || '0.003'),
    output: parseFloat(process.env.SONNET_OUTPUT_COST_PER_1K || '0.015'),
  },
};

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

/** @type {import('langfuse').Langfuse | null} */
let langfuseClient = null;

/** Whether the module is in no-op mode (env vars missing). */
let noOpMode = true;

// ---------------------------------------------------------------------------
// No-Op Stubs
// ---------------------------------------------------------------------------

/** A no-op trace object that mimics the Langfuse trace API surface. */
const NO_OP_TRACE = Object.freeze({
  span() { return NO_OP_SPAN; },
  generation() { return NO_OP_GENERATION; },
  update() { return NO_OP_TRACE; },
});

/** A no-op span object that mimics the Langfuse span API surface. */
const NO_OP_SPAN = Object.freeze({
  end() { return NO_OP_SPAN; },
  update() { return NO_OP_SPAN; },
  span() { return NO_OP_SPAN; },
  generation() { return NO_OP_GENERATION; },
});

/** A no-op generation object that mimics the Langfuse generation API surface. */
const NO_OP_GENERATION = Object.freeze({
  end() { return NO_OP_GENERATION; },
  update() { return NO_OP_GENERATION; },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the tracing module. Reads LangFuse env vars and either connects
 * to LangFuse or activates no-op mode.
 *
 * Call once at application startup.
 */
export function initTracing() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey || !baseUrl) {
    noOpMode = true;
    langfuseClient = null;
    return;
  }

  noOpMode = false;
  langfuseClient = new Langfuse({
    publicKey,
    secretKey,
    baseUrl,
  });
}

/**
 * Create a new LangFuse trace for an incoming request.
 *
 * @param {{ requestId: string, userId: string, sessionId: string, clientTag: string, queryText: string }} metadata
 * @returns {object} A trace object (real or no-op)
 */
export function createTrace(metadata) {
  if (noOpMode || !langfuseClient) {
    return NO_OP_TRACE;
  }

  const { requestId, userId, sessionId, clientTag, queryText } = metadata;

  return langfuseClient.trace({
    id: requestId,
    name: 'agent-request',
    userId,
    sessionId,
    input: queryText,
    metadata: {
      clientTag,
    },
  });
}

/**
 * Start a span on a trace, representing a distinct execution phase.
 *
 * @param {object} trace - The trace object returned by createTrace
 * @param {string} name - Span name (e.g., "preflight", "skill-loading", "synthesis")
 * @param {*} input - Input data for the span
 * @returns {object} A span object (real or no-op)
 */
export function startSpan(trace, name, input) {
  if (noOpMode || !langfuseClient) {
    return NO_OP_SPAN;
  }

  return trace.span({
    name,
    input,
  });
}

/**
 * End a span, recording its output.
 *
 * @param {object} span - The span object returned by startSpan
 * @param {*} output - Output data for the span
 */
export function endSpan(span, output) {
  if (noOpMode || !langfuseClient) {
    return;
  }

  span.end({ output });
}

/**
 * Start a generation (LLM call) on a trace.
 *
 * @param {object} trace - The trace object returned by createTrace
 * @param {{ model: string, inputMessages: any[], modelId: string, clientTag?: string }} params
 * @returns {object} A generation object (real or no-op)
 */
export function startGeneration(trace, params) {
  if (noOpMode || !langfuseClient) {
    return NO_OP_GENERATION;
  }

  const { model, inputMessages, modelId, clientTag } = params;

  const pricing = MODEL_PRICING[model] || MODEL_PRICING.sonnet;

  return trace.generation({
    name: `${model}-generation`,
    model: modelId,
    input: inputMessages,
    metadata: {
      clientTag: clientTag || null,
    },
    modelParameters: {
      inputCostPer1kTokens: pricing.input,
      outputCostPer1kTokens: pricing.output,
    },
  });
}

/**
 * End a generation, recording output and token usage.
 *
 * @param {object} generation - The generation object returned by startGeneration
 * @param {*} output - The model response output
 * @param {{ input_tokens: number, output_tokens: number }} usage - Token usage from Bedrock response
 */
export function endGeneration(generation, output, usage) {
  if (noOpMode || !langfuseClient) {
    return;
  }

  generation.end({
    output,
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
    },
  });
}

/**
 * Flush all pending tracing data to LangFuse. Call at the end of each request
 * or before process exit to avoid data loss.
 *
 * @returns {Promise<void>}
 */
export async function flushTracing() {
  if (noOpMode || !langfuseClient) {
    return;
  }

  await langfuseClient.flushAsync();
}

// ---------------------------------------------------------------------------
// Utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns the current model pricing configuration.
 * @returns {{ haiku: { input: number, output: number }, sonnet: { input: number, output: number } }}
 */
export function getModelPricing() {
  return { ...MODEL_PRICING };
}

/**
 * Returns whether the module is currently in no-op mode.
 * @returns {boolean}
 */
export function isNoOpMode() {
  return noOpMode;
}

/**
 * Shut down the LangFuse client. Call during graceful shutdown.
 * @returns {Promise<void>}
 */
export async function shutdownTracing() {
  if (langfuseClient) {
    await langfuseClient.shutdownAsync();
    langfuseClient = null;
  }
  noOpMode = true;
}
