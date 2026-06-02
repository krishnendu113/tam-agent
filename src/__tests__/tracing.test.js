import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We dynamically import the module after manipulating env vars
let tracingModule;

describe('src/tracing.js - LangFuse Tracing Module', () => {
  describe('No-Op Mode (env vars missing)', () => {
    beforeEach(async () => {
      // Clear env vars to trigger no-op mode
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_BASE_URL;

      // Fresh import to reset module state
      tracingModule = await import('../tracing.js');
      tracingModule.initTracing();
    });

    it('isNoOpMode returns true when env vars are missing', () => {
      expect(tracingModule.isNoOpMode()).toBe(true);
    });

    it('createTrace returns a no-op trace without throwing', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        clientTag: 'PROJ',
        queryText: 'hello',
      });

      expect(trace).toBeDefined();
      expect(() => trace.span({ name: 'test' })).not.toThrow();
      expect(() => trace.generation({ name: 'test' })).not.toThrow();
    });

    it('startSpan returns a no-op span without throwing', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        clientTag: 'PROJ',
        queryText: 'hello',
      });
      const span = tracingModule.startSpan(trace, 'preflight', { query: 'test' });

      expect(span).toBeDefined();
      expect(() => span.end()).not.toThrow();
    });

    it('endSpan completes without throwing', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        clientTag: 'PROJ',
        queryText: 'hello',
      });
      const span = tracingModule.startSpan(trace, 'phase', {});

      expect(() => tracingModule.endSpan(span, { result: 'ok' })).not.toThrow();
    });

    it('startGeneration returns a no-op generation without throwing', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        clientTag: 'PROJ',
        queryText: 'hello',
      });
      const gen = tracingModule.startGeneration(trace, {
        model: 'haiku',
        inputMessages: [{ role: 'user', content: 'hi' }],
        modelId: 'anthropic.claude-3-haiku',
        clientTag: 'PROJ',
      });

      expect(gen).toBeDefined();
      expect(() => gen.end()).not.toThrow();
    });

    it('endGeneration completes without throwing', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        clientTag: 'PROJ',
        queryText: 'hello',
      });
      const gen = tracingModule.startGeneration(trace, {
        model: 'sonnet',
        inputMessages: [],
        modelId: 'anthropic.claude-3-sonnet',
      });

      expect(() => tracingModule.endGeneration(gen, 'response text', {
        input_tokens: 100,
        output_tokens: 200,
      })).not.toThrow();
    });

    it('flushTracing resolves without throwing', async () => {
      await expect(tracingModule.flushTracing()).resolves.toBeUndefined();
    });

    it('full lifecycle works in no-op mode without errors', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-2',
        userId: 'user-2',
        sessionId: 'sess-2',
        clientTag: 'CAP',
        queryText: 'complex query',
      });

      const span1 = tracingModule.startSpan(trace, 'preflight', { query: 'complex query' });
      tracingModule.endSpan(span1, { onTopic: true });

      const span2 = tracingModule.startSpan(trace, 'research', { domains: ['jira'] });
      const gen = tracingModule.startGeneration(trace, {
        model: 'haiku',
        inputMessages: [{ role: 'user', content: 'research' }],
        modelId: 'anthropic.claude-3-haiku',
        clientTag: 'CAP',
      });
      tracingModule.endGeneration(gen, 'research result', {
        input_tokens: 50,
        output_tokens: 100,
      });
      tracingModule.endSpan(span2, { result: 'done' });
    });
  });

  describe('Model Pricing Configuration', () => {
    beforeEach(async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_BASE_URL;

      tracingModule = await import('../tracing.js');
      tracingModule.initTracing();
    });

    it('returns default pricing when env vars are not set', () => {
      delete process.env.HAIKU_INPUT_COST_PER_1K;
      delete process.env.HAIKU_OUTPUT_COST_PER_1K;
      delete process.env.SONNET_INPUT_COST_PER_1K;
      delete process.env.SONNET_OUTPUT_COST_PER_1K;

      const pricing = tracingModule.getModelPricing();

      expect(pricing.haiku.input).toBe(0.00025);
      expect(pricing.haiku.output).toBe(0.00125);
      expect(pricing.sonnet.input).toBe(0.003);
      expect(pricing.sonnet.output).toBe(0.015);
    });
  });

  describe('Active Mode (env vars present)', () => {
    let mockLangfuse;
    let mockTrace;
    let mockSpan;
    let mockGeneration;

    beforeEach(async () => {
      // Set env vars to activate tracing
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-123';
      process.env.LANGFUSE_SECRET_KEY = 'sk-test-456';
      process.env.LANGFUSE_BASE_URL = 'http://localhost:3000';

      tracingModule = await import('../tracing.js');
      tracingModule.initTracing();
    });

    afterEach(() => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_BASE_URL;
    });

    it('isNoOpMode returns false when all env vars are set', () => {
      expect(tracingModule.isNoOpMode()).toBe(false);
    });

    it('createTrace returns a real trace object', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-active-1',
        userId: 'user-active-1',
        sessionId: 'sess-active-1',
        clientTag: 'TEST',
        queryText: 'what is this?',
      });

      expect(trace).toBeDefined();
      expect(typeof trace.span).toBe('function');
      expect(typeof trace.generation).toBe('function');
    });

    it('startSpan returns a real span object', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-active-2',
        userId: 'user-active-2',
        sessionId: 'sess-active-2',
        clientTag: 'TEST',
        queryText: 'test query',
      });

      const span = tracingModule.startSpan(trace, 'preflight', { query: 'test' });
      expect(span).toBeDefined();
      expect(typeof span.end).toBe('function');
    });

    it('endSpan completes without error on real span', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-active-3',
        userId: 'user-active-3',
        sessionId: 'sess-active-3',
        clientTag: 'TEST',
        queryText: 'test',
      });

      const span = tracingModule.startSpan(trace, 'synthesis', { data: 'input' });
      expect(() => tracingModule.endSpan(span, { result: 'done' })).not.toThrow();
    });

    it('startGeneration returns a real generation object', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-active-4',
        userId: 'user-active-4',
        sessionId: 'sess-active-4',
        clientTag: 'TEST',
        queryText: 'test',
      });

      const gen = tracingModule.startGeneration(trace, {
        model: 'haiku',
        inputMessages: [{ role: 'user', content: 'hello' }],
        modelId: 'anthropic.claude-3-haiku',
        clientTag: 'TEST',
      });

      expect(gen).toBeDefined();
      expect(typeof gen.end).toBe('function');
    });

    it('endGeneration completes without error on real generation', () => {
      const trace = tracingModule.createTrace({
        requestId: 'req-active-5',
        userId: 'user-active-5',
        sessionId: 'sess-active-5',
        clientTag: 'TEST',
        queryText: 'test',
      });

      const gen = tracingModule.startGeneration(trace, {
        model: 'sonnet',
        inputMessages: [],
        modelId: 'anthropic.claude-3-5-sonnet',
        clientTag: 'TEST',
      });

      expect(() => tracingModule.endGeneration(gen, 'output text', {
        input_tokens: 200,
        output_tokens: 500,
      })).not.toThrow();
    });

    it('flushTracing resolves without error', async () => {
      // Even though network will fail (localhost:3000 isn't running),
      // flushAsync should resolve without throwing in the test
      await expect(tracingModule.flushTracing()).resolves.toBeUndefined();
    });
  });

  describe('shutdownTracing', () => {
    beforeEach(async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_BASE_URL;

      tracingModule = await import('../tracing.js');
    });

    it('sets noOpMode to true after shutdown', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-test';
      process.env.LANGFUSE_BASE_URL = 'http://localhost:3000';
      tracingModule.initTracing();

      expect(tracingModule.isNoOpMode()).toBe(false);

      await tracingModule.shutdownTracing();

      expect(tracingModule.isNoOpMode()).toBe(true);
    });
  });
});
