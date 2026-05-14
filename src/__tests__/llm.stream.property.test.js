import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  normalizeStreamEvent,
  streamMessage,
  getBedrockClient,
  resetBedrockClient,
} from '../llm.js';

// --- Helpers ---

/**
 * Creates a fresh accumulator for stream event processing.
 */
function createAccumulator() {
  return {
    contentBlocks: [],
    currentBlockIndex: -1,
    inputJsonParts: [],
    stopReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Encodes an event as a Bedrock stream chunk.
 */
function encodeChunk(event) {
  return {
    chunk: {
      bytes: new TextEncoder().encode(JSON.stringify(event)),
    },
  };
}

// --- Generators ---

/**
 * Generates a valid tool name (starts with letter, alphanumeric + underscores).
 */
function arbToolName() {
  return fc
    .tuple(
      fc.constantFrom('a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z'),
      fc.stringMatching(/^[a-z0-9_]{0,19}$/)
    )
    .map(([first, rest]) => first + rest);
}

/**
 * Generates a valid tool ID (e.g., "toolu_01XYZ").
 */
function arbToolId() {
  return fc.stringMatching(/^[a-zA-Z0-9]{3,12}$/).map((s) => `toolu_${s}`);
}

/**
 * Generates a simple JSON-serializable object for tool input.
 */
function arbToolInput() {
  return fc.dictionary(
    fc.stringMatching(/^[a-z][a-z0-9_]{0,9}$/),
    fc.oneof(fc.string({ minLength: 0, maxLength: 30 }), fc.integer(), fc.boolean()),
    { minKeys: 0, maxKeys: 4 }
  );
}

/**
 * Generates a text content block definition for stream sequences.
 */
function arbTextBlockDef() {
  return fc.record({
    type: fc.constant('text'),
    deltas: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
  });
}

/**
 * Generates a tool_use content block definition for stream sequences.
 */
function arbToolUseBlockDef() {
  return fc.record({
    type: fc.constant('tool_use'),
    id: arbToolId(),
    name: arbToolName(),
    input: arbToolInput(),
  });
}

/**
 * Generates a content block definition (either text or tool_use).
 */
function arbContentBlockDef() {
  return fc.oneof(arbTextBlockDef(), arbToolUseBlockDef());
}

/**
 * Generates a valid sequence of Bedrock stream events.
 * Structure: message_start → (content_block_start → content_block_delta(s) → content_block_stop)* → message_delta → message_stop
 */
function arbStreamEventSequence() {
  return fc.record({
    inputTokens: fc.nat({ max: 10000 }),
    outputTokens: fc.nat({ max: 10000 }),
    stopReason: fc.constantFrom('end_turn', 'tool_use', 'max_tokens'),
    blocks: fc.array(arbContentBlockDef(), { minLength: 1, maxLength: 4 }),
  }).map(({ inputTokens, outputTokens, stopReason, blocks }) => {
    const events = [];

    // message_start
    events.push({
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet',
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });

    // Content blocks
    blocks.forEach((block, index) => {
      if (block.type === 'text') {
        events.push({
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        for (const delta of block.deltas) {
          events.push({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: delta },
          });
        }
        events.push({ type: 'content_block_stop', index });
      } else {
        // tool_use
        events.push({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
        // Split the JSON input into partial chunks
        const jsonStr = JSON.stringify(block.input);
        const midpoint = Math.floor(jsonStr.length / 2);
        const parts = midpoint > 0
          ? [jsonStr.slice(0, midpoint), jsonStr.slice(midpoint)]
          : [jsonStr];
        for (const part of parts) {
          events.push({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: part },
          });
        }
        events.push({ type: 'content_block_stop', index });
      }
    });

    // message_delta
    events.push({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });

    // message_stop
    events.push({ type: 'message_stop' });

    return { events, inputTokens, outputTokens, stopReason, blocks };
  });
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 5: Stream Event Normalization', () => {
  /**
   * **Validates: Requirements 2.4, 2.5, 2.6**
   *
   * For any valid Bedrock stream event sequence, each text_delta event SHALL yield
   * a normalized event with type: "text" and matching text content, each tool_use
   * content_block_start SHALL yield type: "tool_use_start" with correct id and name,
   * and each input_json_delta SHALL yield type: "tool_input_delta" with the partial JSON string.
   */
  it('normalizes text_delta, tool_use_start, and input_json_delta events correctly', () => {
    fc.assert(
      fc.property(arbStreamEventSequence(), ({ events, blocks }) => {
        const accumulator = createAccumulator();
        const allNormalized = [];

        for (const event of events) {
          const normalized = normalizeStreamEvent(event, accumulator);
          allNormalized.push(...normalized);
        }

        // Verify text_delta events
        let normalizedIdx = 0;
        for (const block of blocks) {
          if (block.type === 'text') {
            for (const delta of block.deltas) {
              // Find the next text event
              while (normalizedIdx < allNormalized.length && allNormalized[normalizedIdx].type !== 'text') {
                normalizedIdx++;
              }
              expect(normalizedIdx).toBeLessThan(allNormalized.length);
              expect(allNormalized[normalizedIdx].type).toBe('text');
              expect(allNormalized[normalizedIdx].text).toBe(delta);
              normalizedIdx++;
            }
          } else {
            // tool_use block: expect tool_use_start followed by tool_input_delta(s)
            while (normalizedIdx < allNormalized.length && allNormalized[normalizedIdx].type !== 'tool_use_start') {
              normalizedIdx++;
            }
            expect(normalizedIdx).toBeLessThan(allNormalized.length);
            expect(allNormalized[normalizedIdx].type).toBe('tool_use_start');
            expect(allNormalized[normalizedIdx].id).toBe(block.id);
            expect(allNormalized[normalizedIdx].name).toBe(block.name);
            normalizedIdx++;

            // Verify input_json_delta events
            const jsonStr = JSON.stringify(block.input);
            const midpoint = Math.floor(jsonStr.length / 2);
            const expectedParts = midpoint > 0
              ? [jsonStr.slice(0, midpoint), jsonStr.slice(midpoint)]
              : [jsonStr];

            for (const part of expectedParts) {
              while (normalizedIdx < allNormalized.length && allNormalized[normalizedIdx].type !== 'tool_input_delta') {
                normalizedIdx++;
              }
              expect(normalizedIdx).toBeLessThan(allNormalized.length);
              expect(allNormalized[normalizedIdx].type).toBe('tool_input_delta');
              expect(allNormalized[normalizedIdx].partialJson).toBe(part);
              normalizedIdx++;
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 6: Stream Message Assembly', () => {
  /**
   * **Validates: Requirements 2.7**
   *
   * For any complete sequence of Bedrock stream events ending with message_stop,
   * the final message_complete event SHALL contain a correctly assembled response
   * with all accumulated content blocks, the correct stop_reason, and usage statistics.
   */
  it('message_complete contains all accumulated content blocks, correct stop_reason, and usage', () => {
    fc.assert(
      fc.property(arbStreamEventSequence(), ({ events, inputTokens, outputTokens, stopReason, blocks }) => {
        const accumulator = createAccumulator();
        const allNormalized = [];

        for (const event of events) {
          const normalized = normalizeStreamEvent(event, accumulator);
          allNormalized.push(...normalized);
        }

        // The last normalized event should be message_complete
        const lastEvent = allNormalized[allNormalized.length - 1];
        expect(lastEvent.type).toBe('message_complete');

        const response = lastEvent.response;

        // Correct role
        expect(response.role).toBe('assistant');

        // Correct stop_reason
        expect(response.stop_reason).toBe(stopReason);

        // Correct usage
        expect(response.usage.input_tokens).toBe(inputTokens);
        expect(response.usage.output_tokens).toBe(outputTokens);

        // Correct number of content blocks
        expect(response.content.length).toBe(blocks.length);

        // Verify each content block
        for (let i = 0; i < blocks.length; i++) {
          const blockDef = blocks[i];
          const contentBlock = response.content[i];

          if (blockDef.type === 'text') {
            expect(contentBlock.type).toBe('text');
            // Text should be the concatenation of all deltas
            const expectedText = blockDef.deltas.join('');
            expect(contentBlock.text).toBe(expectedText);
          } else {
            // tool_use
            expect(contentBlock.type).toBe('tool_use');
            expect(contentBlock.id).toBe(blockDef.id);
            expect(contentBlock.name).toBe(blockDef.name);
            expect(contentBlock.input).toEqual(blockDef.input);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 7: Stream Error Termination', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_SONNET_MODEL_ID = 'anthropic.claude-sonnet-4-20250514-v1:0';
    resetBedrockClient();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetBedrockClient();
    vi.restoreAllMocks();
  });

  /**
   * **Validates: Requirements 2.8**
   *
   * For any error occurring during Bedrock stream processing, the stream SHALL yield
   * exactly one event with type: "error" containing error details, and then terminate
   * the async iterable.
   */
  it('yields exactly one error event then terminates on mid-stream error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          errorMessage: fc.string({ minLength: 1, maxLength: 100 }),
          errorName: fc.constantFrom(
            'InternalServerException',
            'ThrottlingException',
            'ModelTimeoutException',
            'NetworkError',
            'ServiceUnavailableException'
          ),
          httpStatusCode: fc.integer({ min: 400, max: 599 }),
          // Number of valid events to yield before the error
          eventsBeforeError: fc.integer({ min: 0, max: 3 }),
        }),
        async ({ errorMessage, errorName, httpStatusCode, eventsBeforeError }) => {
          resetBedrockClient();
          const client = getBedrockClient();

          // Build a sequence of valid events to yield before the error
          const validEvents = [
            {
              type: 'message_start',
              message: { id: 'msg_01', usage: { input_tokens: 10, output_tokens: 0 } },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'partial' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: ' response' },
            },
          ];

          const eventsToYield = validEvents.slice(0, eventsBeforeError);

          // Create an async iterable that yields some events then throws
          async function* failingStream() {
            for (const evt of eventsToYield) {
              yield encodeChunk(evt);
            }
            const err = new Error(errorMessage);
            err.name = errorName;
            err.$metadata = { httpStatusCode };
            throw err;
          }

          vi.spyOn(client, 'send').mockResolvedValue({ body: failingStream() });

          const events = [];
          for await (const event of streamMessage({
            model: 'sonnet',
            system: 'System',
            messages: [{ role: 'user', content: 'Hi' }],
            maxTokens: 1024,
          })) {
            events.push(event);
          }

          // Filter to only error events
          const errorEvents = events.filter((e) => e.type === 'error');

          // Exactly one error event
          expect(errorEvents.length).toBe(1);

          // Error event is the last event
          expect(events[events.length - 1].type).toBe('error');

          // Error event has correct structure
          const errorEvent = errorEvents[0];
          expect(typeof errorEvent.error).toBe('object');
          expect(typeof errorEvent.error.errorType).toBe('string');
          expect(errorEvent.error.errorType.length).toBeGreaterThan(0);
          expect(typeof errorEvent.error.message).toBe('string');
          expect(errorEvent.error.message.length).toBeGreaterThan(0);
          expect(typeof errorEvent.error.statusCode).toBe('number');

          vi.restoreAllMocks();
        }
      ),
      { numRuns: 100 }
    );
  });
});
