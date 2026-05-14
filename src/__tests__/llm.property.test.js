import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { normalizeResponse } from '../llm.js';

// --- Generators ---

/**
 * Generates a random text content block.
 */
function arbTextBlock() {
  return fc.record({
    type: fc.constant('text'),
    text: fc.string({ minLength: 0, maxLength: 200 }),
  });
}

/**
 * Generates a random tool_use content block.
 */
function arbToolUseBlock() {
  return fc.record({
    type: fc.constant('tool_use'),
    id: fc.string({ minLength: 1, maxLength: 50 }).map((s) => `toolu_${s}`),
    name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[a-zA-Z_]/.test(s)),
    input: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]/.test(s)),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
    ),
  });
}

/**
 * Generates either a text or tool_use content block.
 */
function arbContentBlock() {
  return fc.oneof(arbTextBlock(), arbToolUseBlock());
}

/**
 * Generates a full Bedrock response envelope.
 */
function arbBedrockResponse() {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 30 }).map((s) => `msg_${s}`),
    type: fc.constant('message'),
    role: fc.constant('assistant'),
    content: fc.array(arbContentBlock(), { minLength: 0, maxLength: 5 }),
    model: fc.string({ minLength: 1, maxLength: 60 }),
    stop_reason: fc.constantFrom('end_turn', 'tool_use', 'max_tokens'),
    stop_sequence: fc.constant(null),
    usage: fc.record({
      input_tokens: fc.nat({ max: 100000 }),
      output_tokens: fc.nat({ max: 100000 }),
    }),
  });
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 1: Response Normalization Structure', () => {
  /**
   * Validates: Requirements 1.3, 11.1, 11.2, 11.3
   */
  it('For any valid Bedrock response, normalized output has correct structure with role, content array, stop_reason, and usage', () => {
    fc.assert(
      fc.property(arbBedrockResponse(), (bedrockResponse) => {
        const result = normalizeResponse(bedrockResponse);

        // Top-level structure
        expect(result.role).toBe('assistant');
        expect(Array.isArray(result.content)).toBe(true);
        expect(typeof result.stop_reason).toBe('string');
        expect(typeof result.usage).toBe('object');
        expect(typeof result.usage.input_tokens).toBe('number');
        expect(typeof result.usage.output_tokens).toBe('number');

        // Only expected keys at top level
        const keys = Object.keys(result).sort();
        expect(keys).toEqual(['content', 'role', 'stop_reason', 'usage'].sort());

        // Each content block has correct structure
        for (const block of result.content) {
          if (block.type === 'text') {
            expect(typeof block.text).toBe('string');
            const blockKeys = Object.keys(block).sort();
            expect(blockKeys).toEqual(['text', 'type'].sort());
          } else if (block.type === 'tool_use') {
            expect(typeof block.id).toBe('string');
            expect(typeof block.name).toBe('string');
            expect(typeof block.input).toBe('object');
            const blockKeys = Object.keys(block).sort();
            expect(blockKeys).toEqual(['id', 'input', 'name', 'type'].sort());
          } else {
            // Should never reach here — type must be "text" or "tool_use"
            expect.fail(`Unexpected content block type: ${block.type}`);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 2: Response Serialization Round-Trip', () => {
  /**
   * Validates: Requirements 11.4
   */
  it('For any normalized response, JSON serialize/parse produces deeply equal object', () => {
    fc.assert(
      fc.property(arbBedrockResponse(), (bedrockResponse) => {
        const normalized = normalizeResponse(bedrockResponse);
        const roundTripped = JSON.parse(JSON.stringify(normalized));

        expect(roundTripped).toEqual(normalized);
      }),
      { numRuns: 100 }
    );
  });
});
