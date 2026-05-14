# Requirements Document

## Introduction

This document specifies the requirements for migrating the Capillary Solution Agent (now "TAM Agent") from its current stack (Anthropic SDK + LangGraph + LangSmith + Railway) to a new architecture using AWS Bedrock for LLM inference and a custom async state machine for orchestration. The migration preserves all existing functionality while removing framework dependencies and aligning with AWS infrastructure.

The scope covers Phase 1 (LLM Abstraction Layer) and Phase 2 (Custom State Machine), plus the copying of all reusable modules from the source repository.

## Glossary

- **LLM_Abstraction**: The `src/llm.js` module that provides a unified interface for LLM calls, decoupling application code from any specific SDK.
- **Bedrock_Client**: The AWS Bedrock Runtime client used to invoke Claude models via AWS IAM-authenticated API calls.
- **Agent_Loop**: The `src/agentLoop.js` module implementing an explicit async state machine that replaces the LangGraph StateGraph.
- **Preflight_Gate**: A classification step that determines whether a user query is on-topic, identifies intent, required tool tags, and skill IDs.
- **Skill_Router**: A decision node that routes execution to either multi-node (skill-driven) or research-based paths.
- **Research_Dispatcher**: The component that dispatches domain-specific sub-agents (Jira, Confluence, Docs, Web) in parallel for information gathering.
- **Synthesis_Loop**: The final agent loop where the main LLM generates a response using gathered research context, with tool-use capability.
- **SSE_Emitter**: The Server-Sent Events streaming mechanism that delivers typed events (token, status, phase, tool_status, skill_active, plan_update, document_ready, error) to the frontend.
- **Store_Factory**: The `src/stores/index.js` module that provides backend-agnostic persistence adapters switchable via environment variable.
- **Context_Compactor**: The module that estimates token usage and summarises older messages when the context window threshold is exceeded.
- **Callback_Interface**: A set of callback functions passed to the Agent_Loop for emitting SSE streaming events during execution.

## Requirements

### Requirement 1: LLM Abstraction — Non-Streaming Message Creation

**User Story:** As a developer, I want a unified LLM interface for non-streaming calls, so that all application code is decoupled from the AWS Bedrock SDK specifics.

#### Acceptance Criteria

1. THE LLM_Abstraction SHALL expose a `createMessage` function accepting `model`, `system`, `messages`, `tools`, and `maxTokens` parameters.
2. WHEN `createMessage` is invoked, THE Bedrock_Client SHALL send an `InvokeModelCommand` to the configured AWS region using IAM credentials for authentication.
3. WHEN a successful response is received from Bedrock, THE LLM_Abstraction SHALL normalize the Bedrock response envelope into the internal message format containing `role`, `content` (array of text and tool_use blocks), `stop_reason`, and `usage` (input_tokens, output_tokens).
4. WHEN the `model` parameter is `"sonnet"`, THE LLM_Abstraction SHALL resolve it to the model ID specified in the `BEDROCK_SONNET_MODEL_ID` environment variable.
5. WHEN the `model` parameter is `"haiku"`, THE LLM_Abstraction SHALL resolve it to the model ID specified in the `BEDROCK_HAIKU_MODEL_ID` environment variable.
6. IF the Bedrock API returns an error, THEN THE LLM_Abstraction SHALL throw a structured error containing the error type, message, and HTTP status code.
7. WHEN `tools` is provided, THE LLM_Abstraction SHALL format the tools array into the Anthropic Messages API tool format within the Bedrock request body.
8. WHEN `tools` is omitted or empty, THE LLM_Abstraction SHALL omit the `tools` field from the Bedrock request body.

### Requirement 2: LLM Abstraction — Streaming Message Creation

**User Story:** As a developer, I want a streaming LLM interface, so that the agent can deliver real-time token-by-token responses to users via SSE.

#### Acceptance Criteria

1. THE LLM_Abstraction SHALL expose a `streamMessage` function accepting `model`, `system`, `messages`, `tools`, and `maxTokens` parameters.
2. WHEN `streamMessage` is invoked, THE Bedrock_Client SHALL send an `InvokeModelWithResponseStreamCommand` to the configured AWS region.
3. THE `streamMessage` function SHALL return an async iterable that yields normalized event objects.
4. WHEN a `content_block_delta` event of type `text_delta` is received from the Bedrock stream, THE LLM_Abstraction SHALL yield an event with `type: "text"` and the `text` content.
5. WHEN a `content_block_start` event of type `tool_use` is received from the Bedrock stream, THE LLM_Abstraction SHALL yield an event with `type: "tool_use_start"` containing the tool `id` and `name`.
6. WHEN a `content_block_delta` event of type `input_json_delta` is received, THE LLM_Abstraction SHALL yield an event with `type: "tool_input_delta"` and the partial JSON string.
7. WHEN the `message_stop` event is received, THE LLM_Abstraction SHALL yield a final event with `type: "message_complete"` containing the full assembled response (role, content blocks, stop_reason, usage).
8. IF the Bedrock stream encounters a network or service error mid-stream, THEN THE LLM_Abstraction SHALL yield an event with `type: "error"` containing the error details and terminate the iterable.

### Requirement 3: LLM Abstraction — AWS Authentication

**User Story:** As a platform engineer, I want the LLM layer to use IAM-based authentication, so that no API keys need to be managed or rotated manually.

#### Acceptance Criteria

1. THE Bedrock_Client SHALL authenticate using the default AWS credential chain (environment variables, IAM role, or shared credentials file).
2. THE Bedrock_Client SHALL use the AWS region specified in the `AWS_REGION` environment variable.
3. WHEN running on ECS Fargate, THE Bedrock_Client SHALL obtain credentials from the ECS task IAM role without additional configuration.
4. IF AWS credentials are missing or invalid, THEN THE LLM_Abstraction SHALL throw a descriptive error indicating the authentication failure before attempting any API call.

### Requirement 4: Custom Agent Loop — State Machine Orchestration

**User Story:** As a developer, I want an explicit async state machine replacing LangGraph, so that the orchestration logic is simpler to debug and has no framework dependencies.

#### Acceptance Criteria

1. THE Agent_Loop SHALL expose a `runAgentLoop` function accepting a `state` object and a `callbacks` object.
2. THE Agent_Loop SHALL execute nodes in the following order: Preflight_Gate, Skill Loading, Skill_Router, then either multi-node path or research path based on router decision.
3. WHEN the Preflight_Gate classifies a query as off-topic, THE Agent_Loop SHALL invoke the refusal callback and terminate without proceeding to research or synthesis.
4. WHEN the Skill_Router determines `executionMode` is `"multi-node"`, THE Agent_Loop SHALL delegate to the multi-node execution path using loaded skill context.
5. WHEN the Skill_Router determines `executionMode` is `"research"`, THE Agent_Loop SHALL dispatch the Research_Dispatcher for parallel information gathering.
6. IF parallel research fails or returns insufficient results, THEN THE Agent_Loop SHALL fall back to sequential research mode.
7. WHEN research is complete, THE Agent_Loop SHALL proceed to the Synthesis_Loop for final response generation.
8. THE Agent_Loop SHALL NOT depend on `@langchain/langgraph` or `@langchain/core` packages.

### Requirement 5: Custom Agent Loop — Preflight Gate Integration

**User Story:** As a developer, I want the preflight gate to classify intent before any expensive operations, so that off-topic queries are rejected early and tool/skill routing is determined upfront.

#### Acceptance Criteria

1. WHEN a user message is received, THE Preflight_Gate SHALL make a single LLM call using the Haiku model via the LLM_Abstraction.
2. THE Preflight_Gate SHALL return a structured result containing `onTopic` (boolean), `intent` (string), `toolTags` (array), and `skillIds` (array).
3. WHEN `onTopic` is false, THE Agent_Loop SHALL generate a polite refusal response without invoking research or synthesis nodes.
4. THE Preflight_Gate SHALL execute in parallel with client persona detection to minimize latency.

### Requirement 6: Custom Agent Loop — Parallel Research Dispatch

**User Story:** As a developer, I want domain-specific sub-agents dispatched in parallel, so that research across Jira, Confluence, Docs, and Web sources completes with minimal latency.

#### Acceptance Criteria

1. WHEN the research path is selected, THE Research_Dispatcher SHALL dispatch sub-agents for each relevant domain (Jira, Confluence, Docs, Web) concurrently using `Promise.allSettled`.
2. Each sub-agent SHALL use the Haiku model via the LLM_Abstraction for multi-turn tool-calling research.
3. WHEN a sub-agent completes, THE Research_Dispatcher SHALL collect its structured JSON summary into the aggregated research context.
4. IF a sub-agent fails or times out, THEN THE Research_Dispatcher SHALL log the failure and continue with results from successful sub-agents.
5. WHEN all sub-agents complete, THE Research_Dispatcher SHALL invoke the `callbacks.onPhase` callback with the research results summary.

### Requirement 7: Custom Agent Loop — Synthesis with Tool Use

**User Story:** As a developer, I want the synthesis loop to stream responses with tool-use capability, so that the agent can call tools during response generation and deliver real-time output.

#### Acceptance Criteria

1. THE Synthesis_Loop SHALL invoke `streamMessage` on the LLM_Abstraction with the full context (system prompt, conversation history, research results, available tools).
2. WHEN a text delta event is received from the stream, THE Synthesis_Loop SHALL invoke `callbacks.onToken` with the text content.
3. WHEN a tool_use block is completed in the stream, THE Synthesis_Loop SHALL execute the tool handler and append the tool result to messages.
4. WHEN a tool_use block is completed, THE Synthesis_Loop SHALL invoke `callbacks.onToolStatus` with the tool name and execution status.
5. WHEN the LLM response has `stop_reason` of `"tool_use"`, THE Synthesis_Loop SHALL re-invoke the LLM with the tool results appended and continue streaming.
6. WHEN the LLM response has `stop_reason` of `"end_turn"`, THE Synthesis_Loop SHALL finalize the response and invoke `callbacks.onComplete`.
7. THE Synthesis_Loop SHALL enforce a maximum iteration limit to prevent infinite tool-use loops.

### Requirement 8: Custom Agent Loop — SSE Callback Interface

**User Story:** As a developer, I want a well-defined callback interface for SSE events, so that the streaming layer remains decoupled from orchestration logic.

#### Acceptance Criteria

1. THE Callback_Interface SHALL support the following callback functions: `onToken`, `onStatus`, `onPhase`, `onToolStatus`, `onSkillActive`, `onPlanUpdate`, `onDocumentReady`, and `onError`.
2. WHEN the Agent_Loop transitions between major phases (preflight, research, synthesis), THE Agent_Loop SHALL invoke `callbacks.onPhase` with the phase name.
3. WHEN a status message needs to be communicated, THE Agent_Loop SHALL invoke `callbacks.onStatus` with the status text.
4. IF an unrecoverable error occurs during execution, THEN THE Agent_Loop SHALL invoke `callbacks.onError` with the error details and terminate gracefully.

### Requirement 9: Context Compaction Integration

**User Story:** As a developer, I want context compaction to use the new LLM abstraction, so that long conversations are summarised without exceeding the context window.

#### Acceptance Criteria

1. WHEN the estimated token count of the conversation exceeds the configured threshold, THE Context_Compactor SHALL summarise older messages using the Haiku model via the LLM_Abstraction.
2. THE Context_Compactor SHALL preserve the full conversation history in the database while providing a compacted version for LLM context.
3. WHEN compaction is performed, THE Context_Compactor SHALL invoke `callbacks.onStatus` with a compaction notification.

### Requirement 10: Reusable Module Migration

**User Story:** As a developer, I want all backend-agnostic modules copied from the source repository, so that existing functionality (auth, stores, tools, skills, frontend) is preserved without reimplementation.

#### Acceptance Criteria

1. THE Store_Factory SHALL be copied from the source repository with zero modifications, preserving the MongoDB and JSON backend adapters.
2. THE authentication modules (`auth.js`, `passwordPolicy.js`, `lockout.js`, `auditLogger.js`) SHALL be copied from the source repository with zero modifications.
3. THE tool modules (`tools/index.js`, `tools/jira.js`, `tools/confluence.js`, `tools/kapa.js`, `tools/webSearch.js`) SHALL be copied from the source repository with zero modifications.
4. THE plan management module (`planManager.js`) SHALL be copied from the source repository with zero modifications.
5. THE document store module (`documentStore.js`) SHALL be copied from the source repository with zero modifications.
6. THE file handler module (`fileHandler.js`) SHALL be copied from the source repository with zero modifications.
7. THE skill loader module (`skillLoader.js`) and the `skills/` directory SHALL be copied from the source repository with zero modifications.
8. THE frontend files (`public/` directory) SHALL be copied from the source repository with zero modifications.
9. THE database connection module (`db.js`) and migration module (`migration.js`) SHALL be copied from the source repository with zero modifications.

### Requirement 11: LLM Abstraction — Response Format Normalization

**User Story:** As a developer, I want Bedrock responses normalized to a consistent internal format, so that all downstream code works without awareness of the underlying provider.

#### Acceptance Criteria

1. FOR ALL successful responses, THE LLM_Abstraction SHALL return an object with the structure: `{ role: "assistant", content: [...blocks], stop_reason: string, usage: { input_tokens: number, output_tokens: number } }`.
2. WHEN the response contains text content, THE LLM_Abstraction SHALL include a content block of `{ type: "text", text: string }`.
3. WHEN the response contains a tool use request, THE LLM_Abstraction SHALL include a content block of `{ type: "tool_use", id: string, name: string, input: object }`.
4. FOR ALL responses, parsing then re-serializing the normalized response SHALL produce an equivalent object (round-trip property).

### Requirement 12: Dependency Management

**User Story:** As a developer, I want the new project to have minimal dependencies, so that the deployment artifact is lean and maintainable.

#### Acceptance Criteria

1. THE project SHALL include `@aws-sdk/client-bedrock-runtime` as the sole AWS SDK dependency for LLM calls.
2. THE project SHALL NOT include `@anthropic-ai/sdk`, `@langchain/langgraph`, `@langchain/core`, or `langsmith` as dependencies.
3. THE project SHALL retain all existing non-LLM dependencies from the source repository (express, mongodb, multer, etc.) that are required by reusable modules.
