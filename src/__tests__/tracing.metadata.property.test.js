import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

/**
 * Property 20: Trace Metadata Propagation
 *
 * For any request with a Client_Tag value, that tag SHALL appear unchanged on
 * the LangFuse Trace metadata and on every Generation recorded within that trace.
 * For any token usage values (input_tokens, output_tokens) returned by Bedrock,
 * those exact numeric values SHALL appear in the corresponding LangFuse generation
 * usage field.
 *
 * **Validates: Requirements 11.7, 11.8**
 */

// --- Mock Setup ---

// Capture calls made to Langfuse SDK
let capturedTraceArgs = [];
let capturedGenerationArgs = [];
let capturedGenerationEndArgs = [];

const mockGenerationEnd = vi.fn((args) => {
  capturedGenerationEndArgs.push(args);
  return mockGeneration;
});

const mockGeneration = {
  end: mockGenerationEnd,
  update: vi.fn(() => mockGeneration),
};

const mockTrace = {
  span: vi.fn(() => mockSpan),
  generation: vi.fn((args) => {
    capturedGenerationArgs.push(args);
    return mockGeneration;
  }),
  update: vi.fn(() => mockTrace),
};

const mockSpan = {
  end: vi.fn(() => mockSpan),
  update: vi.fn(() => mockSpan),
  span: vi.fn(() => mockSpan),
  generation: vi.fn((args) => {
    capturedGenerationArgs.push(args);
    return mockGeneration;
  }),
};

const mockLangfuseInstance = {
  trace: vi.fn((args) => {
    capturedTraceArgs.push(args);
    return mockTrace;
  }),
  flushAsync: vi.fn().mockResolvedValue(undefined),
  shutdownAsync: vi.fn().mockResolvedValue(undefined),
};

// Mock langfuse module
vi.mock('langfuse', () => ({
  Langfuse: vi.fn(() => mockLangfuseInstance),
}));

// --- Generators ---

/**
 * Generates arbitrary non-empty clientTag strings (printable ASCII).
 */
function arbClientTag() {
  return fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0);
}

/**
 * Generates arbitrary positive token usage values.
 */
function arbTokenUsage() {
  return fc.record({
    input_tokens: fc.integer({ min: 1, max: 1_000_000 }),
    output_tokens: fc.integer({ min: 1, max: 1_000_000 }),
  });
}

/**
 * Generates arbitrary model names from valid options.
 */
function arbModel() {
  return fc.constantFrom('haiku', 'sonnet');
}

// --- Property Tests ---

describe('Property 20: Trace Metadata Propagation', () => {
  let tracingModule;

  beforeEach(async () => {
    // Reset captured data
    capturedTraceArgs = [];
    capturedGenerationArgs = [];
    capturedGenerationEndArgs = [];

    vi.clearAllMocks();

    // Set env vars for active (non-no-op) mode
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-prop20';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-prop20';
    process.env.LANGFUSE_BASE_URL = 'http://localhost:3000';

    // Fresh import to pick up the mocked langfuse
    tracingModule = await import('../tracing.js');
    tracingModule.initTracing();
  });

  afterEach(() => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
  });

  /**
   * Validates: Requirements 11.8
   *
   * For any clientTag string, createTrace SHALL pass that exact tag unchanged
   * in the trace metadata.
   */
  it('clientTag appears unchanged on the LangFuse Trace metadata', () => {
    fc.assert(
      fc.property(arbClientTag(), (clientTag) => {
        capturedTraceArgs = [];

        tracingModule.createTrace({
          requestId: 'req-prop20',
          userId: 'user-prop20',
          sessionId: 'sess-prop20',
          clientTag,
          queryText: 'test query',
        });

        expect(capturedTraceArgs.length).toBe(1);
        expect(capturedTraceArgs[0].metadata.clientTag).toBe(clientTag);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 11.8
   *
   * For any clientTag string, startGeneration SHALL pass that exact tag unchanged
   * in the generation metadata.
   */
  it('clientTag appears unchanged on every Generation metadata', () => {
    fc.assert(
      fc.property(arbClientTag(), arbModel(), (clientTag, model) => {
        capturedGenerationArgs = [];

        const trace = tracingModule.createTrace({
          requestId: 'req-prop20-gen',
          userId: 'user-prop20-gen',
          sessionId: 'sess-prop20-gen',
          clientTag,
          queryText: 'generation test',
        });

        tracingModule.startGeneration(trace, {
          model,
          inputMessages: [{ role: 'user', content: 'hello' }],
          modelId: `anthropic.claude-3-${model}`,
          clientTag,
        });

        expect(capturedGenerationArgs.length).toBe(1);
        expect(capturedGenerationArgs[0].metadata.clientTag).toBe(clientTag);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 11.7
   *
   * For any token usage values (input_tokens, output_tokens), endGeneration SHALL
   * pass those exact numeric values to the generation's end call in the usage field.
   */
  it('token usage values appear exactly in the LangFuse generation usage field', () => {
    fc.assert(
      fc.property(arbTokenUsage(), arbModel(), (usage, model) => {
        capturedGenerationEndArgs = [];

        const trace = tracingModule.createTrace({
          requestId: 'req-prop20-usage',
          userId: 'user-prop20-usage',
          sessionId: 'sess-prop20-usage',
          clientTag: 'TEST',
          queryText: 'usage test',
        });

        const generation = tracingModule.startGeneration(trace, {
          model,
          inputMessages: [{ role: 'user', content: 'test' }],
          modelId: `anthropic.claude-3-${model}`,
          clientTag: 'TEST',
        });

        tracingModule.endGeneration(generation, 'response output', usage);

        expect(capturedGenerationEndArgs.length).toBe(1);
        expect(capturedGenerationEndArgs[0].usage.input).toBe(usage.input_tokens);
        expect(capturedGenerationEndArgs[0].usage.output).toBe(usage.output_tokens);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 11.7, 11.8
   *
   * Combined property: For any clientTag and usage values in a full trace lifecycle,
   * the clientTag propagates to both trace and generation, and usage values propagate
   * to the generation end call exactly.
   */
  it('full lifecycle propagates clientTag and usage correctly', () => {
    fc.assert(
      fc.property(
        arbClientTag(),
        arbTokenUsage(),
        arbModel(),
        (clientTag, usage, model) => {
          capturedTraceArgs = [];
          capturedGenerationArgs = [];
          capturedGenerationEndArgs = [];

          const trace = tracingModule.createTrace({
            requestId: 'req-prop20-full',
            userId: 'user-prop20-full',
            sessionId: 'sess-prop20-full',
            clientTag,
            queryText: 'full lifecycle test',
          });

          const generation = tracingModule.startGeneration(trace, {
            model,
            inputMessages: [{ role: 'user', content: 'query' }],
            modelId: `anthropic.claude-3-${model}`,
            clientTag,
          });

          tracingModule.endGeneration(generation, 'model response', usage);

          // clientTag on trace
          expect(capturedTraceArgs[0].metadata.clientTag).toBe(clientTag);
          // clientTag on generation
          expect(capturedGenerationArgs[0].metadata.clientTag).toBe(clientTag);
          // exact token usage values
          expect(capturedGenerationEndArgs[0].usage.input).toBe(usage.input_tokens);
          expect(capturedGenerationEndArgs[0].usage.output).toBe(usage.output_tokens);
        }
      ),
      { numRuns: 100 }
    );
  });
});
