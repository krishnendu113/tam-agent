import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

describe('Project Setup', () => {
  it('should have vitest working', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have fast-check integration working', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 }
    );
  });

  it('should confirm banned dependencies are not installed', async () => {
    const banned = [
      '@anthropic-ai/sdk',
      '@langchain/langgraph',
      '@langchain/core',
      'langsmith'
    ];

    for (const dep of banned) {
      await expect(import(dep)).rejects.toThrow();
    }
  });

  it('should confirm @aws-sdk/client-bedrock-runtime is available', async () => {
    const sdk = await import('@aws-sdk/client-bedrock-runtime');
    expect(sdk.BedrockRuntimeClient).toBeDefined();
    expect(sdk.InvokeModelCommand).toBeDefined();
    expect(sdk.InvokeModelWithResponseStreamCommand).toBeDefined();
  });
});
