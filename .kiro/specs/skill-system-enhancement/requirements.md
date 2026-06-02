# Requirements Document

## Introduction

This document specifies requirements for enhancing the TAM Agent's skill system to support a new SKILL.md-based skill pattern, lazy/efficient skill loading, on-demand reference file retrieval, plan-first execution, sub-agent delegation, and an updated about page reflecting the expanded capabilities. The current system only supports the legacy `skill.json` + `prompt.md` pattern and loads all skill content eagerly into context, which wastes tokens and limits scalability.

## Glossary

- **Skill_Loader**: The module (`src/skillLoader.js`) responsible for discovering, parsing, and loading skill definitions from the `skills/` directory.
- **Legacy_Skill**: A skill following the original pattern with a `skill.json` metadata file and a `prompt.md` prompt file (e.g., `skills/troubleshooting/`).
- **SKILL_MD_Skill**: A skill following the new pattern with a `SKILL.md` file containing YAML frontmatter metadata and structured markdown content (e.g., `skills/brd/`, `skills/cr-evaluator/`).
- **Skill_Registry**: The `skills/registry.json` file listing all available skills with their IDs, folder paths, descriptions, and trigger keywords.
- **Reference_File**: A supplementary file within a skill directory (e.g., `references/color-palette.md`, `scoring-engine.md`) that provides detailed context needed only during specific execution phases.
- **Skill_Summary**: The YAML frontmatter description and first-level heading content from a SKILL.md file, loaded initially to conserve tokens.
- **Agent_Loop**: The main orchestration module (`src/agentLoop.js`) that coordinates preflight classification, skill loading, research, and synthesis.
- **Plan_Executor**: A new execution component that creates a structured plan before executing complex multi-step queries.
- **Sub_Agent**: A delegated execution unit using a cheaper LLM model (Haiku) to perform long-running or complex sub-tasks independently.
- **Tool_Registry**: The module (`src/tools/index.js`) managing available tools and their execution handlers.
- **Bedrock**: AWS Bedrock, the LLM inference service through which all model calls are routed.
- **Haiku**: The Claude Haiku model used for cheap classification, sub-agent work, and delegated tasks.
- **Sonnet**: The Claude Sonnet model used for synthesis and high-quality final responses.
- **About_Page**: The public-facing HTML page (`public/about.html`) describing TAM Agent capabilities.

## Requirements

### Requirement 1: Dual-Pattern Skill Discovery

**User Story:** As a developer, I want the Skill_Loader to discover and parse skills using both the legacy `skill.json` + `prompt.md` pattern and the new `SKILL.md` pattern, so that existing skills continue working while new SKILL.md-based skills are fully supported.

#### Acceptance Criteria

1. WHEN a skill directory contains a `skill.json` file, THE Skill_Loader SHALL parse the skill using the legacy pattern (reading `skill.json` for metadata and `prompt.md` for prompt content).
2. WHEN a skill directory contains a `SKILL.md` file, THE Skill_Loader SHALL parse the YAML frontmatter to extract `name` and `description` metadata.
3. WHEN a skill directory contains both a `skill.json` file and a `SKILL.md` file, THE Skill_Loader SHALL prefer the `SKILL.md` pattern and ignore the `skill.json` file.
4. IF a `SKILL.md` file contains malformed YAML frontmatter, THEN THE Skill_Loader SHALL log a warning with the skill directory name and skip that skill without crashing.
5. THE Skill_Loader SHALL return a normalized skill object with consistent fields (`id`, `name`, `description`, `path`, `type`) regardless of which pattern was used.
6. WHEN the Skill_Registry file exists, THE Skill_Loader SHALL use it to resolve trigger keywords, `alwaysLoad` flags, and folder mappings for all skills.

### Requirement 2: Lazy Skill Loading with Summary-Only Context

**User Story:** As a developer, I want skills to be loaded lazily with only their summary/description in context initially, so that token usage is minimized and only relevant detail is loaded on demand.

#### Acceptance Criteria

1. WHEN a SKILL_MD_Skill is activated for a query, THE Skill_Loader SHALL load only the Skill_Summary (YAML frontmatter description and first heading block) into the LLM context.
2. THE Skill_Loader SHALL NOT load Reference_Files or full SKILL.md body content into context during initial skill activation.
3. WHEN a Legacy_Skill is activated, THE Skill_Loader SHALL load the full `prompt.md` content into context (preserving backward-compatible behavior).
4. THE Skill_Loader SHALL expose a method to retrieve the list of available Reference_Files for a given skill without loading their content.
5. WHILE a skill is active, THE Skill_Loader SHALL maintain a manifest of the skill's available Reference_Files including their file names and relative paths.

### Requirement 3: On-Demand Reference File Loading Tool

**User Story:** As a developer, I want the LLM to have access to a tool that loads specific skill reference files on demand, so that detailed context is only consumed when the LLM determines it is needed.

#### Acceptance Criteria

1. THE Tool_Registry SHALL provide a `load_skill_reference` tool with input parameters `skillId` (string, required) and `fileName` (string, required).
2. WHEN the `load_skill_reference` tool is invoked with a valid `skillId` and `fileName`, THE Tool_Registry SHALL return the full text content of the matching Reference_File.
3. IF the `load_skill_reference` tool is invoked with a `skillId` that does not correspond to an active skill, THEN THE Tool_Registry SHALL return an error message stating the skill is not active.
4. IF the `load_skill_reference` tool is invoked with a `fileName` that does not exist in the skill directory, THEN THE Tool_Registry SHALL return an error message listing the available reference files for that skill.
5. THE Tool_Registry SHALL provide a `list_skill_references` tool that accepts a `skillId` parameter and returns the list of available Reference_File names and descriptions for that skill.
6. WHEN the `load_skill_reference` tool is invoked, THE Tool_Registry SHALL resolve the file path relative to the skill's directory, preventing path traversal outside the skill folder.

### Requirement 4: Plan-First Execution Loop

**User Story:** As a developer, I want the Agent_Loop to create an explicit plan before executing complex multi-step queries, so that execution is structured, token-efficient, and resistant to context limits.

#### Acceptance Criteria

1. WHEN a query is classified as complex (requiring multiple tool calls or skill phases), THE Agent_Loop SHALL generate a structured plan before executing any tool calls.
2. THE Agent_Loop SHALL represent the plan as a JSON array of steps, each containing a `stepId`, `description`, `toolsNeeded`, and `expectedOutput` field.
3. WHILE executing a plan, THE Agent_Loop SHALL process steps sequentially, tracking completion status for each step.
4. THE Agent_Loop SHALL enforce a maximum iteration limit of 15 steps per plan execution to prevent runaway costs.
5. IF a plan step fails, THEN THE Agent_Loop SHALL log the failure, mark the step as failed, and continue to the next step unless the step is marked as critical.
6. WHEN plan execution completes, THE Agent_Loop SHALL pass accumulated step results to the synthesis phase for final response generation.
7. THE Agent_Loop SHALL use the Haiku model for plan generation and the Sonnet model for final synthesis only.

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
2. THE About_Page SHALL retain all existing capabilities (AI-Powered Troubleshooting, Research and Knowledge Retrieval, Jira Integration, Confluence Integration, Conversation History).
3. THE About_Page SHALL group capabilities into categories: "Core Tools" (Jira, Confluence, Docs) and "Specialist Skills" (BRD, SDD, CR Evaluation, Gap Analysis, Diagrams).
4. THE About_Page SHALL maintain valid HTML structure, accessibility attributes (ARIA labels, semantic headings), and the existing CSS framework.
