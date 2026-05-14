import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveModelId,
  getBedrockClient,
  resetBedrockClient,
  normalizeResponse,
  buildBedrockRequestBody,
  createMessage,
  AuthenticationError,
  ConfigurationError,
  LLMError,
} from '../llm.js';

describe('LLM Module — Model Alias Resolution and Client Initialization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetBedrockClient();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetBedrockClient();
  });

  describe('resolveModelId', () => {
    it('resolves "sonnet" to BEDROCK_SONNET_MODEL_ID env var value', () => {
      process.env.BEDROCK_SONNET_MODEL_ID = 'anthropic.claude-sonnet-4-20250514-v1:0';
      expect(resolveModelId('sonnet')).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    });

    it('resolves "haiku" to BEDROCK_HAIKU_MODEL_ID env var value', () => {
      process.env.BEDROCK_HAIKU_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
      expect(resolveModelId('haiku')).toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
    });

    it('passes through a full model ID unchanged', () => {
      const fullId = 'anthropic.claude-sonnet-4-20250514-v1:0';
      expect(resolveModelId(fullId)).toBe(fullId);
    });

    it('passes through any unknown string as a literal model ID', () => {
      expect(resolveModelId('custom-model-v2')).toBe('custom-model-v2');
    });

    it('throws ConfigurationError when BEDROCK_SONNET_MODEL_ID is not set', () => {
      delete process.env.BEDROCK_SONNET_MODEL_ID;
      expect(() => resolveModelId('sonnet')).toThrow(ConfigurationError);
      expect(() => resolveModelId('sonnet')).toThrow(
        'Environment variable BEDROCK_SONNET_MODEL_ID is not set'
      );
    });

    it('throws ConfigurationError when BEDROCK_HAIKU_MODEL_ID is not set', () => {
      delete process.env.BEDROCK_HAIKU_MODEL_ID;
      expect(() => resolveModelId('haiku')).toThrow(ConfigurationError);
      expect(() => resolveModelId('haiku')).toThrow(
        'Environment variable BEDROCK_HAIKU_MODEL_ID is not set'
      );
    });

    it('throws ConfigurationError when env var is empty string', () => {
      process.env.BEDROCK_SONNET_MODEL_ID = '';
      expect(() => resolveModelId('sonnet')).toThrow(ConfigurationError);
    });
  });

  describe('getBedrockClient', () => {
    it('returns a BedrockRuntimeClient when AWS_REGION is set', () => {
      process.env.AWS_REGION = 'us-east-1';
      const client = getBedrockClient();
      expect(client).toBeDefined();
      expect(client.constructor.name).toBe('BedrockRuntimeClient');
    });

    it('returns the same singleton instance on subsequent calls', () => {
      process.env.AWS_REGION = 'us-west-2';
      const client1 = getBedrockClient();
      const client2 = getBedrockClient();
      expect(client1).toBe(client2);
    });

    it('throws AuthenticationError when AWS_REGION is not set', () => {
      delete process.env.AWS_REGION;
      expect(() => getBedrockClient()).toThrow(AuthenticationError);
      expect(() => getBedrockClient()).toThrow('AWS_REGION environment variable is not set');
    });
  });

  describe('Error Classes', () => {
    it('AuthenticationError has correct name and message', () => {
      const err = new AuthenticationError('creds missing');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.name).toBe('AuthenticationError');
      expect(err.message).toBe('creds missing');
    });

    it('ConfigurationError has correct name and message', () => {
      const err = new ConfigurationError('env var missing');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.name).toBe('ConfigurationError');
      expect(err.message).toBe('env var missing');
    });

    it('LLMError has correct name, message, errorType, and statusCode', () => {
      const err = new LLMError({
        errorType: 'api_error',
        message: 'model not found',
        statusCode: 404,
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LLMError);
      expect(err.name).toBe('LLMError');
      expect(err.message).toBe('model not found');
      expect(err.errorType).toBe('api_error');
      expect(err.statusCode).toBe(404);
    });
  });
});


describe('normalizeResponse', () => {
  it('normalizes a text-only response', () => {
    const bedrockResponse = {
      id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  });

  it('normalizes a tool_use response', () => {
    const bedrockResponse = {
      id: 'msg_02ABC',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_01A', name: 'search', input: { query: 'test' } },
      ],
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 75 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01A', name: 'search', input: { query: 'test' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 75 },
    });
  });

  it('normalizes a mixed response with text and tool_use blocks', () => {
    const bedrockResponse = {
      id: 'msg_03DEF',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search for that.' },
        { type: 'tool_use', id: 'toolu_02B', name: 'jira_search', input: { jql: 'project=TAM' } },
      ],
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 150, output_tokens: 80 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search for that.' },
        { type: 'tool_use', id: 'toolu_02B', name: 'jira_search', input: { jql: 'project=TAM' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 150, output_tokens: 80 },
    });
  });

  it('always sets role to "assistant" regardless of input', () => {
    const bedrockResponse = {
      id: 'msg_04',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: 'some-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = normalizeResponse(bedrockResponse);
    expect(result.role).toBe('assistant');
  });

  it('strips extra top-level fields (id, type, model, stop_sequence)', () => {
    const bedrockResponse = {
      id: 'msg_05',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 4096 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('type');
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('stop_sequence');
    expect(Object.keys(result)).toEqual(['role', 'content', 'stop_reason', 'usage']);
  });

  it('handles empty content array', () => {
    const bedrockResponse = {
      id: 'msg_06',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'some-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('handles stop_reason "max_tokens"', () => {
    const bedrockResponse = {
      id: 'msg_07',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'truncated...' }],
      model: 'some-model',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 4096 },
    };

    const result = normalizeResponse(bedrockResponse);
    expect(result.stop_reason).toBe('max_tokens');
  });

  it('extracts only input_tokens and output_tokens from usage', () => {
    const bedrockResponse = {
      id: 'msg_08',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: 'some-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 17, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result.usage).toEqual({ input_tokens: 42, output_tokens: 17 });
    expect(result.usage).not.toHaveProperty('cache_creation_input_tokens');
    expect(result.usage).not.toHaveProperty('cache_read_input_tokens');
  });

  it('strips extra fields from tool_use content blocks', () => {
    const bedrockResponse = {
      id: 'msg_09',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_03C', name: 'web_search', input: { q: 'hello' }, extra_field: 'should be stripped' },
      ],
      model: 'some-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 20 },
    };

    const result = normalizeResponse(bedrockResponse);

    expect(result.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_03C',
      name: 'web_search',
      input: { q: 'hello' },
    });
    expect(result.content[0]).not.toHaveProperty('extra_field');
  });

  it('produces a JSON round-trip equivalent object', () => {
    const bedrockResponse = {
      id: 'msg_10',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is the result.' },
        { type: 'tool_use', id: 'toolu_04D', name: 'confluence', input: { page_id: '12345' } },
      ],
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 300, output_tokens: 120 },
    };

    const result = normalizeResponse(bedrockResponse);
    const roundTripped = JSON.parse(JSON.stringify(result));

    expect(roundTripped).toEqual(result);
  });
});


describe('LLM Module — buildBedrockRequestBody', () => {
  it('constructs request body with anthropic_version, max_tokens, system, and messages', () => {
    const body = buildBedrockRequestBody({
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 1024,
    });

    expect(body).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('includes tools array when tools are provided and non-empty', () => {
    const tools = [
      { name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    ];

    const body = buildBedrockRequestBody({
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
      tools,
      maxTokens: 2048,
    });

    expect(body.tools).toEqual(tools);
  });

  it('omits tools field when tools is undefined', () => {
    const body = buildBedrockRequestBody({
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: undefined,
      maxTokens: 512,
    });

    expect(body).not.toHaveProperty('tools');
  });

  it('omits tools field when tools is an empty array', () => {
    const body = buildBedrockRequestBody({
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      maxTokens: 512,
    });

    expect(body).not.toHaveProperty('tools');
  });

  it('supports system as an array of content blocks', () => {
    const systemBlocks = [{ type: 'text', text: 'You are a TAM agent.' }];
    const body = buildBedrockRequestBody({
      model: 'some-model',
      system: systemBlocks,
      messages: [{ role: 'user', content: 'Help me' }],
      maxTokens: 4096,
    });

    expect(body.system).toEqual(systemBlocks);
  });

  it('supports messages with content block arrays', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }] },
    ];
    const body = buildBedrockRequestBody({
      model: 'some-model',
      system: 'System',
      messages,
      maxTokens: 1024,
    });

    expect(body.messages).toEqual(messages);
  });
});

describe('LLM Module — createMessage', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_SONNET_MODEL_ID = 'anthropic.claude-sonnet-4-20250514-v1:0';
    process.env.BEDROCK_HAIKU_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
    resetBedrockClient();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetBedrockClient();
    vi.restoreAllMocks();
  });

  it('resolves model alias and sends InvokeModelCommand', async () => {
    const mockResponse = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello there!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const client = getBedrockClient();
    vi.spyOn(client, 'send').mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify(mockResponse)),
    });

    const result = await createMessage({
      model: 'sonnet',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1024,
    });

    expect(result.role).toBe('assistant');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello there!' }]);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });

    // Verify the command was sent with correct parameters
    expect(client.send).toHaveBeenCalledTimes(1);
    const sentCommand = client.send.mock.calls[0][0];
    expect(sentCommand.input.modelId).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    expect(sentCommand.input.contentType).toBe('application/json');
    expect(sentCommand.input.accept).toBe('application/json');

    const sentBody = JSON.parse(sentCommand.input.body);
    expect(sentBody.anthropic_version).toBe('bedrock-2023-05-31');
    expect(sentBody.max_tokens).toBe(1024);
    expect(sentBody.system).toBe('You are helpful.');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('omits tools from request body when not provided', async () => {
    const mockResponse = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    };

    const client = getBedrockClient();
    vi.spyOn(client, 'send').mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify(mockResponse)),
    });

    await createMessage({
      model: 'haiku',
      system: 'System',
      messages: [{ role: 'user', content: 'Test' }],
      maxTokens: 512,
    });

    const sentBody = JSON.parse(client.send.mock.calls[0][0].input.body);
    expect(sentBody).not.toHaveProperty('tools');
  });

  it('includes tools in request body when provided', async () => {
    const mockResponse = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Using tool' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 15, output_tokens: 8 },
    };

    const tools = [
      { name: 'jira_search', description: 'Search Jira', input_schema: { type: 'object', properties: {} } },
    ];

    const client = getBedrockClient();
    vi.spyOn(client, 'send').mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify(mockResponse)),
    });

    await createMessage({
      model: 'sonnet',
      system: 'System',
      messages: [{ role: 'user', content: 'Find ticket' }],
      tools,
      maxTokens: 2048,
    });

    const sentBody = JSON.parse(client.send.mock.calls[0][0].input.body);
    expect(sentBody.tools).toEqual(tools);
  });

  it('throws LLMError with errorType and statusCode on AccessDeniedException', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Access denied');
    bedrockError.name = 'AccessDeniedException';
    bedrockError.$metadata = { httpStatusCode: 403 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      errorType: 'authentication_error',
      message: 'Access denied',
      statusCode: 403,
    });
  });

  it('throws LLMError with errorType "validation_error" on ValidationException', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Invalid request');
    bedrockError.name = 'ValidationException';
    bedrockError.$metadata = { httpStatusCode: 400 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      errorType: 'validation_error',
      statusCode: 400,
    });
  });

  it('throws LLMError with errorType "rate_limit_error" on ThrottlingException', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Too many requests');
    bedrockError.name = 'ThrottlingException';
    bedrockError.$metadata = { httpStatusCode: 429 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      errorType: 'rate_limit_error',
      statusCode: 429,
    });
  });

  it('throws LLMError with errorType "network_error" on ModelTimeoutException', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Model timed out');
    bedrockError.name = 'ModelTimeoutException';
    bedrockError.$metadata = { httpStatusCode: 408 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      errorType: 'network_error',
      statusCode: 408,
    });
  });

  it('throws LLMError with errorType "api_error" on InternalServerException', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Internal server error');
    bedrockError.name = 'InternalServerException';
    bedrockError.$metadata = { httpStatusCode: 500 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      errorType: 'api_error',
      statusCode: 500,
    });
  });

  it('throws LLMError with errorType "api_error" for unknown error types', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Something unexpected');
    bedrockError.name = 'SomeUnknownException';
    bedrockError.$metadata = { httpStatusCode: 503 };

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      errorType: 'api_error',
      statusCode: 503,
    });
  });

  it('defaults statusCode to 500 when $metadata is missing', async () => {
    const client = getBedrockClient();
    const bedrockError = new Error('Network failure');
    bedrockError.name = 'NetworkError';

    vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      statusCode: 500,
    });
  });

  it('throws ConfigurationError when model alias env var is not set', async () => {
    delete process.env.BEDROCK_SONNET_MODEL_ID;

    await expect(
      createMessage({
        model: 'sonnet',
        system: 'System',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 1024,
      })
    ).rejects.toThrow(ConfigurationError);
  });

  it('passes through full model IDs without env var lookup', async () => {
    const mockResponse = {
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    };

    const client = getBedrockClient();
    vi.spyOn(client, 'send').mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify(mockResponse)),
    });

    await createMessage({
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      system: 'System',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1024,
    });

    const sentCommand = client.send.mock.calls[0][0];
    expect(sentCommand.input.modelId).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
  });
});
