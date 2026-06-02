import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the langfuse module to detect if any network activity occurs
vi.mock('langfuse', () => ({
  Langfuse: vi.fn(() => {
    throw new Error('Langfuse constructor should NOT be called in no-op mode');
  }),
}));

// --- Generators ---

/**
 * Generates arbitrary trace metadata values.
 */
function arbTraceMetadata() {
  return fc.record({
    requestId: fc.string({ minLength: 1, maxLength: 50 }),
    userId: fc.string({ minLength: 1, maxLength: 50 }),
    sessionId: fc.string({ minLength: 1, maxLength: 50 }),
    clientTag: fc.string({ minLength: 0, maxLength: 50 }),
    queryText: fc.string({ minLength: 0, maxLength: 200 }),
  });
}

/**
 * Generates arbitrary span names.
 */
function arbSpanName() {
  return fc.constantFrom('preflight', 'skill-loading', 'research', 'synthesis', 'compaction');
}

/**
 * Generates arbitrary input/output data for spans and generations.
 */
function arbData() {
  return fc.oneof(
    fc.string({ minLength: 0, maxLength: 100 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ maxLength: 50 })),
    fc.array(fc.string({ maxLength: 30 }), { maxLength: 5 }),
    fc.constant(null),
    fc.constant(undefined)
  );
}

/**
 * Generates arbitrary generation params.
 */
function arbGenerationParams() {
  return fc.record({
    model: fc.constantFrom('haiku', 'sonnet'),
    inputMessages: fc.array(
      fc.record({
        role: fc.constantFrom('user', 'assistant'),
        content: fc.string({ minLength: 1, maxLength: 100 }),
      }),
      { minLength: 1, maxLength: 5 }
    ),
    modelId: fc.string({ minLength: 1, maxLength: 50 }),
    clientTag: fc.string({ minLength: 0, maxLength: 30 }),
  });
}

/**
 * Generates arbitrary token usage values.
 */
function arbTokenUsage() {
  return fc.record({
    input_tokens: fc.integer({ min: 0, max: 100000 }),
    output_tokens: fc.integer({ min: 0, max: 100000 }),
  });
}

/**
 * Generates an arbitrary sequence of tracing operations.
 * Each operation is a function that calls tracing APIs.
 */
function arbTracingOperation() {
  return fc.constantFrom(
    'createTrace',
    'startSpan',
    'endSpan',
    'startGeneration',
    'endGeneration',
    'flushTracing'
  );
}

/**
 * Generates a random sequence of tracing operations.
 */
function arbOperationSequence() {
  return fc.array(arbTracingOperation(), { minLength: 1, maxLength: 20 });
}

// --- Property Tests ---

describe('Feature: skill-system-enhancement, Property 19: Tracing No-Op Mode Safety', () => {
  let tracingModule;

  beforeEach(async () => {
    // Ensure LANGFUSE env vars are NOT set
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;

    // Reset the module between tests to ensure clean state
    vi.resetModules();

    // Re-import after resetting modules
    tracingModule = await import('../tracing.js');

    // Initialize tracing in no-op mode (env vars not set)
    tracingModule.initTracing();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * **Validates: Requirements 11.2**
   *
   * For any sequence of tracing function calls when LangFuse env vars are not
   * configured, all calls SHALL complete without throwing exceptions and SHALL
   * not emit network requests.
   */
  it('All tracing calls complete without throwing in no-op mode for arbitrary metadata', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbTraceMetadata(),
        arbSpanName(),
        arbData(),
        arbGenerationParams(),
        arbTokenUsage(),
        async (metadata, spanName, data, genParams, usage) => {
          // Verify we are in no-op mode
          expect(tracingModule.isNoOpMode()).toBe(true);

          // createTrace should not throw and return a defined object
          const trace = tracingModule.createTrace(metadata);
          expect(trace).toBeDefined();
          expect(trace).not.toBeNull();

          // startSpan should not throw and return a defined object
          const span = tracingModule.startSpan(trace, spanName, data);
          expect(span).toBeDefined();
          expect(span).not.toBeNull();

          // endSpan should not throw
          tracingModule.endSpan(span, data);

          // startGeneration should not throw and return a defined object
          const generation = tracingModule.startGeneration(trace, genParams);
          expect(generation).toBeDefined();
          expect(generation).not.toBeNull();

          // endGeneration should not throw
          tracingModule.endGeneration(generation, data, usage);

          // flushTracing should not throw
          await tracingModule.flushTracing();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 11.2**
   *
   * For any arbitrary sequence of tracing operations in random order,
   * no operation SHALL throw when env vars are not configured.
   */
  it('Arbitrary sequences of tracing operations never throw in no-op mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbOperationSequence(),
        arbTraceMetadata(),
        arbSpanName(),
        arbData(),
        arbGenerationParams(),
        arbTokenUsage(),
        async (operations, metadata, spanName, data, genParams, usage) => {
          expect(tracingModule.isNoOpMode()).toBe(true);

          // Execute operations in sequence — none should throw
          let trace = null;
          let span = null;
          let generation = null;

          for (const op of operations) {
            switch (op) {
              case 'createTrace':
                trace = tracingModule.createTrace(metadata);
                expect(trace).toBeDefined();
                break;
              case 'startSpan':
                span = tracingModule.startSpan(trace || {}, spanName, data);
                expect(span).toBeDefined();
                break;
              case 'endSpan':
                tracingModule.endSpan(span || {}, data);
                break;
              case 'startGeneration':
                generation = tracingModule.startGeneration(trace || {}, genParams);
                expect(generation).toBeDefined();
                break;
              case 'endGeneration':
                tracingModule.endGeneration(generation || {}, data, usage);
                break;
              case 'flushTracing':
                await tracingModule.flushTracing();
                break;
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 11.2**
   *
   * The Langfuse constructor is never called (no network activity) when
   * env vars are not configured, regardless of tracing operations performed.
   */
  it('No Langfuse client is instantiated in no-op mode (no network requests)', async () => {
    const { Langfuse } = await import('langfuse');

    await fc.assert(
      fc.asyncProperty(arbTraceMetadata(), async (metadata) => {
        expect(tracingModule.isNoOpMode()).toBe(true);

        // Perform tracing operations
        const trace = tracingModule.createTrace(metadata);
        const span = tracingModule.startSpan(trace, 'test-span', { test: true });
        tracingModule.endSpan(span, { result: 'ok' });
        const gen = tracingModule.startGeneration(trace, {
          model: 'haiku',
          inputMessages: [{ role: 'user', content: 'hello' }],
          modelId: 'test-model',
        });
        tracingModule.endGeneration(gen, 'response', { input_tokens: 10, output_tokens: 5 });
        await tracingModule.flushTracing();

        // Langfuse constructor should never have been called
        expect(Langfuse).not.toHaveBeenCalled();
      }),
      { numRuns: 50 }
    );
  });
});
