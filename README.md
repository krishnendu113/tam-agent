# TAM Agent

A Technical Account Manager AI agent powered by AWS Bedrock and a custom async state machine. The agent researches across Jira, Confluence, documentation, and the web to answer technical support questions with real-time streaming responses.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Express Server (SSE)                   │
├─────────────────────────────────────────────────────────┤
│                     Agent Loop                           │
│  ┌──────────┐  ┌───────────┐  ┌────────┐  ┌─────────┐ │
│  │ Preflight│→ │Skill Load │→ │ Router │→ │Research │ │
│  │   Gate   │  │  + Route  │  │        │  │Dispatch │ │
│  └──────────┘  └───────────┘  └────────┘  └─────────┘ │
│                                                 ↓        │
│                                          ┌───────────┐  │
│                                          │ Synthesis  │  │
│                                          │   Loop     │  │
│                                          └───────────┘  │
├─────────────────────────────────────────────────────────┤
│              LLM Abstraction Layer (src/llm.js)          │
├─────────────────────────────────────────────────────────┤
│              AWS Bedrock Runtime (Claude)                 │
└─────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- No LangGraph/LangChain — custom state machine is simpler to debug and deploy
- Provider-agnostic LLM interface — swap Bedrock for any provider by changing `src/llm.js`
- Streaming-first — SSE delivers real-time tokens, tool status, and phase transitions to the client

## Quick Start

### Prerequisites

- Node.js 20+
- AWS account with Bedrock access (Claude Sonnet + Haiku models enabled)
- MongoDB (optional, for persistence)

### Setup

```bash
git clone https://github.com/krishnendu113/tam-agent.git
cd tam-agent
npm install
cp .env.example .env
# Edit .env with your AWS region and model IDs
```

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AWS_REGION` | AWS region for Bedrock | `us-east-1` |
| `BEDROCK_SONNET_MODEL_ID` | Bedrock model ID for Sonnet | `anthropic.claude-sonnet-4-20250514-v1:0` |
| `BEDROCK_HAIKU_MODEL_ID` | Bedrock model ID for Haiku | `anthropic.claude-haiku-4-5-20251001-v1:0` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/tam-agent` |
| `PORT` | Server port | `3000` |

### Run

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### Test

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage report
```

## API

### POST /api/chat

Streams an SSE response for a chat message.

**Request body:**
```json
{
  "conversationId": "conv-123",
  "messages": [{"role": "user", "content": "How do I reset my Jira password?"}],
  "systemPrompt": "You are a helpful TAM agent.",
  "problemText": "How do I reset my Jira password?"
}
```

**SSE events:**
| Event | Data | Description |
|-------|------|-------------|
| `phase` | `{ phase }` | Phase transition (preflight, research, synthesis) |
| `token` | `{ text }` | Streamed text token |
| `tool_status` | `{ name, status }` | Tool execution status |
| `skill_active` | `{ skillId }` | Skill activated |
| `status` | `{ status }` | Status message |
| `complete` | `{ text }` | Final response text |
| `error` | `{ error }` | Error message |

### GET /health

Returns `{ "status": "ok" }`.

## Project Structure

```
src/
├── llm.js                 # LLM Abstraction Layer (Bedrock)
├── agentLoop.js           # Custom state machine orchestrator
├── callbacks.js           # Callback interface validation
├── server.js              # Express server with SSE
├── preflight.js           # Query classification (standalone)
├── clientPersona.js       # Client persona detection
├── researchAgents.js      # Research agents with query reformulation
├── compaction.js          # Context window compaction
├── skillLoader.js         # Skill definition loader
├── stores/                # Persistence adapters (MongoDB/JSON)
├── tools/                 # Tool implementations (Jira, Confluence, etc.)
├── auth.js                # Authentication
└── __tests__/             # Unit, property, and integration tests
    ├── *.test.js          # Unit tests
    ├── *.property.test.js # Property-based tests (fast-check)
    └── integration/       # End-to-end integration tests
```

## Agent Flow

1. **Preflight Gate** — Haiku classifies the query (on-topic/off-topic, intent, required tools)
2. **Skill Loading** — Loads relevant skill definitions based on classification
3. **Routing** — Routes to multi-node (skill-driven) or research path
4. **Research Dispatch** — Parallel sub-agents search Jira, Confluence, Docs, Web via `Promise.allSettled`
5. **Synthesis Loop** — Sonnet streams the final response with tool-use capability
6. **Context Compaction** — Summarizes older messages when context window is exceeded

## Testing

The project uses property-based testing (fast-check) alongside traditional unit tests:

- **288 tests** across 23 test files
- **18 property-based tests** verifying universal correctness properties
- **6 integration tests** covering end-to-end flows and SSE streaming
- Properties cover response normalization, stream assembly, error handling, routing correctness, and more

## Deployment

### AWS ECS Fargate (Recommended)

The agent uses the default AWS credential chain, so on ECS Fargate it automatically picks up the task IAM role — no API keys needed.

See the [Deployment Guide](#deployment-guide) section below for step-by-step instructions.

---

## Deployment Guide

### Option 1: ECS Fargate (Production)

#### 1. Create ECR Repository

```bash
aws ecr create-repository --repository-name tam-agent --region us-east-1
```

#### 2. Create Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY public/ ./public/
COPY skills/ ./skills/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

#### 3. Build and Push

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

docker build -t tam-agent .
docker tag tam-agent:latest <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/tam-agent:latest
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/tam-agent:latest
```

#### 4. Create IAM Task Role

Create a role with this policy (allows Bedrock model invocation):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*"
      ]
    }
  ]
}
```

#### 5. Create ECS Task Definition

```json
{
  "family": "tam-agent",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/tam-agent-task-role",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "tam-agent",
      "image": "<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/tam-agent:latest",
      "portMappings": [{ "containerPort": 3000 }],
      "environment": [
        { "name": "AWS_REGION", "value": "us-east-1" },
        { "name": "BEDROCK_SONNET_MODEL_ID", "value": "anthropic.claude-sonnet-4-20250514-v1:0" },
        { "name": "BEDROCK_HAIKU_MODEL_ID", "value": "anthropic.claude-haiku-4-5-20251001-v1:0" },
        { "name": "PORT", "value": "3000" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/tam-agent",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

#### 6. Create ECS Service

```bash
# Create cluster
aws ecs create-cluster --cluster-name tam-agent-cluster

# Create service with ALB
aws ecs create-service \
  --cluster tam-agent-cluster \
  --service-name tam-agent-service \
  --task-definition tam-agent \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

### Option 2: Local Testing with AWS Credentials

```bash
# Configure AWS credentials locally
aws configure
# Or export them directly:
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_REGION=us-east-1

# Set model IDs
export BEDROCK_SONNET_MODEL_ID=anthropic.claude-sonnet-4-20250514-v1:0
export BEDROCK_HAIKU_MODEL_ID=anthropic.claude-haiku-4-5-20251001-v1:0

# Start the server
npm start
```

### Testing the Deployment

```bash
# Health check
curl http://localhost:3000/health

# Chat request (SSE stream)
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "test-1",
    "messages": [{"role": "user", "content": "How do I check my Jira ticket status?"}],
    "systemPrompt": "You are a helpful TAM agent.",
    "problemText": "How do I check my Jira ticket status?"
  }'
```

You should see SSE events streaming back:
```
event: phase
data: {"phase":"preflight"}

event: phase
data: {"phase":"research"}

event: token
data: {"text":"To check your Jira ticket status..."}

event: complete
data: {"text":"To check your Jira ticket status, navigate to..."}
```

### Enabling Bedrock Models

Before deploying, ensure the Claude models are enabled in your AWS account:

1. Go to **AWS Console → Amazon Bedrock → Model access**
2. Request access to:
   - `anthropic.claude-sonnet-4-20250514-v1:0` (or your preferred Sonnet version)
   - `anthropic.claude-haiku-4-5-20251001-v1:0` (or your preferred Haiku version)
3. Wait for access to be granted (usually instant for on-demand)

## License

UNLICENSED — Private repository.
