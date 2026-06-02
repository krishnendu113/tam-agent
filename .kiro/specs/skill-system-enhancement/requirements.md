# Requirements Document

## Introduction

This document specifies requirements for enhancing the TAM Agent's skill system to support standardized SKILL.md-based skill discovery, lazy/efficient skill loading, on-demand reference file retrieval, plan-first execution with persistent plan files, sub-agent delegation, context compaction with chat history preservation, full observability via LangFuse tracing and CloudWatch structured logging with per-client cost attribution, and an updated about page reflecting the expanded capabilities. The current system loads all skill content eagerly into context, which wastes tokens and limits scalability. All skills use the SKILL.md format with structured markdown and YAML frontmatter.

The system follows a Kiro/Claude-style orchestration model where long-running tasks are memory and token optimized. Detailed context (plan contents, skill references, execution history) is loaded lazily — only when explicitly requested by the LLM. The Agent_Loop informs the LLM about the existence of artifacts (plans, skills, references) but never eagerly loads their full content into context. This "inform about existence, load on demand" principle ensures efficient token usage across extended multi-turn sessions.

As part of the token optimization strategy, the system implements Context_Compaction to handle long-running sessions where conversation history accumulates beyond practical limits. When context size reaches a configurable Compaction_Threshold, older conversation turns are summarized using the Haiku model while preserving the original uncompacted chat history intact on disk. The LLM receives the compacted version for subsequent turns but retains tool access to look up original messages on demand, following the same "inform about existence, load on demand" principle established above.

## Glossary

- **Skill_Loader**: The module (`src/skillLoader.js`) responsible for discovering, parsing, and loading skill definitions from the `skills/` directory.
- **SKILL_MD_Skill**: A skill following the standard pattern with a `SKILL.md` file containing YAML frontmatter metadata and structured markdown content (e.g., `skills/brd/`, `skills/cr-evaluator/`, `skills/excalidraw-diagram/`).
- **Skill_Registry**: The `skills/registry.json` file listing all available skills with their IDs, folder paths, descriptions, and trigger keywords.
- **Reference_File**: A supplementary file within a skill directory (e.g., `references/color-palette.md`, `scoring-engine.md`) that provides detailed context needed only during specific execution phases.
- **Skill_Summary**: The YAML frontmatter description and first-level heading content from a SKILL.md file, loaded initially to conserve tokens.
- **Agent_Loop**: The main orchestration module (`src/agentLoop.js`) that coordinates preflight classification, skill loading, research, and synthesis.
- **Plan_File**: A persistent `.md` file written to disk (in a `plans/` directory) that captures a structured execution plan with tasks, statuses, and results. The LLM creates and updates this file using dedicated tools, similar to how Kiro manages spec task files.
- **Plan_Tool**: A set of tools (`create_plan`, `update_plan_task`, `read_plan`) that allow the LLM to manage Plan_Files as physical artifacts on disk.
- **Sub_Agent**: A delegated execution unit using a cheaper LLM model (Haiku) to perform long-running or complex sub-tasks independently.
- **Tool_Registry**: The module (`src/tools/index.js`) managing available tools and their execution handlers.
- **Bedrock**: AWS Bedrock, the LLM inference service through which all model calls are routed.
- **Haiku**: The Claude Haiku model used for cheap classification, sub-agent work, and delegated tasks.
- **Sonnet**: The Claude Sonnet model used for synthesis and high-quality final responses.
- **Context_Compaction**: The process of summarizing older conversation history using the Haiku model when context size reaches a configurable threshold, producing a condensed version for the LLM while preserving the original chat history intact.
- **Compaction_Threshold**: The percentage of maximum context window at which compaction is triggered (configurable via `CONTEXT_COMPACTION_THRESHOLD` environment variable, default 75%).
- **Compacted_History**: The summarized version of conversation turns produced by Context_Compaction, which replaces older turns in the LLM's working context while preserving key facts, decisions, and context.
- **About_Page**: The public-facing HTML page (`public/about.html`) describing TAM Agent capabilities.
- **DocumentDB**: AWS DocumentDB, a MongoDB-compatible managed database service running within the project's VPC, used for production persistence of conversations, user data, and session state.
- **App_Runner**: AWS App Runner, the compute service hosting the TAM Agent application, which can be paused/resumed to control costs.
- **Infra_Toggle**: A CLI script or admin endpoint that starts/stops the App Runner service and DocumentDB cluster for cost management.
- **LangFuse**: An open-source LLM observability platform used for tracing, token usage tracking, cost attribution, and latency metrics. Configured via `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` environment variables.
- **Client_Tag**: A string identifier associating a query with a specific customer/client for cost attribution and usage reporting. Extracted from Jira project context or provided by the user.
- **Trace**: A LangFuse trace representing a single end-to-end agent request, containing spans and generations with timing and token usage data.
- **Tracing_Module**: The module (`src/tracing.js`) that wraps the LangFuse SDK and provides helper functions for creating traces, spans, and generations within the Agent_Loop.
- **Generation**: A LangFuse generation object representing a single LLM call, capturing model name, input messages, output response, token usage, latency, and associated Client_Tag.
- **Model_Pricing**: A configuration mapping model identifiers (Haiku, Sonnet) to their per-token input and output costs, used by LangFuse for cost attribution.

## Requirements

### Requirement 1: SKILL.md-Only Skill Discovery

**User Story:** As a developer, I want the Skill_Loader to discover and parse skills exclusively using the `SKILL.md` pattern, so that the system has a single consistent skill format and the deprecated `skill.json` + `prompt.md` pattern is no longer supported.

#### Acceptance Criteria

1. WHEN a skill directory contains a `SKILL.md` file, THE Skill_Loader SHALL parse the YAML frontmatter to extract `name` and `description` metadata.
2. WHEN a skill directory does not contain a `SKILL.md` file, THE Skill_Loader SHALL skip that directory and log a warning indicating the directory is not a valid skill.
3. IF a `SKILL.md` file contains malformed YAML frontmatter, THEN THE Skill_Loader SHALL log a warning with the skill directory name and skip that skill without crashing.
4. THE Skill_Loader SHALL return a normalized skill object with consistent fields (`id`, `name`, `description`, `path`) for each discovered skill.
5. WHEN the Skill_Registry file exists, THE Skill_Loader SHALL use it to resolve trigger keywords, `alwaysLoad` flags, and folder mappings for all skills.
6. THE Skill_Loader SHALL ignore any `skill.json` or `prompt.md` files present in a skill directory.

### Requirement 2: Lazy Skill Loading with Summary-Only Context

**User Story:** As a developer, I want skills to be loaded lazily with only their summary/description in context initially, so that token usage is minimized and only relevant detail is loaded on demand.

#### Acceptance Criteria

1. WHEN a SKILL_MD_Skill is activated for a query, THE Skill_Loader SHALL load only the Skill_Summary (YAML frontmatter description and first heading block) into the LLM context.
2. THE Skill_Loader SHALL NOT load Reference_Files or full SKILL.md body content into context during initial skill activation.
3. THE Skill_Loader SHALL expose a method to retrieve the list of available Reference_Files for a given skill without loading their content.
4. WHILE a skill is active, THE Skill_Loader SHALL maintain a manifest of the skill's available Reference_Files including their file names and relative paths.

### Requirement 3: On-Demand Reference File Loading Tool

**User Story:** As a developer, I want the LLM to have access to a tool that loads specific skill reference files on demand, so that detailed context is only consumed when the LLM determines it is needed.

#### Acceptance Criteria

1. THE Tool_Registry SHALL provide a `load_skill_reference` tool with input parameters `skillId` (string, required) and `fileName` (string, required).
2. WHEN the `load_skill_reference` tool is invoked with a valid `skillId` and `fileName`, THE Tool_Registry SHALL return the full text content of the matching Reference_File.
3. IF the `load_skill_reference` tool is invoked with a `skillId` that does not correspond to an active skill, THEN THE Tool_Registry SHALL return an error message stating the skill is not active.
4. IF the `load_skill_reference` tool is invoked with a `fileName` that does not exist in the skill directory, THEN THE Tool_Registry SHALL return an error message listing the available reference files for that skill.
5. THE Tool_Registry SHALL provide a `list_skill_references` tool that accepts a `skillId` parameter and returns the list of available Reference_File names and descriptions for that skill.
6. WHEN the `load_skill_reference` tool is invoked, THE Tool_Registry SHALL resolve the file path relative to the skill's directory, preventing path traversal outside the skill folder.

### Requirement 4: Plan-First Execution with Persistent Plan Files

**User Story:** As a developer, I want the Agent_Loop to create structured execution plans as physical `.md` files on disk that the LLM manages via dedicated tools, so that plans are persistent artifacts users can inspect and execution mirrors Kiro's task-file model.

#### Acceptance Criteria

1. THE Tool_Registry SHALL provide a `create_plan` tool that accepts parameters `title` (string, required), `tasks` (array of objects with `id`, `description`, and optional `critical` flag, required), and writes a structured Plan_File to the `plans/` directory.
2. WHEN the `create_plan` tool is invoked, THE Tool_Registry SHALL write a `.md` file to disk containing the plan title, a task list formatted as markdown checkboxes, and status metadata (pending, in_progress, complete, failed) for each task.
3. THE Tool_Registry SHALL provide an `update_plan_task` tool that accepts parameters `planId` (string, required), `taskId` (string, required), `status` (enum: "in_progress", "complete", "failed", required), and optional `result` (string) to update the corresponding task in the Plan_File.
4. WHEN the `update_plan_task` tool is invoked, THE Tool_Registry SHALL modify the Plan_File on disk, updating the task's checkbox state and status metadata in place.
5. THE Tool_Registry SHALL provide a `read_plan` tool that accepts a `planId` (string, required) parameter and returns the current Plan_File content including all task statuses and results.
6. WHEN a query is classified as complex (requiring multiple tool calls or skill phases), THE Agent_Loop SHALL instruct the LLM to invoke `create_plan` before executing any tool calls.
7. THE Agent_Loop SHALL enforce a maximum of 15 tasks per plan to prevent runaway costs.
8. IF a plan task fails, THEN THE Agent_Loop SHALL allow the LLM to mark the task as failed via `update_plan_task` and continue to the next task unless the task is marked as critical.
9. WHEN all plan tasks are marked complete or failed, THE Agent_Loop SHALL pass accumulated results to the synthesis phase for final response generation.
10. THE Plan_File SHALL use a naming convention of `plans/{planId}.md` where `planId` is a timestamp-based identifier generated at creation time.
11. WHEN a new user query arrives in an active session, THE Agent_Loop SHALL inform the LLM of any existing Plan_Files for that session by providing plan IDs and titles, so the LLM can decide whether to read, resume, or skip existing plans.
12. THE Agent_Loop SHALL NOT load Plan_File contents into context automatically — the LLM SHALL use the `read_plan` tool on demand to retrieve plan details only when the LLM determines the plan is relevant to the current query.

### Requirement 5: Sub-Agent Delegation

**User Story:** As a developer, I want the main agent to delegate long-running or complex sub-tasks to cheaper sub-agent instances, so that expensive Sonnet context is preserved for synthesis while Haiku handles bulk work.

#### Acceptance Criteria

1. THE Agent_Loop SHALL provide a `delegate_to_subagent` tool that accepts parameters `taskDescription` (string, required), `context` (string, optional), and `maxTurns` (integer, optional, default 5).
2. WHEN `delegate_to_subagent` is invoked, THE Agent_Loop SHALL create an isolated execution context using the Haiku model with the provided task description and context.
3. THE Sub_Agent SHALL have access to the same tool set (Jira, Confluence, Kapa, WebSearch, DocsSearch) as the main agent.
4. THE Sub_Agent SHALL enforce a maximum turn limit (configurable via `maxTurns`, capped at 10) to prevent runaway execution.
5. WHEN the Sub_Agent completes execution, THE Agent_Loop SHALL return the Sub_Agent's final text output as the tool result to the main agent.
6. IF the Sub_Agent exceeds the maximum turn limit, THEN THE Agent_Loop SHALL terminate the Sub_Agent and return a partial result with a warning that the task was not fully completed.
7. THE Sub_Agent SHALL route all LLM calls through Bedrock using the Haiku model.

### Requirement 6: Skill-Aware Preflight Classification

**User Story:** As a developer, I want the preflight classifier to use the Skill_Registry trigger keywords for accurate skill routing, so that SKILL_MD_Skills are correctly activated based on user queries.

#### Acceptance Criteria

1. WHEN classifying a user query, THE Agent_Loop SHALL match against trigger keywords defined in the Skill_Registry for all registered skills.
2. THE Agent_Loop SHALL return matching skill IDs in the preflight classification result when query terms overlap with Skill_Registry trigger keywords.
3. WHEN multiple skills match a query, THE Agent_Loop SHALL include all matching skill IDs in the classification result (the LLM synthesis phase selects the primary skill).
4. THE Agent_Loop SHALL load the Skill_Registry at startup and cache it in memory to avoid repeated file reads during classification.

### Requirement 7: About Page Update

**User Story:** As a TAM, I want the About_Page to reflect the full range of capabilities including BRD writing, Solution Design Documents, CR evaluation, Gap Analysis, and Excalidraw diagrams, so that users understand what the agent can do.

#### Acceptance Criteria

1. THE About_Page SHALL list the following capabilities: BRD Creation and Evaluation, Solution Design Document (SDD) Generation, Change Request (CR) Feasibility Evaluation, Solution Gap Analysis, and Excalidraw Diagram Generation.
2. THE About_Page SHALL retain all existing capabilities (Research and Knowledge Retrieval, Jira Integration, Confluence Integration, Conversation History).
3. THE About_Page SHALL group capabilities into categories: "Core Tools" (Jira, Confluence, Docs) and "Specialist Skills" (BRD, SDD, CR Evaluation, Gap Analysis, Diagrams).
4. THE About_Page SHALL maintain valid HTML structure, accessibility attributes (ARIA labels, semantic headings), and the existing CSS framework.

### Requirement 8: Context Compaction with Chat History Preservation

**User Story:** As a developer, I want the Agent_Loop to compact conversation history using the Haiku model when context size approaches the maximum token limit, so that long-running sessions remain functional without losing access to original conversation details.

#### Acceptance Criteria

1. WHEN the current session context size reaches the Compaction_Threshold percentage of the maximum token limit, THE Agent_Loop SHALL trigger Context_Compaction using the Haiku model to summarize older conversation turns.
2. THE Agent_Loop SHALL read the Compaction_Threshold from the `CONTEXT_COMPACTION_THRESHOLD` environment variable, defaulting to 75 when the variable is not set.
3. WHEN Context_Compaction is triggered, THE Agent_Loop SHALL preserve the most recent conversation turns verbatim (configurable via `CONTEXT_COMPACTION_PRESERVE_TURNS` environment variable, default 5) and summarize all older turns into a condensed summary.
4. WHEN Context_Compaction completes, THE Agent_Loop SHALL store the Compacted_History for the session and use it as the conversation context for all subsequent LLM calls in that session.
5. THE Agent_Loop SHALL NOT modify or overwrite the original uncompacted chat history stored on disk — the original messages SHALL remain intact in their storage location.
6. WHEN Context_Compaction has occurred in a session, THE Agent_Loop SHALL include a system notification in the LLM context indicating that compaction has been performed and that some earlier detail may have been summarized.
7. THE Tool_Registry SHALL provide a `lookup_chat_history` tool that accepts parameters `sessionId` (string, required), `startTurn` (integer, optional), `endTurn` (integer, optional), and `searchTerm` (string, optional) to retrieve original uncompacted messages from the session.
8. WHEN the `lookup_chat_history` tool is invoked with a `searchTerm`, THE Tool_Registry SHALL return all original messages containing that term along with their turn numbers and timestamps.
9. WHEN the `lookup_chat_history` tool is invoked with `startTurn` and `endTurn` parameters, THE Tool_Registry SHALL return the original uncompacted messages within the specified turn range (inclusive).
10. IF the `lookup_chat_history` tool is invoked with a `sessionId` that does not exist, THEN THE Tool_Registry SHALL return an error message stating the session was not found.
11. THE Tool_Registry SHALL provide a `get_session_summary` tool that accepts a `sessionId` (string, required) parameter and returns session metadata including total turn count, number of compaction events, timestamps of compaction events, and current context utilization percentage.
12. WHEN Context_Compaction is performed, THE Haiku model SHALL produce a summary that preserves key facts, user decisions, tool call results, and contextual references from the compacted turns.
13. THE Agent_Loop SHALL log each compaction event with the session ID, turn range compacted, token count before compaction, and token count after compaction.

### Requirement 9: Migrate from MongoDB to AWS DocumentDB

**User Story:** As a developer, I want the database layer to connect to AWS DocumentDB instead of MongoDB Atlas, so that the application uses the team's AWS VPC infrastructure for production persistence with proper TLS security.

#### Acceptance Criteria

1. WHEN the `STORE_BACKEND` environment variable is set to `"documentdb"`, THE `src/db.js` module SHALL connect to DocumentDB using the standard `mongodb://` protocol with TLS enabled and the AWS RDS CA certificate specified via the `DOCDB_TLS_CA_FILE` environment variable.
2. WHEN the `STORE_BACKEND` environment variable is set to `"mongodb"`, THE `src/db.js` module SHALL treat it as a deprecated alias for `"documentdb"` and connect using the DocumentDB configuration, logging a deprecation warning to the console.
3. THE `src/db.js` module SHALL build the DocumentDB connection URI from the following environment variables: `DOCDB_URI` (full connection string, takes priority), or `DOCDB_CLUSTER_ENDPOINT`, `DOCDB_USERNAME`, and `DOCDB_PASSWORD` (composed automatically).
4. WHEN `DOCDB_URI` is not set and `DOCDB_CLUSTER_ENDPOINT`, `DOCDB_USERNAME`, and `DOCDB_PASSWORD` are provided, THE `src/db.js` module SHALL compose the connection string as `mongodb://{DOCDB_USERNAME}:{DOCDB_PASSWORD}@{DOCDB_CLUSTER_ENDPOINT}:27017/?tls=true&tlsCAFile={DOCDB_TLS_CA_FILE}&retryWrites=false&directConnection=true`.
5. THE `src/db.js` module SHALL set `retryWrites` to `false` in the DocumentDB connection options, as DocumentDB does not support retryable writes.
6. WHEN the `DOCDB_TLS_CA_FILE` environment variable is set, THE `src/db.js` module SHALL read the specified CA certificate file path and pass it to the MongoClient TLS options for server certificate validation.
7. WHEN the `DOCDB_TLS_CA_FILE` environment variable is not set and the `DOCDB_TLS_ENABLED` variable is not explicitly set to `"false"`, THE `src/db.js` module SHALL default to looking for the CA certificate at the path `./global-bundle.pem` relative to the project root.
8. WHEN the `DOCDB_TLS_ENABLED` environment variable is set to `"false"`, THE `src/db.js` module SHALL connect without TLS to support local development environments.
9. THE `src/stores/mongo/index.js` store adapter SHALL continue to use `findOne`, `updateOne`, `deleteOne`, and `find` operations without modification, as these operations are compatible with DocumentDB.
10. THE `.env.example` file SHALL replace the MongoDB Atlas configuration section with a DocumentDB configuration section containing `DOCDB_URI`, `DOCDB_CLUSTER_ENDPOINT`, `DOCDB_USERNAME`, `DOCDB_PASSWORD`, `DOCDB_TLS_CA_FILE`, `DOCDB_TLS_ENABLED`, and `MONGODB_DB_NAME` variables with descriptive comments.
11. THE `.env.example` file SHALL retain the `STORE_BACKEND` variable and update its comment to indicate valid values are `"json"` (flat files, default) or `"documentdb"` (with `"mongodb"` as a deprecated alias).
12. IF the CA certificate file specified by `DOCDB_TLS_CA_FILE` does not exist at the resolved path, THEN THE `src/db.js` module SHALL throw a descriptive error stating the CA certificate file was not found and including the attempted file path.
13. WHEN the database connection is established successfully, THE `src/db.js` module SHALL log the connection status including the database name and whether TLS is enabled.
14. IF neither `DOCDB_URI` nor the combination of `DOCDB_CLUSTER_ENDPOINT`, `DOCDB_USERNAME`, and `DOCDB_PASSWORD` is provided when `STORE_BACKEND` is `"documentdb"`, THEN THE `src/db.js` module SHALL throw a configuration error listing the required environment variables.

### Requirement 10: Infrastructure Cost Control (Start/Stop Toggle)

**User Story:** As a developer, I want a mechanism to start and stop the App Runner service and DocumentDB cluster on demand, so that I can eliminate compute and database costs when the application is not actively in use.

#### Acceptance Criteria

1. THE Infra_Toggle SHALL provide a CLI command (`scripts/infra-toggle.js`) that accepts a `start` or `stop` argument to control the App Runner service and DocumentDB cluster.
2. THE Infra_Toggle SHALL expose an admin API endpoint (`POST /api/admin/infra-toggle`) that accepts a JSON body with an `action` field set to `"start"` or `"stop"` to control the App Runner service and DocumentDB cluster.
3. WHEN the `stop` action is invoked, THE Infra_Toggle SHALL pause the App Runner service first, wait for the service status to confirm paused state, and then stop the DocumentDB cluster.
4. WHEN the `start` action is invoked, THE Infra_Toggle SHALL start the DocumentDB cluster first, wait for the cluster status to reach `"available"`, and then resume the App Runner service.
5. THE Infra_Toggle SHALL use the AWS SDK v3 (`@aws-sdk/client-apprunner` and `@aws-sdk/client-docdb`) to interact with the App Runner and DocumentDB APIs.
6. THE Infra_Toggle SHALL read the App Runner service ARN from the `APPRUNNER_SERVICE_ARN` environment variable and the DocumentDB cluster identifier from the `DOCDB_CLUSTER_IDENTIFIER` environment variable.
7. IF the `APPRUNNER_SERVICE_ARN` or `DOCDB_CLUSTER_IDENTIFIER` environment variable is not set when the Infra_Toggle is invoked, THEN THE Infra_Toggle SHALL exit with a descriptive error listing the missing variable names.
8. THE Infra_Toggle SHALL resolve AWS credentials from the environment (environment variables or IAM role) using the default AWS SDK credential provider chain.
9. WHEN each infrastructure operation (pause, resume, stop, start) completes or fails, THE Infra_Toggle SHALL log the operation name, target resource identifier, resulting status, and timestamp.
10. WHEN the `start` action completes successfully, THE Infra_Toggle SHALL perform a health check by polling the App Runner service URL until a successful HTTP response is received or a timeout of 120 seconds is reached.
11. IF the health check after startup does not receive a successful response within 120 seconds, THEN THE Infra_Toggle SHALL log a warning indicating the service may not be fully operational and exit with a non-zero status code.
12. IF an AWS API call fails during a start or stop operation, THEN THE Infra_Toggle SHALL log the error details including the AWS error code and message, and exit with a non-zero status code without proceeding to subsequent operations.
13. THE `.env.example` file SHALL include `APPRUNNER_SERVICE_ARN` and `DOCDB_CLUSTER_IDENTIFIER` variables with descriptive comments indicating their purpose for the Infra_Toggle.

### Requirement 11: Observability with LangFuse, CloudWatch, and Per-Client Metrics

**User Story:** As a developer, I want full observability into every agent request — including LLM call tracing, token usage, latency metrics, and per-client cost attribution — so that I can monitor system performance, debug slow queries, and report usage costs per customer.

#### Acceptance Criteria

1. THE Tracing_Module SHALL initialize the LangFuse SDK (`langfuse` npm package) using the `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` environment variables.
2. IF any of `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, or `LANGFUSE_BASE_URL` environment variables are not set, THEN THE Tracing_Module SHALL operate in a no-op mode where all tracing calls succeed without errors but emit no data to LangFuse.
3. WHEN a new user query is received by the Agent_Loop, THE Tracing_Module SHALL create a LangFuse Trace with the request ID, user ID, session ID, Client_Tag, and query text as metadata.
4. WHEN the Agent_Loop enters a distinct phase (preflight classification, skill loading, research, synthesis), THE Tracing_Module SHALL create a LangFuse span on the active Trace with the phase name, input data, and start timestamp.
5. WHEN a phase span completes, THE Tracing_Module SHALL end the span with the output data and duration.
6. WHEN `src/llm.js` completes a Bedrock LLM call, THE Tracing_Module SHALL record a LangFuse Generation on the active Trace capturing: model name, input messages, output response, `input_tokens`, `output_tokens`, latency in milliseconds, and the Client_Tag.
7. THE Tracing_Module SHALL forward the `input_tokens` and `output_tokens` values already extracted by `src/llm.js` from the Bedrock response to the LangFuse `generation.end()` call in the `usage` field.
8. WHEN a Client_Tag is associated with a Trace, THE Tracing_Module SHALL include the Client_Tag as metadata on the Trace and on each Generation, enabling per-client filtering and cost attribution in the LangFuse dashboard.
9. WHEN the user query involves a Jira context (Jira ticket key or project key is present in the query or resolved during preflight), THE Agent_Loop SHALL extract the Jira project key as the Client_Tag.
10. WHEN the user query does not involve Jira context and no Client_Tag has been previously set in the session, THE Agent_Loop SHALL prompt the user with the message "Which client is this query for?" and use the response as the Client_Tag for the current session.
11. WHEN the user does not provide a Client_Tag after being prompted (empty response or explicit skip), THE Agent_Loop SHALL assign the value `"untagged"` as the Client_Tag.
12. WHILE a Client_Tag is set for a session, THE Agent_Loop SHALL reuse the same Client_Tag for all subsequent queries in that session without re-prompting.
13. THE Tracing_Module SHALL configure LangFuse Model_Pricing by setting model costs for Haiku and Sonnet using values read from `HAIKU_INPUT_COST_PER_1K`, `HAIKU_OUTPUT_COST_PER_1K`, `SONNET_INPUT_COST_PER_1K`, and `SONNET_OUTPUT_COST_PER_1K` environment variables (values in USD per 1000 tokens).
14. IF Model_Pricing environment variables are not set, THEN THE Tracing_Module SHALL use default values of `0.00025` input and `0.00125` output per 1000 tokens for Haiku, and `0.003` input and `0.015` output per 1000 tokens for Sonnet.
15. THE Agent_Loop SHALL emit structured JSON log lines to stdout for every LLM call containing the fields: `timestamp`, `level`, `event` ("llm_call"), `model`, `input_tokens`, `output_tokens`, `latency_ms`, `client_tag`, `session_id`, and `request_id`.
16. THE Agent_Loop SHALL emit structured JSON log lines to stdout for every completed request containing the fields: `timestamp`, `level`, `event` ("request_complete"), `total_latency_ms`, `total_input_tokens`, `total_output_tokens`, `llm_call_count`, `client_tag`, `session_id`, and `request_id`.
17. THE Agent_Loop SHALL use a structured JSON logging format for all log output, using `console.log` with JSON-serialized objects to ensure compatibility with CloudWatch Logs JSON parsing.
18. WHEN deployed to App_Runner, THE structured JSON logs SHALL be ingested by CloudWatch Logs automatically via stdout capture, requiring no additional logging agent configuration.
19. THE `.env.example` file SHALL include a LangFuse configuration section with `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `HAIKU_INPUT_COST_PER_1K`, `HAIKU_OUTPUT_COST_PER_1K`, `SONNET_INPUT_COST_PER_1K`, and `SONNET_OUTPUT_COST_PER_1K` variables with descriptive comments.
20. THE Tracing_Module SHALL export helper functions `createTrace(metadata)`, `startSpan(trace, name, input)`, `endSpan(span, output)`, `startGeneration(trace, params)`, and `endGeneration(generation, output, usage)` that the Agent_Loop and `src/llm.js` invoke at the appropriate lifecycle points.
21. THE Tracing_Module SHALL call `langfuse.flush()` before the process exits or after each request completes, to ensure all tracing data is sent to LangFuse without data loss.
22. WHEN CloudWatch Logs contain the structured JSON log lines, a CloudWatch Metric Filter SHALL be configurable to extract `latency_ms` values and publish them as a custom metric enabling p95 and p99 latency percentile alarms.
23. WHEN CloudWatch Logs contain the structured JSON log lines, a CloudWatch Metric Filter SHALL be configurable to extract `total_input_tokens` and `total_output_tokens` values per `client_tag` for per-client usage dashboards.
