import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeStreamEvent,
  streamMessage,
  getBedrockClient,
  resetBedrockClient,
  LLMError,
} from '../llm.js';

// Helper to create a fresh accumulator
function createAccumulator() {
  return {
    contentBlocks: [],
    currentBlockIndex: -1,
    inputJsonParts: [],
    stopReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// Helper to encode an event as a Bedrock stream chunk
function encodeChunk(event) {
  return {
    chunk: {
      bytes: new TextEncoder().encode(JSON.stringify(event)),
    },
  };
}

describe('normalizeStreamEvent — text streaming', () => {
  it('yields { type: "text", text } for content_block_delta with text_delta', () => {
    const acc = createAccumulator();
    acc.contentBlocks[0] = { type: 'text', text: '' };

    const event = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    };

    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(acc.contentBlocks[0].text).toBe('Hello');
  });

  it('accumulates text across multiple deltas', () => {
    const acc = createAccumulator();
    acc.contentBlocks[0] = { type: 'text', text: '' };

    normalizeStreamEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      acc
    );
    normalizeStreamEvent(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      acc
    );

    expect(acc.contentBlocks[0].text).toBe('Hello world');
  });

  it('returns empty array for message_start (no yielded events)', () => {
    const acc = createAccumulator();
    const event = {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet',
        stop_reason: null,
        usage: { input_tokens: 25, output_tokens: 0 },
      },
    };

    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([]);
    expect(acc.usage.input_tokens).toBe(25);
  });
});

describe('normalizeStreamEvent — tool use streaming', () => {
  it('yields { type: "tool_use_start", id, name } for content_block_start with tool_use', () => {
    const acc = createAccumulator();
    const event = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_01A', name: 'jira_search', input: {} },
    };

    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([{ type: 'tool_use_start', id: 'toolu_01A', name: 'jira_search' }]);
    expect(acc.contentBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_01A',
      name: 'jira_search',
      input: {},
    });
  });

  it('yields { type: "tool_input_delta", partialJson } for input_json_delta', () => {
    const acc = createAccumulator();
    acc.contentBlocks[0] = { type: 'tool_use', id: 'toolu_01A', name: 'search', input: {} };
    acc.inputJsonParts[0] = [];

    const event = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    };

    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([{ type: 'tool_input_delta', partialJson: '{"query":' }]);
    expect(acc.inputJsonParts[0]).toEqual(['{"query":']);
  });

  it('assembles tool input JSON on content_block_stop', () => {
    const acc = createAccumulator();
    acc.contentBlocks[0] = { type: 'tool_use', id: 'toolu_01A', name: 'search', input: {} };
    acc.inputJsonParts[0] = ['{"query":', '"test"}'];

    const event = { type: 'content_block_stop', index: 0 };
    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([]);
    expect(acc.contentBlocks[0].input).toEqual({ query: 'test' });
  });

  it('does not yield events for content_block_start with text type', () => {
    const acc = createAccumulator();
    const event = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    };

    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([]);
    expect(acc.contentBlocks[0]).toEqual({ type: 'text', text: '' });
  });
});

describe('normalizeStreamEvent — message assembly', () => {
  it('yields { type: "message_complete", response } on message_stop', () => {
    const acc = createAccumulator();
    acc.contentBlocks = [{ type: 'text', text: 'Hello world' }];
    acc.stopReason = 'end_turn';
    acc.usage = { input_tokens: 10, output_tokens: 5 };

    const event = { type: 'message_stop' };
    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([
      {
        type: 'message_complete',
        response: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
  });

  it('assembles response with mixed text and tool_use blocks', () => {
    const acc = createAccumulator();
    acc.contentBlocks = [
      { type: 'text', text: 'Let me search.' },
      { type: 'tool_use', id: 'toolu_01', name: 'search', input: { q: 'test' } },
    ];
    acc.stopReason = 'tool_use';
    acc.usage = { input_tokens: 50, output_tokens: 30 };

    const event = { type: 'message_stop' };
    const result = normalizeStreamEvent(event, acc);

    expect(result[0].type).toBe('message_complete');
    expect(result[0].response.content).toHaveLength(2);
    expect(result[0].response.stop_reason).toBe('tool_use');
  });

  it('updates stopReason from message_delta', () => {
    const acc = createAccumulator();
    const event = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 42 },
    };

    const result = normalizeStreamEvent(event, acc);

    expect(result).toEqual([]);
    expect(acc.stopReason).toBe('end_turn');
    expect(acc.usage.output_tokens).toBe(42);
  });
});

describe('streamMessage — error handling', () => {
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

  it('yields error event and terminates on initial send failure', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Service unavailable');
    bedrockError.name = 'InternalServerException';
    bedrockError.$metadata = { httpStatusCode: 500 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    const events = [];
    for await (const event of streamMessage({
      model: 'sonnet',
      system: 'System',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1024,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'error',
      error: {
        errorType: 'api_error',
        message: 'Service unavailable',
        statusCode: 500,
      },
    });
  });

  it('yields error event and terminates on mid-stream failure', async () => {
    const client = getBedrockClient();

    // Create an async iterable that throws mid-stream
    async function* failingStream() {
      yield encodeChunk({
        type: 'message_start',
        message: { id: 'msg_01', usage: { input_tokens: 10, output_tokens: 0 } },
      });
      yield encodeChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      throw Object.assign(new Error('Connection reset'), {
        name: 'NetworkError',
        $metadata: { httpStatusCode: 502 },
      });
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

    // Should have some events before the error, then the error event last
    const errorEvent = events[events.length - 1];
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.error.message).toBe('Connection reset');
    expect(errorEvent.error.statusCode).toBe(502);
  });
});

describe('streamMessage — full sequence test', () => {
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

  it('processes a complete text-only stream sequence', async () => {
    const client = getBedrockClient();

    async function* mockStream() {
      yield encodeChunk({
        type: 'message_start',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet',
          stop_reason: null,
          usage: { input_tokens: 25, output_tokens: 0 },
        },
      });
      yield encodeChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      yield encodeChunk({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      });
      yield encodeChunk({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      });
      yield encodeChunk({ type: 'content_block_stop', index: 0 });
      yield encodeChunk({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      yield encodeChunk({ type: 'message_stop' });
    }

    vi.spyOn(client, 'send').mockResolvedValue({ body: mockStream() });

    const events = [];
    for await (const event of streamMessage({
      model: 'sonnet',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1024,
    })) {
      events.push(event);
    }

    // Should yield: text("Hello"), text(" world"), message_complete
    expect(events[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(events[1]).toEqual({ type: 'text', text: ' world' });
    expect(events[2]).toEqual({
      type: 'message_complete',
      response: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 3 },
      },
    });
    expect(events).toHaveLength(3);
  });

  it('processes a complete tool-use stream sequence', async () => {
    const client = getBedrockClient();

    async function* mockStream() {
      yield encodeChunk({
        type: 'message_start',
        message: {
          id: 'msg_02',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet',
          stop_reason: null,
          usage: { input_tokens: 50, output_tokens: 0 },
        },
      });
      // Text block first
      yield encodeChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      yield encodeChunk({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Searching...' },
      });
      yield encodeChunk({ type: 'content_block_stop', index: 0 });
      // Tool use block
      yield encodeChunk({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01A', name: 'jira_search', input: {} },
      });
      yield encodeChunk({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"jql":' },
      });
      yield encodeChunk({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"project=TAM"}' },
      });
      yield encodeChunk({ type: 'content_block_stop', index: 1 });
      yield encodeChunk({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      yield encodeChunk({ type: 'message_stop' });
    }

    vi.spyOn(client, 'send').mockResolvedValue({ body: mockStream() });

    const events = [];
    for await (const event of streamMessage({
      model: 'sonnet',
      system: 'System',
      messages: [{ role: 'user', content: 'Find tickets' }],
      tools: [{ name: 'jira_search', description: 'Search Jira', input_schema: {} }],
      maxTokens: 2048,
    })) {
      events.push(event);
    }

    // Expected events: text, tool_use_start, tool_input_delta x2, message_complete
    expect(events[0]).toEqual({ type: 'text', text: 'Searching...' });
    expect(events[1]).toEqual({ type: 'tool_use_start', id: 'toolu_01A', name: 'jira_search' });
    expect(events[2]).toEqual({ type: 'tool_input_delta', partialJson: '{"jql":' });
    expect(events[3]).toEqual({ type: 'tool_input_delta', partialJson: '"project=TAM"}' });
    expect(events[4].type).toBe('message_complete');
    expect(events[4].response).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'toolu_01A', name: 'jira_search', input: { jql: 'project=TAM' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 20 },
    });
  });

  it('sends correct command parameters to Bedrock', async () => {
    const client = getBedrockClient();

    async function* emptyStream() {
      yield encodeChunk({
        type: 'message_start',
        message: { id: 'msg_03', usage: { input_tokens: 5, output_tokens: 0 } },
      });
      yield encodeChunk({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 0 },
      });
      yield encodeChunk({ type: 'message_stop' });
    }

    vi.spyOn(client, 'send').mockResolvedValue({ body: emptyStream() });

    const events = [];
    for await (const event of streamMessage({
      model: 'sonnet',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Test' }],
      maxTokens: 512,
    })) {
      events.push(event);
    }

    expect(client.send).toHaveBeenCalledTimes(1);
    const sentCommand = client.send.mock.calls[0][0];
    expect(sentCommand.constructor.name).toBe('InvokeModelWithResponseStreamCommand');
    expect(sentCommand.input.modelId).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    expect(sentCommand.input.contentType).toBe('application/json');
    expect(sentCommand.input.accept).toBe('application/json');

    const sentBody = JSON.parse(sentCommand.input.body);
    expect(sentBody.anthropic_version).toBe('bedrock-2023-05-31');
    expect(sentBody.max_tokens).toBe(512);
    expect(sentBody.system).toBe('System prompt');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'Test' }]);
  });
});
