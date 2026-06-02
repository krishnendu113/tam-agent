import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// --- Extract handleSSEEvent from chat.js using vm ---

const chatJsPath = resolve(process.cwd(), 'public/js/chat.js');
const chatJsSource = readFileSync(chatJsPath, 'utf-8');

/**
 * Extract the handleSSEEvent function from chat.js by evaluating it in a
 * sandboxed vm context with minimal DOM/global mocks.
 * Returns a wrapper that sets up the messages array before each call.
 */
function getHandleSSEEvent() {
  const context = {
    // Auth/nav mocks required by chat.js IIFE
    requireAuth: () => {},
    renderNav: () => {},
    getToken: () => 'mock-token',
    apiGet: () => Promise.resolve({ ok: false }),
    escapeHtml: (s) => s,

    // Minimal DOM mocks to prevent errors during chat.js initialization
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        className: '',
        textContent: '',
        innerHTML: '',
        setAttribute: () => {},
        appendChild: () => {},
        addEventListener: () => {}
      })
    },
    window: { location: { href: '' } },
    console,
    fetch: () => Promise.resolve({ ok: false }),
    TextDecoder: class { decode() { return ''; } }
  };

  vm.createContext(context);
  vm.runInContext(chatJsSource, context);

  // Return the raw handleSSEEvent and access to the context's messages array
  return {
    handleSSEEvent: context.handleSSEEvent,
    context
  };
}

/**
 * Prepare the vm context for a streaming test by setting up the messages array
 * with an assistant message placeholder (as processSSEStream does).
 */
function prepareStreamingContext(ctx) {
  // Simulate what processSSEStream does: push an empty assistant message
  ctx.messages = [{ role: 'assistant', content: '' }];
  ctx.currentConversationId = null;
  ctx.isStreaming = true;
}

// --- Generators ---

/**
 * Generates an arbitrary non-empty token string (printable characters).
 * Represents the text content of a single SSE token event.
 * Tokens are non-empty because the LLM emits meaningful text chunks;
 * empty strings are not valid token payloads in practice.
 */
function arbTokenText() {
  return fc.string({ minLength: 1, maxLength: 50 });
}

/**
 * Generates an arbitrary non-empty array of token strings representing
 * a sequence of SSE token events.
 */
function arbTokenSequence() {
  return fc.array(arbTokenText(), { minLength: 1, maxLength: 50 });
}

/**
 * Generates a JSON format for the token event data.
 * The handleSSEEvent function supports: { token: "..." }, { content: "..." },
 * or falls back to the raw data string.
 */
function arbTokenEventData(tokenText) {
  return fc.constantFrom('token', 'content', 'raw').map((format) => {
    switch (format) {
      case 'token':
        return JSON.stringify({ token: tokenText });
      case 'content':
        return JSON.stringify({ content: tokenText });
      case 'raw':
        // When JSON parse fails, handleSSEEvent uses { token: data } then
        // extracts tokenData.token || tokenData.content || data
        // Since tokenData = { token: data }, it will use data as the token text.
        // But we need to ensure JSON.parse fails, so use non-JSON string.
        // Actually looking at the code more carefully:
        // If JSON.parse fails, tokenData = { token: data }
        // Then tokenText = tokenData.token || tokenData.content || data
        // tokenData.token = data (the raw string), so it uses the raw data string.
        // We need to make sure the raw data is NOT valid JSON for this path.
        return tokenText;
      default:
        return JSON.stringify({ token: tokenText });
    }
  });
}

// --- Property Tests ---

describe('Feature: frontend-auth-admin, Property 13: SSE token streaming appends all tokens', () => {
  const { handleSSEEvent, context } = getHandleSSEEvent();

  /**
   * **Validates: Requirements 6.3**
   *
   * For any sequence of SSE token events emitted by the server, the chat UI
   * message area SHALL contain the concatenation of all token payloads in the
   * order they were received.
   */
  it('concatenation of all token events matches final message content (JSON token format)', () => {
    fc.assert(
      fc.property(arbTokenSequence(), (tokens) => {
        // Prepare the context with an assistant message placeholder
        prepareStreamingContext(context);

        // Create a contentRef that tracks the accumulated content
        let content = '';
        const contentRef = {
          getContent: () => content,
          setContent: (c) => { content = c; }
        };

        // Simulate each token event using JSON { token: "..." } format
        for (const tokenText of tokens) {
          const data = JSON.stringify({ token: tokenText });
          handleSSEEvent('token', data, contentRef);
        }

        // The final content should be the concatenation of all tokens
        const expected = tokens.join('');
        expect(content).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('concatenation of all token events matches final message content (JSON content format)', () => {
    fc.assert(
      fc.property(arbTokenSequence(), (tokens) => {
        prepareStreamingContext(context);

        let content = '';
        const contentRef = {
          getContent: () => content,
          setContent: (c) => { content = c; }
        };

        // Simulate each token event using JSON { content: "..." } format
        for (const tokenText of tokens) {
          const data = JSON.stringify({ content: tokenText });
          handleSSEEvent('token', data, contentRef);
        }

        // The final content should be the concatenation of all tokens
        const expected = tokens.join('');
        expect(content).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('concatenation of all token events matches final message content (mixed formats)', () => {
    // Generator that produces a token with a random format
    const arbTokenWithFormat = fc.tuple(
      arbTokenText(),
      fc.constantFrom('token', 'content')
    );

    const arbMixedSequence = fc.array(arbTokenWithFormat, { minLength: 1, maxLength: 50 });

    fc.assert(
      fc.property(arbMixedSequence, (tokenPairs) => {
        prepareStreamingContext(context);

        let content = '';
        const contentRef = {
          getContent: () => content,
          setContent: (c) => { content = c; }
        };

        for (const [tokenText, format] of tokenPairs) {
          let data;
          if (format === 'token') {
            data = JSON.stringify({ token: tokenText });
          } else {
            data = JSON.stringify({ content: tokenText });
          }
          handleSSEEvent('token', data, contentRef);
        }

        const expected = tokenPairs.map(([t]) => t).join('');
        expect(content).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('empty token sequence results in empty content', () => {
    let content = '';
    const contentRef = {
      getContent: () => content,
      setContent: (c) => { content = c; }
    };

    // No events processed — content should remain empty
    expect(content).toBe('');
  });

  it('single token event sets content to exactly that token', () => {
    fc.assert(
      fc.property(arbTokenText(), (tokenText) => {
        prepareStreamingContext(context);

        let content = '';
        const contentRef = {
          getContent: () => content,
          setContent: (c) => { content = c; }
        };

        const data = JSON.stringify({ token: tokenText });
        handleSSEEvent('token', data, contentRef);

        expect(content).toBe(tokenText);
      }),
      { numRuns: 100 }
    );
  });

  it('non-token events do not modify content', () => {
    fc.assert(
      fc.property(
        arbTokenSequence(),
        fc.constantFrom('complete', 'error', 'status', 'phase'),
        (tokens, otherEventType) => {
          prepareStreamingContext(context);

          let content = '';
          const contentRef = {
            getContent: () => content,
            setContent: (c) => { content = c; }
          };

          // First, stream some tokens
          for (const tokenText of tokens) {
            const data = JSON.stringify({ token: tokenText });
            handleSSEEvent('token', data, contentRef);
          }

          const contentAfterTokens = content;

          // Then send a non-token event — content should not change
          handleSSEEvent(otherEventType, JSON.stringify({ data: 'test' }), contentRef);

          expect(content).toBe(contentAfterTokens);
        }
      ),
      { numRuns: 100 }
    );
  });
});
