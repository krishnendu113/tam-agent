/**
 * Structured JSON Logger for CloudWatch compatibility.
 *
 * All output is JSON-serialized to stdout via console.log,
 * enabling CloudWatch Logs JSON parsing and metric filters.
 */

/**
 * Log an individual LLM call with token usage and latency.
 *
 * @param {object} params
 * @param {string} params.model - Model identifier (e.g., "haiku", "sonnet")
 * @param {number} params.input_tokens - Input token count
 * @param {number} params.output_tokens - Output token count
 * @param {number} params.latency_ms - Call latency in milliseconds
 * @param {string} params.client_tag - Client/project tag for cost attribution
 * @param {string} params.session_id - Session identifier
 * @param {string} params.request_id - Request identifier
 */
export function logLLMCall(params) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'llm_call',
    model: params.model,
    input_tokens: params.input_tokens,
    output_tokens: params.output_tokens,
    latency_ms: params.latency_ms,
    client_tag: params.client_tag,
    session_id: params.session_id,
    request_id: params.request_id,
  };
  console.log(JSON.stringify(entry));
}

/**
 * Log a completed request with aggregated metrics.
 *
 * @param {object} params
 * @param {number} params.total_latency_ms - Total request latency in milliseconds
 * @param {number} params.total_input_tokens - Sum of input tokens across all LLM calls
 * @param {number} params.total_output_tokens - Sum of output tokens across all LLM calls
 * @param {number} params.llm_call_count - Number of LLM calls made during the request
 * @param {string} params.client_tag - Client/project tag for cost attribution
 * @param {string} params.session_id - Session identifier
 * @param {string} params.request_id - Request identifier
 */
export function logRequestComplete(params) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'request_complete',
    total_latency_ms: params.total_latency_ms,
    total_input_tokens: params.total_input_tokens,
    total_output_tokens: params.total_output_tokens,
    llm_call_count: params.llm_call_count,
    client_tag: params.client_tag,
    session_id: params.session_id,
    request_id: params.request_id,
  };
  console.log(JSON.stringify(entry));
}

/**
 * Log a general structured event.
 *
 * @param {string} level - Log level (e.g., "info", "warn", "error")
 * @param {string} event - Event name/type
 * @param {object} data - Additional event data
 */
export function logEvent(level, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  console.log(JSON.stringify(entry));
}
