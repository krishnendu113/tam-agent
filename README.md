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
│              AWS Bedrock (Cross-Region Inference)         │
└─────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- No LangGraph/LangChain — custom state machine is simpler to debug and deploy
- Provider-agnostic LLM interface — swap Bedrock for any provider by changing `src/llm.js`
- Streaming-first — SSE delivers real-time tokens, tool status, and phase transitions to the client
- Deployed in **Mumbai (ap-south-1)** using Bedrock Cross-Region Inference for Claude model access

## Quick Start

### Prerequisites

- Node.js 20+
- AWS account with Bedrock access in ap-south-1 (Mumbai)
- Claude Sonnet + Haiku models enabled via Cross-Region Inference
- MongoDB (optional, for persistence)

### Setup

```bash
git clone https://github.com/krishnendu113/tam-agent.git
cd tam-agent
npm install
cp .env.example .env
# Edit .env with your configuration
```

### Environment Variables

| Variable | Description | Value for Mumbai |
|----------|-------------|-----------------|
| `AWS_REGION` | AWS region | `ap-south-1` |
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

- **288 tests** across 23 test files
- **18 property-based tests** verifying universal correctness properties (fast-check)
- **6 integration tests** covering end-to-end flows and SSE streaming

---

## Deployment Guide — Mumbai (ap-south-1)

### Important: Bedrock in Mumbai

Claude models are available in Mumbai via **Cross-Region Inference**. This means your application runs in `ap-south-1` but Bedrock routes inference requests to the nearest region with capacity (typically `us-east-1` or `ap-southeast-1`). From your code's perspective, you still call the Bedrock API in `ap-south-1` — the routing is transparent.

### Step 1: Enable Bedrock Model Access

1. Go to **AWS Console → Amazon Bedrock** (region: `ap-south-1`)
2. Navigate to **Model access → Manage model access**
3. Enable **Cross-Region Inference** for:
   - Anthropic Claude Sonnet 4
   - Anthropic Claude Haiku 4.5
4. Accept the EULA and wait for access to be granted

### Step 2: Create ECR Repository

```bash
aws ecr create-repository --repository-name tam-agent --region ap-south-1
```

### Step 3: Build and Push Docker Image

```bash
# Login to ECR
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com

# Build and push
docker build -t tam-agent .
docker tag tam-agent:latest <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/tam-agent:latest
docker push <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/tam-agent:latest
```

### Step 4: Create IAM Task Role

Create `tam-agent-task-role` with this policy:

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
        "arn:aws:bedrock:ap-south-1::foundation-model/anthropic.claude-*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
      ]
    }
  ]
}
```

The wildcard region in the second resource ARN allows cross-region inference routing.

### Step 5: Create ECS Task Definition

Save as `task-definition.json`:

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
      "image": "<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/tam-agent:latest",
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "AWS_REGION", "value": "ap-south-1" },
        { "name": "BEDROCK_SONNET_MODEL_ID", "value": "anthropic.claude-sonnet-4-20250514-v1:0" },
        { "name": "BEDROCK_HAIKU_MODEL_ID", "value": "anthropic.claude-haiku-4-5-20251001-v1:0" },
        { "name": "PORT", "value": "3000" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/tam-agent",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

Register it:
```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json --region ap-south-1
```

### Step 6: Create ECS Cluster and Service

```bash
# Create cluster
aws ecs create-cluster --cluster-name tam-agent-cluster --region ap-south-1

# Create CloudWatch log group
aws logs create-log-group --log-group-name /ecs/tam-agent --region ap-south-1

# Create service (replace subnet and security group IDs)
aws ecs create-service \
  --cluster tam-agent-cluster \
  --service-name tam-agent-service \
  --task-definition tam-agent \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --region ap-south-1
```

### Step 7: Test the Deployment

```bash
# Get the task's public IP from ECS console or:
TASK_ARN=$(aws ecs list-tasks --cluster tam-agent-cluster --region ap-south-1 --query 'taskArns[0]' --output text)
ENI_ID=$(aws ecs describe-tasks --cluster tam-agent-cluster --tasks $TASK_ARN --region ap-south-1 --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text)
PUBLIC_IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID --region ap-south-1 --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

# Health check
curl http://$PUBLIC_IP:3000/health

# Chat request (SSE stream)
curl -N -X POST http://$PUBLIC_IP:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "test-1",
    "messages": [{"role": "user", "content": "How do I check my Jira ticket status?"}],
    "systemPrompt": "You are a helpful TAM agent.",
    "problemText": "How do I check my Jira ticket status?"
  }'
```

### Local Testing with Mumbai Region

```bash
aws configure
# Set region to ap-south-1

export AWS_REGION=ap-south-1
export BEDROCK_SONNET_MODEL_ID=anthropic.claude-sonnet-4-20250514-v1:0
export BEDROCK_HAIKU_MODEL_ID=anthropic.claude-haiku-4-5-20251001-v1:0

npm start
```

---

## Monthly Cost Estimate (Mumbai — ap-south-1)

### Assumptions

| Parameter | Value |
|-----------|-------|
| Queries per day | 100 |
| Queries per month | ~3,000 |
| Avg input tokens per query (preflight + research + synthesis) | ~4,000 |
| Avg output tokens per query | ~2,000 |
| Haiku calls per query (preflight + research sub-agents) | 5 |
| Sonnet calls per query (synthesis) | 1–2 |
| ECS Fargate task size | 0.5 vCPU / 1 GB RAM |
| Running 24/7 | Yes (1 task) |

### Cost Breakdown

#### 1. AWS Bedrock — LLM Inference (largest cost)

| Model | Role | Input Price | Output Price |
|-------|------|-------------|--------------|
| Claude Haiku 4.5 | Preflight, Research | $1.00 / 1M tokens | $5.00 / 1M tokens |
| Claude Sonnet 4 | Synthesis | $3.00 / 1M tokens | $15.00 / 1M tokens |

**Per query token usage:**
- Haiku (5 calls): ~3,000 input tokens + ~1,500 output tokens
- Sonnet (1.5 calls avg): ~4,000 input tokens + ~1,500 output tokens

**Monthly Bedrock cost (3,000 queries):**

| Component | Calculation | Cost |
|-----------|-------------|------|
| Haiku input | 3,000 queries × 3,000 tokens × $1.00/1M | $9.00 |
| Haiku output | 3,000 queries × 1,500 tokens × $5.00/1M | $22.50 |
| Sonnet input | 3,000 queries × 4,000 tokens × $3.00/1M | $36.00 |
| Sonnet output | 3,000 queries × 1,500 tokens × $15.00/1M | $67.50 |
| **Bedrock subtotal** | | **$135.00** |

#### 2. ECS Fargate — Compute

| Resource | Mumbai Price | Monthly (730 hrs) |
|----------|-------------|-------------------|
| 0.5 vCPU | ~$0.04656/vCPU/hr | $17.00 |
| 1 GB RAM | ~$0.00511/GB/hr | $3.73 |
| **Fargate subtotal** | | **$20.73** |

#### 3. Supporting Services

| Service | Usage | Monthly Cost |
|---------|-------|--------------|
| ECR (container storage) | ~200 MB image | $0.10 |
| CloudWatch Logs | ~5 GB/month | $3.50 |
| ALB (if using load balancer) | 1 ALB + minimal LCUs | $18.00 |
| NAT Gateway (if private subnet) | Optional | $35.00 |
| MongoDB Atlas (M10 Mumbai) | Optional, for persistence | $57.00 |
| **Supporting subtotal** | | **$22–$114** |

#### Total Monthly Cost Summary

| Scenario | Monthly Cost |
|----------|-------------|
| **Minimal** (public IP, no ALB, no MongoDB, JSON store) | **~$160/month** |
| **Standard** (ALB, CloudWatch, no MongoDB) | **~$178/month** |
| **Full** (ALB, MongoDB Atlas, NAT Gateway) | **~$270/month** |

### Cost Scaling

| Queries/month | Bedrock Cost | Total (minimal) |
|---------------|-------------|-----------------|
| 1,000 | ~$45 | ~$70 |
| 3,000 | ~$135 | ~$160 |
| 10,000 | ~$450 | ~$475 |
| 30,000 | ~$1,350 | ~$1,375 |

### Cost Optimization Tips

1. **Use Haiku for everything possible** — It's 3x cheaper than Sonnet for input and 3x cheaper for output. Consider using Haiku for synthesis on simple queries.
2. **Prompt caching** — Bedrock supports prompt caching for repeated system prompts, saving up to 90% on cached input tokens.
3. **Batch inference** — For non-real-time workloads, batch inference is 50% cheaper.
4. **Context compaction** — Already built in. Keeps token usage bounded for long conversations.
5. **Off-topic rejection** — The preflight gate rejects irrelevant queries before expensive research/synthesis, saving ~$0.04 per rejected query.
6. **Fargate Spot** — Use Fargate Spot for non-critical workloads (up to 70% savings on compute).

---

## License

UNLICENSED — Private repository.
