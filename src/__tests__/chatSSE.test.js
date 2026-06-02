/**
 * Unit tests for chat SSE streaming logic (public/js/chat.js)
 * Tests handleSSEEvent for token concatenation, complete event handling, and error recovery.
 *
 * Since chat.js is a plain browser script with an IIFE that calls requireAuth() etc on load,
 * we extract only the handleSSEEvent function by evaluating the source in a controlled context.
 *
 * Validates: Requirements 6.3, 6.4, 6.5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// Read the chat.js source
const chatJsSource = readFileSync(resolve(process.cwd(), 'public/js/chat.js'), 'utf-8');

/**
 * Create a sandboxed context that satisfies chat.js dependencies
 * and exposes handleSSEEvent for testing.
 *
 * The chat.js IIFE calls requireAuth(), renderNav(), loadConversationList() on load.
 * We mock all DOM and auth dependencies so the script loads without errors.
 * The `messages` array in chat.js is a module-level var that handleSSEEvent uses
 * to update `messages[messages.length - 1].content`. In real usage, processSSEStream
 * pushes an empty assistant message before calling handleSSEEvent. We need to do the same
 * in tests by pushing to the context's messages array before calling handleSSEEvent for tokens.
 */
function createChatContext() {
  const context = {
    // Auth/nav dependencies (called during IIFE init)
    requireAuth: vi.fn(),
    renderNav: vi.fn(),
    getToken: vi.fn().mockReturnValue('test-token'),
    apiGet: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
    escapeHtml: (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),

    // Minimal DOM mocks for init and rendering
    document: {
      getElementById: vi.fn().mockReturnValue(null),
      createElement: vi.fn().mockReturnValue({ className: '', setAttribute: vi.fn(), textContent: '' }),
    },

    // Globals
    window: { location: { href: '' } },
    console,
    fetch: vi.fn(),
    JSON,
    Math,
    Date,
    Promise,
    TextDecoder: class { decode() { return ''; } },
    Error,
    parseInt,
    isNaN,
  };

  vm.createContext(context);
  vm.runInContext(chatJsSource, context);

  return {
    handleSSEEvent: context.handleSSEEvent,
    messages: context.messages,
    currentConversationId: () => context.currentConversationId,
    isStreaming: () => context.isStreaming,
    context,
  };
}

describe('Chat SSE Streaming Logic (handleSSEEvent)', () => {
  let handleSSEEvent;
  let messages;
  let getConversationId;
  let getIsStreaming;

  beforeEach(() => {
    const chatCtx = createChatContext();
    handleSSEEvent = chatCtx.handleSSEEvent;
    messages = chatCtx.messages;
    getConversationId = chatCtx.currentConversationId;
    getIsStreaming = chatCtx.isStreaming;
  });

  /**
   * Helper to create a contentRef object that tracks accumulated content.
   */
  function createContentRef(initial = '') {
    let content = initial;
    return {
      getContent: () => content,
      setContent: (c) => { content = c; },
      get value() { return content; },
    };
  }

  /**
   * Simulate what processSSEStream does before calling handleSSEEvent for tokens:
   * it pushes an empty assistant message placeholder to the messages array.
   */
  function prepareForTokenStreaming() {
    messages.push({ role: 'assistant', content: '' });
  }

  describe('Token concatenation (Requirement 6.3)', () => {
    it('should concatenate multiple token events', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ token: 'Hello' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: ' world' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: '!' }), contentRef);

      expect(contentRef.value).toBe('Hello world!');
    });

    it('should handle token field in JSON data', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ token: 'abc' }), contentRef);

      expect(contentRef.value).toBe('abc');
    });

    it('should handle content field in JSON data', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ content: 'from content field' }), contentRef);

      expect(contentRef.value).toBe('from content field');
    });

    it('should fall back to raw data string when JSON has no recognized field', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ other: 'value' }), contentRef);

      // tokenData.token is undefined, tokenData.content is undefined
      // so it uses: tokenData.token || tokenData.content || data
      // undefined || undefined || '{"other":"value"}' → the raw JSON string
      expect(contentRef.value).toBe(JSON.stringify({ other: 'value' }));
    });

    it('should handle non-JSON data as raw token text', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      // When JSON.parse fails, code does: tokenData = { token: data }
      handleSSEEvent('token', 'plain text token', contentRef);

      expect(contentRef.value).toBe('plain text token');
    });

    it('should accumulate tokens starting from existing content', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef('Already ');

      handleSSEEvent('token', JSON.stringify({ token: 'here' }), contentRef);

      expect(contentRef.value).toBe('Already here');
    });

    it('should update the last assistant message in the messages array', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ token: 'Hello' }), contentRef);

      expect(messages[messages.length - 1].content).toBe('Hello');
    });
  });

  describe('Complete event handling (Requirement 6.4)', () => {
    it('should update conversationId when provided in complete data', () => {
      const contentRef = createContentRef('final content');

      handleSSEEvent('complete', JSON.stringify({ conversationId: 'conv-123' }), contentRef);

      expect(getConversationId()).toBe('conv-123');
    });

    it('should set streaming state to false on complete', () => {
      const contentRef = createContentRef();

      handleSSEEvent('complete', JSON.stringify({ conversationId: 'conv-abc' }), contentRef);

      expect(getIsStreaming()).toBe(false);
    });

    it('should not modify content on complete event', () => {
      const contentRef = createContentRef('some content');

      handleSSEEvent('complete', JSON.stringify({}), contentRef);

      expect(contentRef.value).toBe('some content');
    });

    it('should handle complete event with non-JSON data gracefully', () => {
      const contentRef = createContentRef('content');

      expect(() => {
        handleSSEEvent('complete', 'not json', contentRef);
      }).not.toThrow();

      expect(contentRef.value).toBe('content');
    });
  });

  describe('Error event handling (Requirement 6.5)', () => {
    it('should set streaming state to false on error', () => {
      const contentRef = createContentRef('partial content');

      handleSSEEvent('error', JSON.stringify({ error: 'Something went wrong' }), contentRef);

      expect(getIsStreaming()).toBe(false);
    });

    it('should not modify content on error event', () => {
      const contentRef = createContentRef('partial content');

      handleSSEEvent('error', JSON.stringify({ error: 'Something went wrong' }), contentRef);

      expect(contentRef.value).toBe('partial content');
    });

    it('should handle error event with non-JSON data gracefully', () => {
      const contentRef = createContentRef();

      expect(() => {
        handleSSEEvent('error', 'plain error message', contentRef);
      }).not.toThrow();

      expect(getIsStreaming()).toBe(false);
    });

    it('should handle error event with empty JSON object', () => {
      const contentRef = createContentRef();

      expect(() => {
        handleSSEEvent('error', '{}', contentRef);
      }).not.toThrow();

      expect(getIsStreaming()).toBe(false);
    });
  });

  describe('Unknown event types', () => {
    it('should ignore unknown event types without modifying content', () => {
      const contentRef = createContentRef('unchanged');

      handleSSEEvent('status', JSON.stringify({ status: 'thinking' }), contentRef);
      handleSSEEvent('phase', JSON.stringify({ phase: 'research' }), contentRef);
      handleSSEEvent('unknown', 'some data', contentRef);

      expect(contentRef.value).toBe('unchanged');
    });
  });

  describe('End-to-end streaming sequence', () => {
    it('should handle a full streaming sequence: multiple tokens then complete', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ token: 'The ' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: 'answer ' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: 'is ' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: '42.' }), contentRef);
      handleSSEEvent('complete', JSON.stringify({ conversationId: 'conv-1' }), contentRef);

      expect(contentRef.value).toBe('The answer is 42.');
      expect(getConversationId()).toBe('conv-1');
      expect(getIsStreaming()).toBe(false);
    });

    it('should handle a streaming sequence interrupted by error', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ token: 'Partial ' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: 'response' }), contentRef);
      handleSSEEvent('error', JSON.stringify({ error: 'Connection lost' }), contentRef);

      expect(contentRef.value).toBe('Partial response');
      expect(getIsStreaming()).toBe(false);
    });

    it('should handle mixed content/token fields across events', () => {
      prepareForTokenStreaming();
      const contentRef = createContentRef();

      handleSSEEvent('token', JSON.stringify({ token: 'Hello' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ content: ' from content' }), contentRef);
      handleSSEEvent('token', JSON.stringify({ token: ' field' }), contentRef);

      expect(contentRef.value).toBe('Hello from content field');
    });
  });
});
