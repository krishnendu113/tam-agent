import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the llm module
vi.mock('../llm.js', () => ({
  createMessage: vi.fn(),
  streamMessage: vi.fn(),
}));

// Mock the tools module
vi.mock('../tools/index.js', () => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
}));

// Mock the skillLoader module (imported by agentLoop.js)
vi.mock('../skillLoader.js', () => ({
  getSkillSummary: vi.fn(() => null),
  getRegistryTriggers: vi.fn(() => new Map()),
}));

import { streamMessage } from '../llm.js';
import { executeTool } from '../tools/index.js';
import { synthesisLoop } from '../agentLoop.js';

// --- Generators ---

/**
 * Generates a random tool_use block with random id, name, and input.
 * @returns {fc.Arbitrary<{ type: "tool_use", id: string, name: string, input: object }>}
 */
function arbToolUseBlock() {
  return fc.record({
    type: fc.constant('tool_use'),
    id: fc.string({ minLength: 5, maxLength: 20 }).map(s => `tool_${s.replace(/[^a-zA-Z0-9]/g, 'x')}`),
    name: fc.stringMatching(/^[a-z][a-z0-9_]{2,19}$/),
    input: fc.record({
      query: fc.string({ minLength: 1, maxLength: 50 }),
    }),
  });
}

/**
 * Generates a random tool execution result.
 * @returns {fc.Arbitrary<object>}
 */
function arbToolResult() {
  return fc.oneof(
    fc.record({ data: fc.string({ minLength: 1, maxLength: 100 }) }),
    fc.record({ items: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }) }),
    fc.record({ success: fc.boolean(), message: fc.string({ minLength: 1, maxLength: 50 }) })
  );
}

/**
 * Generates a non-empty array of tool_use blocks (1-3 blocks per iteration).
 * @returns {fc.Arbitrary<Array<{ type: "tool_use", id: string, name: string, input: object }>>}
 */
function arbToolUseBlocks() {
  return fc.array(arbToolUseBlock(), { minLength: 1, maxLength: 3 });
}

/**
 * Generates a sequence of stop_reasons representing a synthesis loop execution.
 * The sequence contains 0+ "tool_use" entries followed by exactly one "end_turn".
 * @returns {fc.Arbitrary<Array<"tool_use" | "end_turn">>}
 */
function arbSynthesisSequence() {
  return fc.nat({ max: 8 }).map(toolUseCount => {
    const sequence = Array(toolUseCount).fill('tool_use');
    sequence.push('end_turn');
    return sequence;
  });
}

// --- Helpers ---

/**
 * Helper to create an async iterable from an array of events.
 */
function createMockStream(events) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

/**
 * Helper to create a standard callbacks object with vi.fn() spies.
 */
function createMockCallbacks() {
  return {
    onToken: vi.fn(),
    onStatus: vi.fn(),
    onPhase: vi.fn(),
    onToolStatus: vi.fn(),
    onSkillActive: vi.fn(),
    onPlanUpdate: vi.fn(),
    onDocumentReady: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
  };
}

/**
 * Helper to create a base state for synthesis loop tests.
 */
function createBaseState() {
  return {
    messages: [{ role: 'user', content: 'Test query' }],
    systemPrompt: 'You are a helpful TAM agent.',
    availableTools: [{ name: 'search', description: 'Search', input_schema: {} }],
  };
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 13: Synthesis Loop Tool Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 7.3, 7.4
   *
   * For any tool_use block completed during synthesis streaming, the Synthesis_Loop
   * SHALL execute the tool handler, append the result to messages, and invoke
   * `callbacks.onToolStatus` with the tool name and execution status.
   */
  it('for any tool_use block, tool handler is executed, result appended, and onToolStatus invoked', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToolUseBlocks(),
        arbToolResult(),
        async (toolUseBlocks, toolResult) => {
          // Reset mocks between iterations
          streamMessage.mockReset();
          executeTool.mockReset();

          // executeTool returns the generated tool result for all calls
          executeTool.mockResolvedValue(toolResult);

          // First stream call: returns tool_use blocks with stop_reason "tool_use"
          const firstStreamEvents = [
            // Emit tool_use_start for each block
            ...toolUseBlocks.map(block => ({
              type: 'tool_use_start',
              id: block.id,
              name: block.name,
            })),
            // Emit message_complete with all tool_use blocks
            {
              type: 'message_complete',
              response: {
                role: 'assistant',
                content: toolUseBlocks,
                stop_reason: 'tool_use',
                usage: { input_tokens: 100, output_tokens: 50 },
              },
            },
          ];

          // Second stream call: returns end_turn to finalize
          const secondStreamEvents = [
            { type: 'text', text: 'Final response' },
            {
              type: 'message_complete',
              response: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Final response' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 200, output_tokens: 100 },
              },
            },
          ];

          streamMessage
            .mockReturnValueOnce(createMockStream(firstStreamEvents))
            .mockReturnValueOnce(createMockStream(secondStreamEvents));

          const state = createBaseState();
          const callbacks = createMockCallbacks();

          const result = await synthesisLoop(state, callbacks);

          // Verify: executeTool was called for each tool_use block with correct args
          expect(executeTool).toHaveBeenCalledTimes(toolUseBlocks.length);
          for (let i = 0; i < toolUseBlocks.length; i++) {
            expect(executeTool).toHaveBeenCalledWith(
              toolUseBlocks[i].name,
              toolUseBlocks[i].input
            );
          }

          // Verify: onToolStatus was invoked for each tool_use block
          // Each block gets 'started' (from tool_use_start event) and 'completed' (after executeTool)
          for (const block of toolUseBlocks) {
            expect(callbacks.onToolStatus).toHaveBeenCalledWith(block.name, 'started');
            expect(callbacks.onToolStatus).toHaveBeenCalledWith(block.name, 'completed');
          }

          // Verify: tool results were appended to messages
          const toolResultMessages = result.messages.filter(
            m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
          );
          expect(toolResultMessages).toHaveLength(toolUseBlocks.length);

          // Verify each tool result message has correct tool_use_id and content
          for (let i = 0; i < toolUseBlocks.length; i++) {
            const msg = toolResultMessages[i];
            expect(msg.content[0].tool_use_id).toBe(toolUseBlocks[i].id);
            expect(JSON.parse(msg.content[0].content)).toEqual(toolResult);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 14: Synthesis Loop Termination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 7.5, 7.6, 7.7
   *
   * For any synthesis loop execution:
   * - stop_reason "tool_use" causes re-invocation (streamMessage called again)
   * - stop_reason "end_turn" causes finalization (onComplete called)
   * - The loop never exceeds 10 iterations
   */
  it('tool_use re-invokes LLM, end_turn finalizes, and loop terminates within max iterations', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSynthesisSequence(),
        arbToolResult(),
        async (stopReasonSequence, toolResult) => {
          // Reset mocks between iterations
          streamMessage.mockReset();
          executeTool.mockReset();

          executeTool.mockResolvedValue(toolResult);

          let callIndex = 0;

          streamMessage.mockImplementation(() => {
            const stopReason = stopReasonSequence[callIndex] || 'end_turn';
            callIndex++;

            if (stopReason === 'tool_use') {
              return createMockStream([
                { type: 'tool_use_start', id: `tool_${callIndex}`, name: 'search_tool' },
                {
                  type: 'message_complete',
                  response: {
                    role: 'assistant',
                    content: [{
                      type: 'tool_use',
                      id: `tool_${callIndex}`,
                      name: 'search_tool',
                      input: { q: 'test' },
                    }],
                    stop_reason: 'tool_use',
                    usage: { input_tokens: 50, output_tokens: 25 },
                  },
                },
              ]);
            } else {
              // end_turn
              return createMockStream([
                { type: 'text', text: 'Done' },
                {
                  type: 'message_complete',
                  response: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Done' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 100, output_tokens: 50 },
                  },
                },
              ]);
            }
          });

          const state = createBaseState();
          const callbacks = createMockCallbacks();

          const result = await synthesisLoop(state, callbacks);

          // The total number of streamMessage calls should equal the sequence length
          // (each tool_use triggers a re-invocation, end_turn finalizes)
          const expectedCalls = stopReasonSequence.length;
          expect(streamMessage).toHaveBeenCalledTimes(expectedCalls);

          // Verify: end_turn causes onComplete to be called
          expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
          expect(callbacks.onComplete).toHaveBeenCalledWith('Done');

          // Verify: finalResponse is set
          expect(result.finalResponse).toBeDefined();
          expect(result.finalResponse.stop_reason).toBe('end_turn');

          // Verify: loop never exceeds 10 iterations
          expect(streamMessage.mock.calls.length).toBeLessThanOrEqual(10);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('loop always terminates within max iterations even with continuous tool_use', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate sequences longer than 10 to test the max iteration guard
        fc.nat({ max: 15 }).map(n => Math.max(n, 11)),
        arbToolResult(),
        async (requestedIterations, toolResult) => {
          // Reset mocks between iterations
          streamMessage.mockReset();
          executeTool.mockReset();

          executeTool.mockResolvedValue(toolResult);

          // Always return tool_use — the loop should still terminate at 10
          streamMessage.mockImplementation(() => {
            return createMockStream([
              { type: 'tool_use_start', id: 'tool_inf', name: 'infinite_tool' },
              {
                type: 'message_complete',
                response: {
                  role: 'assistant',
                  content: [{
                    type: 'tool_use',
                    id: 'tool_inf',
                    name: 'infinite_tool',
                    input: {},
                  }],
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 10, output_tokens: 5 },
                },
              },
            ]);
          });

          const state = createBaseState();
          const callbacks = createMockCallbacks();

          const result = await synthesisLoop(state, callbacks);

          // Loop MUST terminate at exactly 10 iterations (MAX_ITERATIONS)
          expect(streamMessage).toHaveBeenCalledTimes(10);

          // onStatus called with max iterations warning
          expect(callbacks.onStatus).toHaveBeenCalledWith(
            'Warning: maximum synthesis iterations reached'
          );

          // onComplete is still called (graceful termination)
          expect(callbacks.onComplete).toHaveBeenCalledTimes(1);

          // finalResponse is null when max iterations reached
          expect(result.finalResponse).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});
