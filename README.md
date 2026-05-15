# TAM Agent

A Technical Account Manager AI agent powered by AWS Bedrock and a custom async state machine. Built to assist with technical support, troubleshooting, and knowledge retrieval across Jira, Confluence, documentation, and web sources.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Express Server (SSE)                   │
├─────────────────────────────────────────────────────────┤
│                     Agent Loop                           │
│  ┌──────────┐  ┌───────────┐  ┌────────┐  ┌─────────┐ │
│  │ Preflight│→ │Skill Load │→ │ Router │→ │Synthesis│ │
│  │   Gate   │  │  + Route  │  │Research│  │  Loop   │ │
│  └──────────┘  └───────────┘  └────────┘  └─────────┘ │
├─────────────────────────────────────────────────────────┤
│                  LLM Abstraction Layer                    │
│         createMessage() · streamMessage()                │
├─────────────────────────────────────────────────────────┤
│              AWS Bedrock Runtime Client                   │
│         Claude Sonnet · Claude Haiku                     │
└─────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- No framework dependencies — LangGraph replaced with an explicit async state machine (~200 lines vs ~2MB of dependencies)
- Provider-agnostic LLM interface — all Bedrock specifics isolated in `src/llm.js`
- Streaming-first — SSE events delivered in real-time via callback interface
- Property-based testing — correctness properties verified with fast-check

## Quick Start

### Prerequisites

- Node.js >= 20
- AWS credentials configured (IAM role, env vars, or shared credentials file)
- MongoDB (optional, for persistence)

### Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your AWS region and model IDs

# Run tests
npm test

# Start the server
npm start
```

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AWS_REGION` | AWS region for Bedrock | `us-east-1` |
| `BEDROCK_SONNET_MODEL_ID` | Model ID for Sonnet (primary) | `anthropic.claude-sonnet-4-20250514-v1:0` |
| `BEDROCK_HAIKU_MODEL_ID` | Model ID for Haiku (fast/cheap) | `anthropic.claude-haiku-4-5-20251001-v1:0` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/tam-agent` |
| `PORT` | Server port | `3000` |

## Project Structure

```
src/
├── llm.js                 # LLM Abstraction Layer (Bedrock client, streaming)
├── agentLoop.js           # Custom state machine (replaces LangGraph)
├── callbacks.js           # Callback interface for SSE events
├── server.js              # Express server with SSE streaming
├── preflight.js           # Query classification (on-topic/off-topic)
├── clientPersona.js       # Client persona detection
├── researchAgents.js      # Multi-turn research with tool calling
├── compaction.js          # Context window management
├── skillLoader.js         # Skill definition loading
├── planManager.js         # Multi-step plan management
├── documentStore.js       # Generated document storage
├── fileHandler.js         # File upload handling
├── auth.js                # JWT authentication
├── passwordPolicy.js      # Password validation
├── lockout.js             # Account lockout
├── auditLogger.js         # Security audit logging
├── db.js                  # MongoDB connection
├── migration.js           # Database migrations
├── stores/                # Backend-agnostic persistence (JSON/MongoDB)
├── tools/                 # Tool implementations (Jira, Confluence, Kapa, Web)
└── __tests__/             # Unit, property, and integration tests
    ├── *.test.js          # Unit tests
    ├── *.property.test.js # Property-based tests (fast-check)
    └── integration/       # End-to-end integration tests
```

## API

### POST /api/chat

Streams an agent response via Server-Sent Events.

**Request:**
```json
{
  "conversationId": "conv-123",
  "messages": [{"role": "user", "content": "How do I reset my password?"}],
  "systemPrompt": "You are a helpful TAM agent.",
  "problemText": "How do I reset my password?"
}
```

**SSE Events:**
| Event | Data | Description |
|-------|------|-------------|
| `phase` | `{ phase }` | Phase transition (preflight, research, synthesis) |
| `token` | `{ text }` | Streaming text token |
| `tool_status` | `{ name, status }` | Tool execution status |
| `skill_active` | `{ skillId }` | Skill activated |
| `status` | `{ status }` | Status message |
| `complete` | `{ text }` | Final response text |
| `error` | `{ error }` | Error details |

### GET /health

Returns `{ "status": "ok" }`.

## Agent Loop Flow

1. **Preflight Gate** — Haiku classifies the query (on-topic/off-topic, intent, required tools/skills)
2. **Skill Loading** — Loads relevant skill definitions based on classification
3. **Routing** — Routes to multi-node (skill-driven) or research path
4. **Research Dispatch** — Parallel sub-agents query Jira, Confluence, Docs, Web via `Promise.allSettled`
5. **Synthesis Loop** — Sonnet streams the final response with tool-use capability (up to 10 iterations)

Off-topic queries are rejected at step 1 with a polite refusal — no expensive operations run.

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

**Test breakdown:**
- 288 tests across 23 test files
- 18 property-based tests (100+ iterations each) via fast-check
- 6 integration tests covering end-to-end flows and SSE streaming
- Properties validate: response normalization, stream assembly, error handling, execution order, fault tolerance, termination guarantees

## LLM Abstraction

The `src/llm.js` module decouples all application code from Bedrock specifics:

```javascript
import { createMessage, streamMessage } from './llm.js';

// Non-streaming call
const response = await createMessage({
  model: 'sonnet',        // or 'haiku', or a full model ID
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [...],           // optional, Anthropic Messages API format
  maxTokens: 4096,
});

// Streaming call (async generator)
for await (const event of streamMessage({ model: 'sonnet', ... })) {
  if (event.type === 'text') console.log(event.text);
  if (event.type === 'message_complete') console.log(event.response);
}
```

## License

UNLICENSED — Private repository.
