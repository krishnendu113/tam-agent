/**
 * Callback Interface validation and factory for the TAM Agent Loop.
 *
 * Provides a well-defined set of required callback functions for SSE event
 * streaming, with validation and no-op defaults for missing callbacks.
 */

/**
 * Required callback function names for the CallbackInterface.
 * These correspond to SSE event types emitted during agent execution.
 */
export const REQUIRED_CALLBACKS = [
  'onToken',
  'onStatus',
  'onPhase',
  'onToolStatus',
  'onSkillActive',
  'onPlanUpdate',
  'onDocumentReady',
  'onError',
  'onComplete',
];

/**
 * No-op function used as default for missing callbacks.
 */
const noop = () => {};

/**
 * Creates a complete CallbackInterface with no-op defaults for any missing callbacks.
 * @param {Partial<CallbackInterface>} overrides - Partial callback object
 * @returns {CallbackInterface} Complete callback interface with all required functions
 */
export function createCallbackInterface(overrides = {}) {
  const callbacks = {};
  for (const name of REQUIRED_CALLBACKS) {
    callbacks[name] = typeof overrides[name] === 'function' ? overrides[name] : noop;
  }
  return callbacks;
}

/**
 * Validates a callbacks object and returns a normalized version with no-op defaults.
 * Ensures the agent loop never crashes due to missing or invalid callback functions.
 *
 * @param {object} callbacks - Raw callbacks object (may be null, undefined, or partial)
 * @returns {CallbackInterface} Normalized callback interface with all required functions
 */
export function validateCallbacks(callbacks) {
  if (!callbacks || typeof callbacks !== 'object') {
    return createCallbackInterface({});
  }
  return createCallbackInterface(callbacks);
}
