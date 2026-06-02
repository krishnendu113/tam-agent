# Implementation Plan: Skill System Enhancement

## Overview

This plan transforms the TAM Agent from an eager-loading, single-context architecture to a lazy-loading, plan-driven, multi-model orchestration system. Implementation proceeds in phases: foundational modules first (logger, tracing, db, skill loader), then tools and orchestration (plan manager, sub-agent, compaction, chat history), then integration into the agent loop, and finally UI and infrastructure scripts.

## Tasks

- [ ] 1. Foundation: Structured Logger and Tracing Module
  - [ ] 1.1 Create `src/logger.js` with structured JSON logging
    - Implement `logLLMCall(params)` emitting JSON with timestamp, level, event, model, input_tokens, output_tokens, latency_ms, client_tag, session_id, request_id
    - Implement `logRequestComplete(params)` emitting JSON with timestamp, level, event, total_latency_ms, total_input_tokens, total_output_tokens, llm_call_count, client_tag, session_id, request_id
    - Implement `logEvent(level, event, data)` for general structured logging
    - All output via `console.log(JSON.stringify(...))` for CloudWatch compatibility
    - _Requirements: 11.15, 11.16, 11.17_

  - [ ]* 1.2 Write property test for structured JSON log validity (Property 18)
    - **Property 18: Structured JSON Log Validity**
    - For any LLM call or request completion event, emitted log line SHALL be valid JSON parseable by JSON.parse() and contain all required fields
    - **Validates: Requirements 11.15, 11.16, 11.17**

  - [ ] 1.3 Create `src/tracing.js` with LangFuse SDK wrapper
    - Implement `initTracing()` reading LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
    - Implement no-op mode when env vars are missing (all calls succeed silently, no network requests)
    - Implement `createTrace(metadata)`, `startSpan(trace, name, input)`, `endSpan(span, output)`
    - Implement `startGeneration(trace, params)`, `endGeneration(generation, output, usage)`
    - Implement `flushTracing()` for end-of-request flush
    - Configure Model_Pricing from HAIKU_INPUT_COST_PER_1K, HAIKU_OUTPUT_COST_PER_1K, SONNET_INPUT_COST_PER_1K, SONNET_OUTPUT_COST_PER_1K env vars with defaults
    - _Requirements: 11.1, 11.2, 11.13, 11.14, 11.20, 11.21_

  - [ ]* 1.4 Write property test for tracing no-op mode safety (Property 19)
    - **Property 19: Tracing No-Op Mode Safety**
    - For any sequence of tracing function calls when LangFuse env vars are not configured, all calls SHALL complete without throwing exceptions and SHALL not emit network requests
    - **Validates: Requirements 11.2**

  - [ ]* 1.5 Write property test for trace metadata propagation (Property 20)
    - **Property 20: Trace Metadata Propagation**
    - For any request with a Client_Tag, that tag SHALL appear unchanged on the LangFuse Trace metadata and every Generation; token usage values SHALL appear in the corresponding LangFuse generation usage field
    - **Validates: Requirements 11.7, 11.8**

  - [ ] 1.6 Implement Client_Tag extraction utility
    - Create helper function to extract Jira project key from query text (regex: `[A-Z][A-Z0-9]+-\d+`)
    - Return project key portion (e.g., "PROJ" from "PROJ-123"), or null if no match
    - _Requirements: 11.9_

  - [ ]* 1.7 Write property test for Jira project key extraction (Property 21)
    - **Property 21: Jira Project Key Extraction**
    - For any string containing a Jira ticket reference matching `[A-Z][A-Z0-9]+-\d+`, extraction SHALL return the project key portion; for strings without, SHALL return null
    - **Validates: Requirements 11.9**

- [ ] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Foundation: Skill Loader Rewrite
  - [ ] 3.1 Rewrite `src/skillLoader.js` with SKILL.md-only discovery
    - Implement `discoverSkills()` scanning `skills/` directory for subdirectories containing `SKILL.md`
    - Parse YAML frontmatter (split on `---` delimiters, extract key-value pairs for name, description)
    - Skip directories without SKILL.md, log warning
    - Skip directories with malformed YAML, log warning without crashing
    - Return normalized SkillManifest objects with id (directory name), name, description, path (absolute)
    - Ignore any `skill.json` or `prompt.md` files
    - Implement `getSkillSummary(skillId)` returning only frontmatter description + first heading block
    - Implement `getSkillReferences(skillId)` returning ReferenceFileInfo array
    - Implement `loadReferenceFile(skillId, fileName)` with path traversal prevention
    - Implement `getRegistryTriggers()` merging trigger keywords from `skills/registry.json`
    - Cache parsed skill manifests at startup (invalidated on restart)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4_

  - [ ]* 3.2 Write property test for SKILL.md parsing round-trip (Property 1)
    - **Property 1: SKILL.md Parsing Round-Trip Produces Normalized Objects**
    - For any valid SKILL.md with YAML frontmatter containing name and description, parsing SHALL produce a normalized skill object with id, name, description, and path as non-empty strings
    - **Validates: Requirements 1.1, 1.4**

  - [ ]* 3.3 Write property test for malformed YAML resilience (Property 2)
    - **Property 2: Malformed YAML Frontmatter Never Crashes the Parser**
    - For any string that is not valid YAML frontmatter, the parser SHALL return null without throwing
    - **Validates: Requirements 1.3**

  - [ ]* 3.4 Write property test for summary loading exclusion (Property 3)
    - **Property 3: Skill Summary Loading Excludes Full Body Content**
    - For any SKILL.md with body longer than frontmatter + first heading, loaded summary SHALL have character length strictly less than full file content
    - **Validates: Requirements 2.1, 2.2**

- [ ] 4. Foundation: Reference File Tools
  - [ ] 4.1 Create `src/tools/skillReference.js` with load_skill_reference and list_skill_references tools
    - Implement `load_skill_reference` tool with skillId and fileName parameters
    - Resolve file path using `path.resolve()`, verify resolved path starts with skill directory absolute path
    - Reject any path containing `..` segments or resolving outside skill directory
    - Return full text content of matching reference file
    - Return error with available file list if fileName not found
    - Implement `list_skill_references` tool returning available reference file names for a skill
    - Tag both tools with `["skill"]`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 4.2 Write property test for path traversal prevention (Property 4)
    - **Property 4: Reference File Path Traversal Prevention**
    - For any fileName input (including `../`, absolute paths, encoded sequences, null bytes), resolved path SHALL always begin with skill directory prefix; invalid inputs SHALL result in error
    - **Validates: Requirements 3.6**

  - [ ]* 4.3 Write property test for reference file content round-trip (Property 5)
    - **Property 5: Reference File Content Round-Trip**
    - For any file written to a skill's reference directory, invoking load_skill_reference SHALL return content byte-for-byte identical to what was written
    - **Validates: Requirements 3.2**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Plan Manager and Tools
  - [ ] 6.1 Create `src/planManager.js` with plan CRUD operations
    - Implement `createPlan(title, tasks)` writing structured .md file to `plans/` directory
    - Plan file format: markdown with title, checkboxes, status metadata, planId comment
    - Plan naming: `plans/{sessionId}_{timestamp}.md`
    - Implement `updatePlanTask(planId, taskId, status, result)` modifying task in-place on disk
    - Implement `readPlan(planId)` parsing plan file back to PlanFile object
    - Implement `listSessionPlans(sessionId)` returning PlanSummary array
    - Enforce maximum 15 tasks per plan (reject with validation error if exceeded)
    - Ensure `plans/` directory is created if it doesn't exist
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.10_

  - [ ]* 6.2 Write property test for plan serialization round-trip (Property 6)
    - **Property 6: Plan File Serialization Round-Trip**
    - For any valid plan with title and 1-15 tasks, creating via create_plan and reading via read_plan SHALL produce identical title, task count, ids, descriptions, and critical flags
    - **Validates: Requirements 4.2, 4.5**

  - [ ]* 6.3 Write property test for plan task update isolation (Property 7)
    - **Property 7: Plan Task Update Preserves Other Tasks**
    - For any plan with N tasks, updating a single task K SHALL leave all other N-1 tasks unchanged
    - **Validates: Requirements 4.4**

  - [ ]* 6.4 Write property test for plan max task limit (Property 8)
    - **Property 8: Plan Maximum Task Limit Enforcement**
    - For any task array > 15 elements, create_plan SHALL reject; for 1-15 elements, SHALL succeed
    - **Validates: Requirements 4.7**

  - [ ] 6.5 Create `src/tools/planTools.js` registering create_plan, update_plan_task, read_plan tools
    - Implement tool handlers wrapping planManager functions
    - Define inputSchema for each tool matching design specifications
    - Tag all tools with `["plan"]`
    - _Requirements: 4.1, 4.3, 4.5_

- [ ] 7. Sub-Agent Delegation Tool
  - [ ] 7.1 Create `src/tools/subAgent.js` with delegate_to_subagent tool
    - Refactor sub-agent pattern from `agentLoop.js` into standalone tool
    - Accept taskDescription (required), context (optional), maxTurns (optional, default 5)
    - Clamp maxTurns to [1, 10] range
    - Execute isolated multi-turn tool loop using Haiku model via createMessage
    - Sub-agent has access to same tool set as main agent
    - Return final text output as tool result
    - Terminate and return partial result + warning if max turns exceeded
    - Tag tool with `["agent"]`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 7.2 Write property test for sub-agent turn limit clamping (Property 9)
    - **Property 9: Sub-Agent Turn Limit Clamping**
    - For any maxTurns integer, effective limit SHALL be Math.min(Math.max(maxTurns, 1), 10)
    - **Validates: Requirements 5.4**

- [ ] 8. Context Compaction Module
  - [ ] 8.1 Create `src/compaction.js` with context compaction logic
    - Implement `estimateTokenCount(messages)` using character-based heuristic (4 chars ≈ 1 token)
    - Implement `shouldCompact(messages, threshold)` returning true iff estimated tokens exceed threshold
    - Implement `compactHistory(messages, preserveTurns)` calling Haiku to summarize older turns
    - Implement `buildCompactedContext(compactedSummary, recentMessages)` assembling context for LLM
    - Read CONTEXT_COMPACTION_THRESHOLD (default 75) and CONTEXT_COMPACTION_PRESERVE_TURNS (default 5)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.12, 8.13_

  - [ ]* 8.2 Write property test for compaction threshold trigger (Property 11)
    - **Property 11: Compaction Threshold Trigger Condition**
    - shouldCompact SHALL return true iff estimated token count exceeds (threshold/100) * MAX_CONTEXT_TOKENS; pure deterministic function
    - **Validates: Requirements 8.1**

  - [ ]* 8.3 Write property test for compaction preserving recent turns (Property 12)
    - **Property 12: Compaction Preserves Recent Turns Verbatim**
    - After compaction, most recent PRESERVE_TURNS messages SHALL be byte-for-byte identical to last PRESERVE_TURNS of original array
    - **Validates: Requirements 8.3**

  - [ ]* 8.4 Write property test for compaction not mutating originals (Property 13)
    - **Property 13: Compaction Does Not Mutate Original Messages**
    - Messages stored before compaction SHALL remain byte-for-byte identical after; only new compactedHistory field is written
    - **Validates: Requirements 8.5**

- [ ] 9. Chat History Tools
  - [ ] 9.1 Create `src/tools/chatHistory.js` with lookup_chat_history and get_session_summary tools
    - Implement `lookup_chat_history` tool with sessionId, startTurn, endTurn, searchTerm parameters
    - Search by term: case-insensitive substring match, return matching messages with turn numbers and timestamps
    - Range query: return messages at specified turn positions (inclusive), in order
    - Return error if sessionId not found
    - Implement `get_session_summary` tool returning turn count, compaction events, context utilization
    - Tag tools with `["history"]`
    - _Requirements: 8.7, 8.8, 8.9, 8.10, 8.11_

  - [ ]* 9.2 Write property test for chat history search (Property 14)
    - **Property 14: Chat History Search Returns Exact Matches**
    - For any session with N messages and search term, lookup_chat_history SHALL return exactly messages whose content contains the term (case-insensitive), with correct turn numbers
    - **Validates: Requirements 8.8**

  - [ ]* 9.3 Write property test for chat history range query (Property 15)
    - **Property 15: Chat History Range Query Returns Correct Slice**
    - For any valid range [startTurn, endTurn], lookup_chat_history SHALL return exactly messages at those turn positions (inclusive), in order
    - **Validates: Requirements 8.9**

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Database Migration to DocumentDB
  - [ ] 11.1 Modify `src/db.js` to support DocumentDB with TLS
    - Read STORE_BACKEND env var ("documentdb" or deprecated "mongodb" with warning)
    - Build URI from DOCDB_URI (priority) or compose from DOCDB_CLUSTER_ENDPOINT + DOCDB_USERNAME + DOCDB_PASSWORD
    - URI format: `mongodb://{encoded_user}:{encoded_pass}@{endpoint}:27017/?tls=true&tlsCAFile={caPath}&retryWrites=false&directConnection=true`
    - Configure TLS using DOCDB_TLS_CA_FILE (default `./global-bundle.pem`)
    - Validate CA file existence at connect time, throw descriptive error if missing
    - Set retryWrites: false for DocumentDB
    - Support DOCDB_TLS_ENABLED=false for local dev (connect without TLS)
    - Throw config error if required vars missing when STORE_BACKEND is "documentdb"
    - Log connection status with database name and TLS state
    - Preserve existing `connectDb` / `getDb` / `closeDb` API for backward compatibility
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.12, 9.13, 9.14_

  - [ ]* 11.2 Write property test for DocumentDB URI construction (Property 16)
    - **Property 16: DocumentDB URI Construction**
    - For any valid combination of endpoint, username, password (with special chars), constructed URI SHALL follow correct format with URI-encoded credentials
    - **Validates: Requirements 9.3, 9.4**

  - [ ] 11.3 Update `.env.example` with DocumentDB and LangFuse configuration
    - Replace MongoDB Atlas section with DocumentDB section (DOCDB_URI, DOCDB_CLUSTER_ENDPOINT, DOCDB_USERNAME, DOCDB_PASSWORD, DOCDB_TLS_CA_FILE, DOCDB_TLS_ENABLED)
    - Update STORE_BACKEND comment (valid: "json", "documentdb"; "mongodb" deprecated)
    - Add LangFuse section (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, cost vars)
    - Add APPRUNNER_SERVICE_ARN and DOCDB_CLUSTER_IDENTIFIER for infra toggle
    - Add compaction vars (CONTEXT_COMPACTION_THRESHOLD, CONTEXT_COMPACTION_PRESERVE_TURNS)
    - _Requirements: 9.10, 9.11, 10.13, 11.19_

- [ ] 12. Preflight Classification Enhancement
  - [ ] 12.1 Modify preflight in `src/agentLoop.js` to use Skill_Registry triggers
    - Load Skill_Registry from `skills/registry.json` at startup, cache in memory
    - Match user query against trigger keywords for all registered skills
    - Return all matching skill IDs in classification result (not just LLM-selected ones)
    - Merge LLM-classified skillIds with trigger-matched skillIds
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 12.2 Write property test for skill registry trigger matching (Property 10)
    - **Property 10: Skill Registry Trigger Matching Returns All Matches**
    - For any query containing trigger keywords, preflight SHALL include every skill ID whose triggers overlap with query text
    - **Validates: Requirements 6.1, 6.2, 6.3**

- [ ] 13. Agent Loop Integration
  - [ ] 13.1 Modify `src/agentLoop.js` with plan-first routing and compaction
    - Add compaction check before synthesis (call shouldCompact, trigger compactHistory if needed)
    - Add compaction notification to LLM context when compaction occurred
    - Add plan-awareness: inform LLM of existing session plans (IDs and titles only, not content)
    - Instruct LLM to use create_plan for complex queries
    - Add tracing hooks: createTrace at request start, startSpan/endSpan per phase, endTrace on completion
    - Add structured logging: logLLMCall after each Bedrock call, logRequestComplete at end
    - Integrate Client_Tag extraction (from Jira context in query)
    - Log compaction events with session ID, turn range, token counts
    - _Requirements: 4.6, 4.9, 4.11, 4.12, 8.1, 8.4, 8.6, 8.13, 11.3, 11.4, 11.5, 11.6, 11.15, 11.16_

  - [ ] 13.2 Modify `src/llm.js` to add tracing hooks on createMessage and streamMessage
    - Call startGeneration before Bedrock call with model, input messages, modelId
    - Call endGeneration after response with output and usage (input_tokens, output_tokens)
    - Pass latency timing to logger
    - _Requirements: 11.6, 11.7, 11.20_

  - [ ] 13.3 Modify `src/tools/index.js` to register all new tools
    - Import and register tools from skillReference.js, planTools.js, subAgent.js, chatHistory.js
    - Maintain existing tool registrations unchanged
    - _Requirements: 3.1, 3.5, 4.1, 4.3, 4.5, 5.1, 8.7, 8.11_

  - [ ] 13.4 Modify `src/agentLoop.js` loadSkillsNode to use summary-only loading
    - Replace `loadSkillsById` calls with `getSkillSummary` from new skillLoader
    - Include list of available reference files in skill context (names only)
    - Do NOT load full SKILL.md body or reference files into initial context
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [ ] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Infrastructure and UI
  - [ ] 15.1 Create `scripts/infra-toggle.js` CLI for start/stop App Runner + DocumentDB
    - Accept `start` or `stop` argument from command line
    - Use @aws-sdk/client-apprunner (PauseServiceCommand, ResumeServiceCommand)
    - Use @aws-sdk/client-docdb (StopDBClusterCommand, StartDBClusterCommand)
    - Stop ordering: pause App Runner → stop DocumentDB
    - Start ordering: start DocumentDB → resume App Runner
    - Read APPRUNNER_SERVICE_ARN and DOCDB_CLUSTER_IDENTIFIER from env
    - Exit with descriptive error if required env vars missing
    - Health check polling after start (120s timeout, 5s intervals)
    - Log operation name, resource, status, timestamp for each step
    - Exit non-zero on any AWS API failure without proceeding to subsequent operations
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12_

  - [ ]* 15.2 Write property test for infrastructure toggle ordering (Property 17)
    - **Property 17: Infrastructure Toggle Operation Ordering**
    - For stop: PauseService before StopDBCluster; for start: StartDBCluster before ResumeService
    - **Validates: Requirements 10.3, 10.4**

  - [ ] 15.3 Add admin API endpoint for infra toggle (`POST /api/admin/infra-toggle`)
    - Accept JSON body with `action` field ("start" or "stop")
    - Reuse infra-toggle logic from scripts module
    - _Requirements: 10.2_

  - [ ] 15.4 Modify `public/about.html` with updated capabilities
    - Add Specialist Skills category: BRD Creation, SDD Generation, CR Evaluation, Gap Analysis, Excalidraw Diagrams
    - Retain existing Core Tools: Jira Integration, Confluence Integration, Research and Knowledge Retrieval, Conversation History
    - Group capabilities into "Core Tools" and "Specialist Skills" categories
    - Maintain valid HTML, accessibility attributes (ARIA labels, semantic headings), existing CSS
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 15.5 Update `package.json` with new dependencies
    - Add `langfuse` for tracing
    - Add `@aws-sdk/client-apprunner` for infra toggle
    - Add `@aws-sdk/client-docdb` for infra toggle
    - Use pinned versions for all new dependencies
    - _Requirements: 10.5, 11.1_

- [ ] 16. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (21 total)
- Unit tests validate specific examples and edge cases
- The project uses `vitest` for test running and `fast-check` for property-based tests (both already in devDependencies)
- All code is JavaScript (ES modules) targeting Node.js ≥20
- Existing tools (Jira, Confluence, Kapa, WebSearch, DocsSearch) remain unchanged
- The `src/stores/mongo/index.js` adapter is compatible with DocumentDB without modification

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.6"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.5", "1.7"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "6.1", "7.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.2", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4", "9.1"] },
    { "id": 7, "tasks": ["9.2", "9.3", "11.1"] },
    { "id": 8, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 9, "tasks": ["12.2", "13.1", "13.2"] },
    { "id": 10, "tasks": ["13.3", "13.4"] },
    { "id": 11, "tasks": ["15.1", "15.4", "15.5"] },
    { "id": 12, "tasks": ["15.2", "15.3"] }
  ]
}
```
