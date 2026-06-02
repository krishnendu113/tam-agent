import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { logLLMCall, logRequestComplete } from '../logger.js';

// --- Generators ---

/**
 * Generates arbitrary valid parameters for logLLMCall.
 */
function arbLLMCallParams() {
  return fc.record({
    model: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-_'.split('')), {
      minLength: 1,
      maxLength: 20,
    }),
    input_tokens: fc.nat({ max: 1_000_000 }),
    output_tokens: fc.nat({ max: 1_000_000 }),
    latency_ms: fc.nat({ max: 600_000 }),
    client_tag: fc.string({ minLength: 0, maxLength: 30 }),
    session_id: fc.string({ minLength: 1, maxLength: 50 }),
    request_id: fc.string({ minLength: 1, maxLength: 50 }),
  });
}

/**
 * Generates arbitrary valid parameters for logRequestComplete.
 */
function arbRequestCompleteParams() {
  return fc.record({
    total_latency_ms: fc.nat({ max: 600_000 }),
    total_input_tokens: fc.nat({ max: 10_000_000 }),
    total_output_tokens: fc.nat({ max: 10_000_000 }),
    llm_call_count: fc.nat({ max: 100 }),
    client_tag: fc.string({ minLength: 0, maxLength: 30 }),
    session_id: fc.string({ minLength: 1, maxLength: 50 }),
    request_id: fc.string({ minLength: 1, maxLength: 50 }),
  });
}

// --- Property Tests ---

describe('Feature: skill-system-enhancement, Property 18: Structured JSON Log Validity', () => {
  let consoleSpy;
  let capturedOutput;

  beforeEach(() => {
    capturedOutput = [];
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedOutput.push(args.join(' '));
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /**
   * **Validates: Requirements 11.15, 11.16, 11.17**
   *
   * For any LLM call event, the emitted log line SHALL be valid JSON parseable
   * by JSON.parse() and contain all required fields: timestamp, level, event,
   * model, input_tokens, output_tokens, latency_ms, client_tag, session_id, request_id.
   */
  it('logLLMCall emits valid JSON with all required fields for any valid params', () => {
    fc.assert(
      fc.property(arbLLMCallParams(), (params) => {
        capturedOutput = [];
        logLLMCall(params);

        // Exactly one log line emitted
        expect(capturedOutput.length).toBe(1);

        // Must be valid JSON
        let parsed;
        expect(() => {
          parsed = JSON.parse(capturedOutput[0]);
        }).not.toThrow();

        // All required fields present
        const requiredFields = [
          'timestamp',
          'level',
          'event',
          'model',
          'input_tokens',
          'output_tokens',
          'latency_ms',
          'client_tag',
          'session_id',
          'request_id',
        ];
        for (const field of requiredFields) {
          expect(parsed).toHaveProperty(field);
        }

        // Event type is correct
        expect(parsed.event).toBe('llm_call');
        expect(parsed.level).toBe('info');

        // Values match input params
        expect(parsed.model).toBe(params.model);
        expect(parsed.input_tokens).toBe(params.input_tokens);
        expect(parsed.output_tokens).toBe(params.output_tokens);
        expect(parsed.latency_ms).toBe(params.latency_ms);
        expect(parsed.client_tag).toBe(params.client_tag);
        expect(parsed.session_id).toBe(params.session_id);
        expect(parsed.request_id).toBe(params.request_id);

        // Timestamp is a valid ISO string
        expect(isNaN(Date.parse(parsed.timestamp))).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 11.15, 11.16, 11.17**
   *
   * For any request completion event, the emitted log line SHALL be valid JSON parseable
   * by JSON.parse() and contain all required fields: timestamp, level, event,
   * total_latency_ms, total_input_tokens, total_output_tokens, llm_call_count,
   * client_tag, session_id, request_id.
   */
  it('logRequestComplete emits valid JSON with all required fields for any valid params', () => {
    fc.assert(
      fc.property(arbRequestCompleteParams(), (params) => {
        capturedOutput = [];
        logRequestComplete(params);

        // Exactly one log line emitted
        expect(capturedOutput.length).toBe(1);

        // Must be valid JSON
        let parsed;
        expect(() => {
          parsed = JSON.parse(capturedOutput[0]);
        }).not.toThrow();

        // All required fields present
        const requiredFields = [
          'timestamp',
          'level',
          'event',
          'total_latency_ms',
          'total_input_tokens',
          'total_output_tokens',
          'llm_call_count',
          'client_tag',
          'session_id',
          'request_id',
        ];
        for (const field of requiredFields) {
          expect(parsed).toHaveProperty(field);
        }

        // Event type is correct
        expect(parsed.event).toBe('request_complete');
        expect(parsed.level).toBe('info');

        // Values match input params
        expect(parsed.total_latency_ms).toBe(params.total_latency_ms);
        expect(parsed.total_input_tokens).toBe(params.total_input_tokens);
        expect(parsed.total_output_tokens).toBe(params.total_output_tokens);
        expect(parsed.llm_call_count).toBe(params.llm_call_count);
        expect(parsed.client_tag).toBe(params.client_tag);
        expect(parsed.session_id).toBe(params.session_id);
        expect(parsed.request_id).toBe(params.request_id);

        // Timestamp is a valid ISO string
        expect(isNaN(Date.parse(parsed.timestamp))).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
