import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logLLMCall, logRequestComplete, logEvent } from '../logger.js';

describe('src/logger.js - Structured JSON Logger', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('logLLMCall', () => {
    it('emits valid JSON with all required fields', () => {
      const params = {
        model: 'haiku',
        input_tokens: 150,
        output_tokens: 200,
        latency_ms: 450,
        client_tag: 'PROJ',
        session_id: 'sess-123',
        request_id: 'req-456',
      };

      logLLMCall(params);

      expect(consoleSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(output.timestamp).toBeDefined();
      expect(output.level).toBe('info');
      expect(output.event).toBe('llm_call');
      expect(output.model).toBe('haiku');
      expect(output.input_tokens).toBe(150);
      expect(output.output_tokens).toBe(200);
      expect(output.latency_ms).toBe(450);
      expect(output.client_tag).toBe('PROJ');
      expect(output.session_id).toBe('sess-123');
      expect(output.request_id).toBe('req-456');
    });

    it('emits a valid ISO timestamp', () => {
      logLLMCall({
        model: 'sonnet',
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        client_tag: '',
        session_id: '',
        request_id: '',
      });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(() => new Date(output.timestamp)).not.toThrow();
      expect(new Date(output.timestamp).toISOString()).toBe(output.timestamp);
    });
  });

  describe('logRequestComplete', () => {
    it('emits valid JSON with all required fields', () => {
      const params = {
        total_latency_ms: 2500,
        total_input_tokens: 1000,
        total_output_tokens: 800,
        llm_call_count: 3,
        client_tag: 'CAP',
        session_id: 'sess-789',
        request_id: 'req-012',
      };

      logRequestComplete(params);

      expect(consoleSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(output.timestamp).toBeDefined();
      expect(output.level).toBe('info');
      expect(output.event).toBe('request_complete');
      expect(output.total_latency_ms).toBe(2500);
      expect(output.total_input_tokens).toBe(1000);
      expect(output.total_output_tokens).toBe(800);
      expect(output.llm_call_count).toBe(3);
      expect(output.client_tag).toBe('CAP');
      expect(output.session_id).toBe('sess-789');
      expect(output.request_id).toBe('req-012');
    });
  });

  describe('logEvent', () => {
    it('emits valid JSON with level, event, and merged data', () => {
      logEvent('warn', 'compaction_triggered', {
        session_id: 'sess-111',
        token_count: 5000,
      });

      expect(consoleSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(output.timestamp).toBeDefined();
      expect(output.level).toBe('warn');
      expect(output.event).toBe('compaction_triggered');
      expect(output.session_id).toBe('sess-111');
      expect(output.token_count).toBe(5000);
    });

    it('works with empty data object', () => {
      logEvent('info', 'startup');

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('info');
      expect(output.event).toBe('startup');
      expect(output.timestamp).toBeDefined();
    });

    it('supports error level', () => {
      logEvent('error', 'llm_failure', { error: 'timeout' });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('error');
      expect(output.event).toBe('llm_failure');
      expect(output.error).toBe('timeout');
    });
  });
});
