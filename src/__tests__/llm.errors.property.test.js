import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  createMessage,
  buildBedrockRequestBody,
  getBedrockClient,
  resetBedrockClient,
  LLMError,
} from '../llm.js';

// --- Generators ---

const KNOWN_ERROR_NAMES = [
  'AccessDeniedException',
  'ValidationException',
  'ThrottlingException',
  'ModelTimeoutException',
  'InternalServerException',
];

/**
 * Generates arbitrary Bedrock error objects with random name, message, and $metadata.httpStatusCode.
 */
function arbBedrockError() {
  const errorNameArb = fc.oneof(
    fc.constantFrom(...KNOWN_ERROR_NAMES),
    fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/\s/g, '') + 'Exception')
  );

  return fc.record({
    name: errorNameArb,
    message: fc.string({ minLength: 1, maxLength: 200 }),
    httpStatusCode: fc.integer({ min: 400, max: 599 }),
  });
}

/**
 * Generates arbitrary tool definitions with valid name, description, and input_schema fields.
 */
function arbToolDefinition() {
  // Generate valid tool names (alphanumeric + underscores, starting with a letter)
  const toolNameArb = fc
    .tuple(
      fc.constantFrom('a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z'),
      fc.stringMatching(/^[a-z0-9_]{0,29}$/)
    )
    .map(([first, rest]) => first + rest);

  const propertySchemaArb = fc.dictionary(
    fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/),
    fc.constantFrom(
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'integer' },
      { type: 'array', items: { type: 'string' } }
    ),
    { minKeys: 0, maxKeys: 5 }
  );

  return fc.record({
    name: toolNameArb,
    description: fc.string({ minLength: 1, maxLength: 200 }),
    input_schema: propertySchemaArb.map((properties) => ({
      type: 'object',
      properties,
    })),
  });
}

// --- Property Tests ---

describe('Feature: tam-agent-migration, Property 3: Error Response Normalization', () => {
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
   * **Validates: Requirements 1.6**
   *
   * For any Bedrock error response, the thrown error SHALL always contain
   * an errorType (string), message (string), and statusCode (number).
   */
  it('thrown LLMError always contains errorType (string), message (string), and statusCode (number)', async () => {
    await fc.assert(
      fc.asyncProperty(arbBedrockError(), async (errorSpec) => {
        // Reset client for each iteration to get a fresh mockable instance
        resetBedrockClient();
        const client = getBedrockClient();

        // Create a Bedrock-style error
        const bedrockError = new Error(errorSpec.message);
        bedrockError.name = errorSpec.name;
        bedrockError.$metadata = { httpStatusCode: errorSpec.httpStatusCode };

        vi.spyOn(client, 'send').mockRejectedValue(bedrockError);

        try {
          await createMessage({
            model: 'sonnet',
            system: 'Test system prompt',
            messages: [{ role: 'user', content: 'Hello' }],
            maxTokens: 1024,
          });
          // Should not reach here
          expect.fail('createMessage should have thrown');
        } catch (error) {
          // The error must be an LLMError
          expect(error).toBeInstanceOf(LLMError);

          // errorType must be a non-empty string
          expect(typeof error.errorType).toBe('string');
          expect(error.errorType.length).toBeGreaterThan(0);

          // message must be a string
          expect(typeof error.message).toBe('string');
          expect(error.message.length).toBeGreaterThan(0);

          // statusCode must be a number
          expect(typeof error.statusCode).toBe('number');
          expect(Number.isFinite(error.statusCode)).toBe(true);
        }

        // Restore mock for next iteration
        vi.restoreAllMocks();
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: tam-agent-migration, Property 4: Tool Definition Formatting', () => {
  /**
   * **Validates: Requirements 1.7**
   *
   * For any non-empty array of tool definitions with valid name, description,
   * and input_schema fields, the formatted output (from buildBedrockRequestBody)
   * SHALL produce a request body where the tools array matches the Anthropic
   * Messages API tool format structure.
   */
  it('formatted output tools array matches Anthropic Messages API tool format', () => {
    fc.assert(
      fc.property(
        fc.array(arbToolDefinition(), { minLength: 1, maxLength: 10 }),
        (tools) => {
          const body = buildBedrockRequestBody({
            model: 'anthropic.claude-sonnet-4-20250514-v1:0',
            system: 'You are a helpful assistant.',
            messages: [{ role: 'user', content: 'Hello' }],
            tools,
            maxTokens: 1024,
          });

          // The body must have a tools array
          expect(body.tools).toBeDefined();
          expect(Array.isArray(body.tools)).toBe(true);
          expect(body.tools.length).toBe(tools.length);

          // Each tool in the output must match Anthropic Messages API format
          for (const tool of body.tools) {
            // name must be a string
            expect(typeof tool.name).toBe('string');
            expect(tool.name.length).toBeGreaterThan(0);

            // description must be a string
            expect(typeof tool.description).toBe('string');
            expect(tool.description.length).toBeGreaterThan(0);

            // input_schema must be an object with type "object"
            expect(typeof tool.input_schema).toBe('object');
            expect(tool.input_schema).not.toBeNull();
            expect(tool.input_schema.type).toBe('object');
            expect(typeof tool.input_schema.properties).toBe('object');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
