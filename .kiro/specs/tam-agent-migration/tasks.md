# Implementation Plan: TAM Agent Migration

## Overview

Migrate the TAM Agent from Anthropic SDK + LangGraph to AWS Bedrock + custom async state machine. Implementation proceeds in two phases: Phase 1 builds the LLM Abstraction Layer (`src/llm.js`) with Bedrock integration, and Phase 2 builds the Custom Agent Loop (`src/agentLoop.js`) replacing LangGraph. Reusable modules are copied verbatim from the source repository.

## Tasks

- [x] 1. Project setup and reusable module migration
  - [x] 1.1 Initialize project structure and install dependencies
    - Create `package.json` with `@aws-sdk/client-bedrock-runtime`, `express`, `mongodb`, `multer`, `fast-check` (dev), and all other retained dependencies
    - Ensure `@anthropic-ai/sdk`, `@langchain/langgraph`, `@langchain/core`, and `langsmith` are NOT included
    - Set up test runner (Jest or Vitest) with fast-check integration
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 1.2 Copy reusable modules from source repository
    - Copy `src/stores/` directory (index.js, json/, mongo/) with zero modifications
    - Copy `src/db.js` and `src/migration.js` with zero modifications
    - Copy `src/auth.js`, `src/passwordPolicy.js`, `src/lockout.js`, `src/auditLogger.js` with zero modifications
    - Copy `src/tools/` directory (index.js, jira.js, confluence.js, kapa.js, webSearch.js) with zero modifications
    - Copy `src/planManager.js`, `src/documentStore.js`, `src/fileHandler.js` with zero modifications
    - Copy `src/skillLoader.js` and `skills/` directory with zero modifications
    - Copy `public/` directory with zero modifications
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_

- [x] 2. Implement LLM Abstraction Layer — Core
  - [x] 2.1 Implement model alias resolution and Bedrock client initialization
    - Create `src/llm.js` with `resolveModelId(alias)` function mapping "sonnet" → `BEDROCK_SONNET_MODEL_ID` env var, "haiku" → `BEDROCK_HAIKU_MODEL_ID` env var, pass-through for full IDs
    - Initialize `BedrockRuntimeClient` with region from `AWS_REGION` env var using default credential chain
    - Throw `AuthenticationError` with descriptive message if credentials are missing/invalid
    - Throw `ConfigurationError` if model alias env var is not set
    - _Requirements: 1.4, 1.5, 3.1, 3.2, 3.4_

  - [x] 2.2 Implement `createMessage` function
    - Build Bedrock request body with `anthropic_version: "bedrock-2023-05-31"`, `max_tokens`, `system`, `messages`
    - Include `tools` array in Anthropic Messages API format when provided; omit when empty/undefined
    - Send `InvokeModelCommand` to Bedrock
    - Throw structured `LLMError` with `{ errorType, message, statusCode }` on Bedrock API errors
    - _Requirements: 1.1, 1.2, 1.7, 1.8, 1.6_

  - [x] 2.3 Implement response normalization (`normalizeResponse`)
    - Transform Bedrock response envelope into internal format: `{ role: "assistant", content: [...], stop_reason, usage: { input_tokens, output_tokens } }`
    - Handle text content blocks: `{ type: "text", text: string }`
    - Handle tool_use content blocks: `{ type: "tool_use", id: string, name: string, input: object }`
    - _Requirements: 1.3, 11.1, 11.2, 11.3, 11.4_

  - [x] 2.4 Write property tests for response normalization (Properties 1, 2)
    - **Property 1: Response Normalization Structure** — For any valid Bedrock response, normalized output has correct structure with role, content array, stop_reason, and usage
    - **Property 2: Response Serialization Round-Trip** — For any normalized response, JSON serialize/parse produces deeply equal object
    - Use `arbBedrockResponse()` and `arbContentBlock()` generators
    - **Validates: Requirements 1.3, 11.1, 11.2, 11.3, 11.4**

  - [x] 2.5 Write property tests for error handling and tool formatting (Properties 3, 4)
    - **Property 3: Error Response Normalization** — For any Bedrock error, thrown error contains errorType, message, and statusCode
    - **Property 4: Tool Definition Formatting** — For any non-empty tool array, formatted output matches Anthropic Messages API tool format
    - Use `arbBedrockError()` and `arbToolDefinition()` generators
    - **Validates: Requirements 1.6, 1.7**

- [x] 3. Implement LLM Abstraction Layer — Streaming
  - [x] 3.1 Implement `streamMessage` function and stream event normalization
    - Create async generator function sending `InvokeModelWithResponseStreamCommand`
    - Implement `normalizeStreamEvent(bedrockEvent, accumulator)` to transform Bedrock chunk events
    - Yield `{ type: "text", text }` for `content_block_delta` with `text_delta`
    - Yield `{ type: "tool_use_start", id, name }` for `content_block_start` with `tool_use` type
    - Yield `{ type: "tool_input_delta", partialJson }` for `input_json_delta` events
    - Yield `{ type: "message_complete", response }` on `message_stop` with assembled full response
    - Yield `{ type: "error", error }` on network/service errors and terminate iterable
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 3.2 Write property tests for streaming (Properties 5, 6, 7)
    - **Property 5: Stream Event Normalization** — For any valid Bedrock stream event, normalized events have correct types and content
    - **Property 6: Stream Message Assembly** — For any complete event sequence ending with message_stop, final message_complete contains all accumulated content blocks
    - **Property 7: Stream Error Termination** — For any stream error, exactly one error event is yielded then iterable terminates
    - Use `arbStreamEventSequence()` generator
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7, 2.8**

- [x] 4. Checkpoint — LLM Abstraction Layer complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Custom Agent Loop — Preflight and Routing
  - [x] 5.1 Implement Preflight Gate node
    - Create `src/agentLoop.js` with `preflightNode(state)` function
    - Make single Haiku LLM call via `createMessage` from `src/llm.js`
    - Parse response into structured result: `{ onTopic, intent, toolTags, skillIds }`
    - Handle parse failures by treating as on-topic (fail-open) with logged warning
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 5.2 Implement Skill Loading and Skill Router nodes
    - Implement `loadSkillsNode(state, callbacks)` — load skills based on preflight `skillIds`, invoke `callbacks.onSkillActive`
    - Implement `skillRouterNode(state)` — determine `executionMode` ("multi-node" or "research") based on loaded skills and intent
    - _Requirements: 4.2, 4.4, 4.5_

  - [x] 5.3 Implement `runAgentLoop` orchestrator function
    - Wire nodes in order: Preflight → Skill Loading → Skill Router → path execution
    - When `onTopic` is false, invoke refusal callback and terminate (no research/synthesis)
    - Invoke `callbacks.onPhase` at each major phase transition
    - Invoke `callbacks.onError` for unrecoverable errors and terminate gracefully
    - Enforce no dependency on `@langchain/langgraph` or `@langchain/core`
    - _Requirements: 4.1, 4.2, 4.3, 4.8, 8.2, 8.4_

  - [x] 5.4 Write property tests for preflight and routing (Properties 8, 9, 10, 15)
    - **Property 8: Agent Loop Execution Order** — For any on-topic state, nodes execute in order: Preflight → Skill Loading → Skill Router → path
    - **Property 9: Off-Topic Early Termination** — For any off-topic state, refusal is invoked and research/synthesis are NOT invoked
    - **Property 10: Skill Router Correctness** — executionMode "multi-node" triggers multi-node path; "research" triggers Research_Dispatcher
    - **Property 15: Preflight Output Structure** — Parsed result always contains onTopic (boolean), intent (string), toolTags (array), skillIds (array)
    - Use `arbAgentState()` and `arbPreflightResult()` generators
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 5.2, 5.3**

- [x] 6. Implement Custom Agent Loop — Research Dispatch
  - [x] 6.1 Implement parallel research dispatcher
    - Implement `parallelResearchNode(state, callbacks)` dispatching sub-agents for Jira, Confluence, Docs, Web concurrently via `Promise.allSettled`
    - Each sub-agent uses Haiku model via `createMessage`/`streamMessage` for multi-turn tool-calling
    - Collect structured JSON summaries from successful sub-agents
    - Log failures/timeouts and continue with available results
    - Invoke `callbacks.onPhase` with research results summary on completion
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 6.2 Implement sequential research fallback
    - Implement `sequentialResearchFallback(state, callbacks)` for when parallel research fails or returns insufficient results
    - Set `state.fallbackToSequential = true` when all parallel sub-agents fail
    - Wire fallback into `runAgentLoop` — if parallel research insufficient, invoke sequential mode
    - _Requirements: 4.6_

  - [x] 6.3 Write property tests for research dispatch (Properties 11, 12)
    - **Property 11: Research Fault Tolerance** — When at least one sub-agent fails, results from successful sub-agents are still collected and onPhase is invoked
    - **Property 12: Parallel Research Fallback** — When all sub-agents fail, Agent_Loop falls back to sequential research mode
    - Use `arbResearchResults()` generator
    - **Validates: Requirements 4.6, 6.3, 6.4, 6.5**

- [x] 7. Implement Custom Agent Loop — Synthesis Loop
  - [x] 7.1 Implement synthesis loop with tool use and streaming
    - Implement `synthesisLoop(state, callbacks)` invoking `streamMessage` with full context
    - On text delta events, invoke `callbacks.onToken` with text content
    - On completed tool_use blocks, execute tool handler, append result to messages, invoke `callbacks.onToolStatus`
    - When `stop_reason` is `"tool_use"`, re-invoke LLM with tool results appended
    - When `stop_reason` is `"end_turn"`, finalize response and invoke `callbacks.onComplete`
    - Enforce maximum iteration limit to prevent infinite tool-use loops
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 7.2 Write property tests for synthesis loop (Properties 13, 14)
    - **Property 13: Synthesis Loop Tool Handling** — For any tool_use block, tool handler is executed, result appended, and onToolStatus invoked
    - **Property 14: Synthesis Loop Termination** — stop_reason "tool_use" re-invokes LLM; "end_turn" finalizes; loop always terminates within max iterations
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7**

- [x] 8. Implement Callback Interface and Phase Transitions
  - [x] 8.1 Implement callback interface validation and phase transition logic
    - Define `CallbackInterface` with all required functions: onToken, onStatus, onPhase, onToolStatus, onSkillActive, onPlanUpdate, onDocumentReady, onError
    - Ensure Agent_Loop invokes `callbacks.onPhase` at transitions between preflight, research/multi-node, and synthesis
    - Ensure `callbacks.onStatus` is invoked for status messages (including compaction notifications)
    - Ensure `callbacks.onError` terminates execution gracefully on unrecoverable errors
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 8.2 Write property tests for callbacks and error handling (Properties 17, 18)
    - **Property 17: Phase Transition Callbacks** — For any complete execution, onPhase is invoked at each major phase transition with correct phase name
    - **Property 18: Unrecoverable Error Handling** — For any unrecoverable error, onError is invoked and no further nodes execute
    - **Validates: Requirements 8.2, 8.4**

- [x] 9. Implement Context Compaction Integration
  - [x] 9.1 Update context compaction to use LLM abstraction
    - Modify `src/compaction.js` to call Haiku model via `createMessage` from `src/llm.js` instead of Anthropic SDK
    - Preserve full conversation history in database while providing compacted version for LLM context
    - Invoke `callbacks.onStatus` with compaction notification when compaction is performed
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 9.2 Write property test for context compaction (Property 16)
    - **Property 16: Context Compaction Trigger** — Conversations exceeding threshold trigger summarization; those below do not; full history always preserved in DB
    - **Validates: Requirements 9.1, 9.2**

- [x] 10. Checkpoint — Custom Agent Loop complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Integration wiring and server updates
  - [x] 11.1 Wire Agent Loop into Express server
    - Update `src/server.js` to import and invoke `runAgentLoop` instead of LangGraph
    - Build `CallbackInterface` from SSE response object, mapping callbacks to SSE event types
    - Remove any LangSmith environment checks or imports
    - Construct `AgentState` from incoming request (conversationId, messages, systemPrompt, problemText)
    - _Requirements: 4.1, 8.1_

  - [x] 11.2 Update preflight and clientPersona to use LLM abstraction
    - Update `src/preflight.js` to use `createMessage` from `src/llm.js` instead of Anthropic SDK
    - Update `src/clientPersona.js` to use `createMessage` from `src/llm.js` instead of Anthropic SDK
    - Ensure preflight and persona detection run in parallel as before
    - _Requirements: 5.1, 5.4_

  - [x] 11.3 Update research agents to use LLM abstraction
    - Update `src/researchAgents.js` to use `createMessage`/`streamMessage` from `src/llm.js` instead of Anthropic SDK
    - Preserve multi-turn tool-calling research pattern
    - Preserve query reformulation Haiku call
    - _Requirements: 6.2_

  - [x] 11.4 Write integration tests for end-to-end agent loop
    - Test full agent loop with mocked LLM responses (on-topic research path)
    - Test off-topic rejection path
    - Test tool-use synthesis loop with mock tools
    - Test SSE streaming from Express server to client
    - _Requirements: 4.2, 4.3, 7.1, 8.1_

- [x] 12. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- The implementation uses JavaScript throughout, matching the existing codebase
- All reusable modules are copied verbatim — no modifications needed
- The source repository path should be configured or provided at implementation time

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3"] },
    { "id": 4, "tasks": ["2.4", "2.5", "3.1"] },
    { "id": 5, "tasks": ["3.2"] },
    { "id": 6, "tasks": ["5.1", "5.2"] },
    { "id": 7, "tasks": ["5.3"] },
    { "id": 8, "tasks": ["5.4", "6.1"] },
    { "id": 9, "tasks": ["6.2"] },
    { "id": 10, "tasks": ["6.3", "7.1"] },
    { "id": 11, "tasks": ["7.2", "8.1"] },
    { "id": 12, "tasks": ["8.2", "9.1"] },
    { "id": 13, "tasks": ["9.2", "11.1", "11.2", "11.3"] },
    { "id": 14, "tasks": ["11.4"] }
  ]
}
```
