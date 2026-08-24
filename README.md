# 🍓 LookaBerry — AI GTM Outbound Engine (API + MCP Server)

> **Autonomous, headless Go-to-Market (GTM) and B2B Outbound infrastructure designed for AI agents. Powered by PostgreSQL 16 + pgvector (HNSW), aggressive token-pruning crawler integration, and a production-grade Model Context Protocol (MCP) server.**

[![Node.js](https://img.shields.io/badge/Node.js-v22%20LTS-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-336791.svg)](https://github.com/pgvector/pgvector)
[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8A2BE2.svg)](https://modelcontextprotocol.io)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-black.svg)](https://fastify.dev)
[![BullMQ](https://img.shields.io/badge/BullMQ-Redis%20Queues-red.svg)](https://bullmq.io)
[![Tests](https://img.shields.io/badge/tests-560%20passing-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🏷️ Tags & Keywords

`ai-agent` • `model-context-protocol` • `mcp-server` • `gtm-outbound` • `b2b-sales-intelligence` • `pgvector` • `hnsw-indexing` • `zero-token-waste` • `lead-scoring` • `intent-signals` • `waterfall-enrichment` • `cold-email-automation` • `linkedin-outreach` • `sales-enablement` • `prompt-caching` • `anti-ban` • `typescript` • `fastify` • `bullmq` • `redis` • `autonomous-outreach` • `rbac` • `audit-log` • `lgpd` • `gdpr` • `data-privacy` • `anonymization` • `suppression-list`

---

## 📌 Overview

**LookaBerry** is a next-generation B2B prospecting and revenue engine designed to be operated autonomously by **AI Agents** (Cursor, Claude Code, Antigravity, OpenCode, Codex, Windsurf) through the **Model Context Protocol (MCP)** and **OpenAPI 3.1 REST API**.

### Why LookaBerry?

- ⚡ **Zero Token Waste Lead Ranking**: Semantic search, ICP fit calculation, and intent weighting run in-database via PostgreSQL 16 `pgvector` with HNSW cosine distance indexes — consuming **0 LLM tokens** to rank thousands of leads.
- 🧹 **LookaCrawler Token Pruning**: Aggressively strips HTML noise (>73% size reduction) to feed clean, distilled semantic Markdown to AI models.
- 🔄 **Autonomous Waterfall Enrichment**: Multi-provider cascading (Cache ➔ Apollo ➔ Dropcontact ➔ SMTP/DNS MX) with verified deliverability.
- ✍️ **Contextual Hyper-Personalization**: Connects real-time intent signals directly to prospect buyer personas with Anthropic prompt caching and strict anti-spam guardrails.
- 🛡️ **Anti-Ban Multi-Channel Dispatcher**: Enforces daily account quotas, Gaussian human-like delays (45s–210s), and automatic 48-hour safety cool-downs.
- 🔁 **Closed-Loop RL Feedback**: Captures email/LinkedIn interactions (Sent, Opened, Clicked, Replied, Bounced), classifies sentiment with Haiku, pauses sequences upon response, and automatically boosts predictive intent weights (+5 on positive reply).
- 🤖 **Autonomous Outreach Loop (S6)**: SequenceScheduler polls for due sequences, dispatcher processes one step at a time with configurable delays, inbox worker reads LinkedIn replies, feedback loop adjusts intent weights — the system walks alone.
- 🔐 **Security & Governance (S15)**: API key lifecycle (create/rotate/revoke), RBAC (Admin/Operator/Campaign Manager/Viewer), campaign isolation, admin audit trail, global suppression list with multi-channel opt-out cascade, data retention & anonymization (LGPD/GDPR), secrets masking in logs and webhook payloads, full threat model.
- 📊 **Reliability (S14)**: Event idempotency (DB UNIQUE + negative cache), exponential backoff with full jitter, Dead-Letter Queue for failed jobs, distributed locking, graceful recovery on restart.

---

## 🗺️ Sprint Execution Roadmap & Operational Status

| Sprint | Focus & Milestone | Active MCP Tools | Status |
| :--- | :--- | :--- | :---: |
| **Sprint 1** | **Core Foundation, pgvector Database & MCP Server Base** | `gtm_analyze_icp` | 🟢 **Operational** |
| **Sprint 2** | **Intent Signal Ingestion & Zero-Token Hybrid Scoring** | `gtm_detect_intent_signals`, `gtm_score_and_rank_leads` | 🟢 **Operational** |
| **Sprint 3** | **Waterfall Enrichment & Deliverability Validation** | `gtm_waterfall_enrich_lead` | 🟢 **Operational** |
| **Sprint 4** | **Hyper-Personalization Engine & Anti-Spam Guardrails** | `gtm_generate_hyper_personalized_message` | 🟢 **Operational** |
| **Sprint 5** | **Multi-Channel Dispatcher & Anti-Ban State Machine** | `gtm_schedule_outreach_sequence` | 🟢 **Operational** |
| **Sprint 6** | **Closed-Loop Analytics, Feedback & Autonomous Loop** | `gtm_track_campaign_metrics`, `gtm_record_lead_interaction_feedback` | 🟢 **Operational** |
| **GTM Brain 2.0** | **Entity Graph, Intent Providers, Decision Engine, Channel Abstraction, Execution Protocol** | `gtm_evaluate_opportunity` | 🟢 **Operational** |
| **Sprint 7** | **Auth, Rate Limiting & Webhook Signatures** | — (hardening) | 🟢 **Operational** |
| **Sprint 8** | **Email Execution (Resend/SMTP)** | — (email adapter) | 🟢 **Operational** |
| **Sprint 12** | **Production Hardening & Observability** | — (health checks, DLQ endpoints) | 🟢 **Operational** |
| **Sprint 14** | **Reliability — Idempotency, Backoff, DLQ, Locking, Recovery** | — (infrastructure) | 🟢 **Operational** |
| **Sprint 15** | **Security & Governance — API Key Lifecycle, RBAC, Audit, Suppression, Anonymization** | — (admin API) | 🟢 **Operational** |

### Upcoming Sprints

| Sprint | Focus | MCP Tools |
| :--- | :--- | :--- |
| **Sprint 9** | **WhatsApp Execution & Multi-Account LinkedIn** | `gtm_send_whatsapp`, account rotation, session management |
| **Sprint 10** | **Ops Dashboard, Real-Time Monitoring, Campaign Engine** | Dashboard UI, queue monitoring, alert webhooks |

---

## 🛠️ Complete MCP Tool Catalog (9 Registered Tools)

| MCP Tool | Description | Sprint |
| :--- | :--- | :---: |
| [`gtm_analyze_icp`](#gtm_analyze_icp) | Scrapes website, extracts value thesis, and indexes 1536-dim ICP embeddings in pgvector | Sprint 1 |
| [`gtm_detect_intent_signals`](#gtm_detect_intent_signals) | Ingests and detects hiring, funding, and tech signals with calibrated weights | Sprint 2 |
| [`gtm_score_and_rank_leads`](#gtm_score_and_rank_leads) | In-database SQL hybrid scoring `(ICP * 0.4) + (Signal * 0.6)` consuming **0 tokens** | Sprint 2 |
| [`gtm_evaluate_opportunity`](#gtm_evaluate_opportunity) | Deterministic opportunity evaluation: signal (40%) + evidence (25%) + ICP (20%) + seniority (15%) | GTM Brain 2.0 |
| [`gtm_waterfall_enrich_lead`](#gtm_waterfall_enrich_lead) | Cascading enrichment (Cache ➔ Apollo ➔ Dropcontact ➔ SMTP/DNS MX verification) | Sprint 3 |
| [`gtm_generate_hyper_personalized_message`](#gtm_generate_hyper_personalized_message) | Generates grounded B2B outreach with prompt caching and character/word guardrails | Sprint 4 |
| [`gtm_schedule_outreach_sequence`](#gtm_schedule_outreach_sequence) | Schedules multi-channel cadences with human delays and daily quota enforcement | Sprint 5 |
| [`gtm_track_campaign_metrics`](#gtm_track_campaign_metrics) | Aggregates real-time conversion rates (open, click, reply, positive reply, bounce) | Sprint 6 |
| [`gtm_record_lead_interaction_feedback`](#gtm_record_lead_interaction_feedback) | Logs events, classifies sentiment, pauses sequences, and reinforces intent weights | Sprint 6 |

---

### Tool Usage Examples

#### `gtm_analyze_icp`
Extracts target buyer personas, value propositions, and pain points directly from a company website and indexes its vector embedding in PostgreSQL.

```json
{
  "website_url": "https://lookaberry.dev",
  "description": "Autonomous AI GTM Outbound Engine with pgvector",
  "target_geos": ["US", "LATAM", "EMEA"]
}
```

#### `gtm_evaluate_opportunity`
Deterministic opportunity evaluation combining active signals, evidence strength, ICP fit, and lead seniority:

```json
{
  "icp_id": "c87b2f01-5c15-495b-8306-557e227f4115",
  "lead_id": "7aa41bf1-e31a-4e5d-85d2-c7d8d72f4dce"
}
```

#### `gtm_score_and_rank_leads`
Executes hybrid ranking with **zero LLM tokens consumed**:

```json
{
  "icp_id": "c87b2f01-5c15-495b-8306-557e227f4115",
  "limit": 10,
  "min_score": 50,
  "status_filter": "READY"
}
```

#### `gtm_schedule_outreach_sequence`
Schedules a multi-step LinkedIn + Cold Email sequence with anti-ban safeguards:

```json
{
  "campaign_id": "fcad1f47-781c-408d-b4a3-663b9ff5c113",
  "lead_ids": ["7aa41bf1-e31a-4e5d-85d2-c7d8d72f4dce"],
  "steps": [
    { "channel": "LINKEDIN_CONNECT", "delay_hours": 0, "prompt_template": "Hook referencing {{signal.summary}}" },
    { "channel": "EMAIL", "delay_hours": 24, "prompt_template": "Value proposition referencing {{signal.summary}}" }
  ]
}
```

---

## 🏗️ System Architecture

```mermaid
flowchart TB
    subgraph Clients["AI Agent Orchestrators & Clients"]
        A1["Cursor / Claude Code / Codex"]
        A2["Antigravity / Windsurf / OpenCode"]
        A3["Autonomous Background Agents / Cron"]
    end

    subgraph InterfaceLayer["Interface & Protocol Layer"]
        MCP_STDIO["MCP Server (stdio)"]
        MCP_SSE["MCP Server (SSE via /sse & /messages)"]
        REST["Fastify REST API (OpenAPI 3.1 /docs)"]
    end

    subgraph CoreEngine["LookaBerry Core Engine (TypeScript)"]
        ICPEngine["1. ICP Profiler & Matrix Generator"]
        SignalEngine["2. Intent Signal Detector & Ingestor"]
        ScoringEngine["3. Zero-Token Hybrid Scoring (pgvector HNSW)"]
        DecisionEngine["3a. Decision & Reasoning Engine"]
        WaterfallEngine["4. Waterfall Enrichment Orchestrator"]
        PersonalizationEngine["5. Hyper-Personalization & Guardrails"]
        ExecutionLayer["6. Browser Execution Protocol"]
        OutreachEngine["6. Multi-Channel Outreach State Machine"]
        SchedulerEngine["6a. Autonomous Sequence Scheduler"]
        InboxEngine["6b. Inbox Reader & Reply Processor"]
        FeedbackEngine["6c. Closed-Loop Feedback & RL"]
        AnalyticsEngine["7. Campaign Metrics & Analytics"]
    end

    subgraph WorkerLayer["Asynchronous Queues (BullMQ + Redis 7.2)"]
        Q_ICP["Queue: ICP Analysis"]
        Q_Signal["Queue: Signal Ingestion"]
        Q_Enrich["Queue: Waterfall Enrichment"]
        Q_Outreach["Queue: Outreach Dispatcher"]
        Q_Inbox["Queue: Inbox Reader"]
    end

    subgraph DataLayer["Persistence & Vector Storage"]
        PG[("PostgreSQL 16 + pgvector (HNSW Indexing)")]
        RedisCache[("Redis 7.2 (Queues, Rate Limits, Deduplication)")]
    end

    subgraph ExternalProviders["External & Browser Providers"]
        Scraping["Web Scraping (LookaCrawler / Jina)"]
        Enrichment["Apollo / Dropcontact / MX / ZeroBounce"]
        LinkedInBridge["LinkedIn via Antigravity Bridge (127.0.0.1:8765)"]
    end

    Clients -->|stdio / SSE / REST| InterfaceLayer
    InterfaceLayer --> CoreEngine
    CoreEngine --> WorkerLayer
    WorkerLayer --> DataLayer
    CoreEngine --> DataLayer
    ExecutionLayer --> LinkedInBridge
    WorkerLayer --> ExternalProviders
```

---

## 🧪 Real Beta Test Execution & Output Walkthrough

LookaBerry includes an end-to-end beta test suite simulating a real customer account across all 6 sprints of the engine:

```bash
npm run test:beta
```

*(Full output available in the source — tests account provisioning, ICP creation, signal ingestion, lead scoring, waterfall enrichment, personalization with guardrails, campaign scheduling with anti-ban rules, and closed-loop feedback with sentiment classification.)*

---

## ⚡ Quick Start Guide (Local Setup)

### 1. Prerequisites
- **Node.js**: v22 LTS or higher
- **Docker Desktop**: Running (for PostgreSQL 16 pgvector + Redis 7.2)

### 2. Install Dependencies
```bash
git clone https://github.com/vetlucasmartins/lookaberry.git
cd lookaberry
npm install
```

### 3. Configure Environment Variables
```bash
cp .env.example .env
```
> **Port Notice**: PostgreSQL runs on port `5433` (mapped from `5432` in container) to prevent conflicts with local database installations.

### 4. Start Database & Redis Cache
```bash
docker compose up -d
```

### 5. Push Prisma Schema & Run Seed
```bash
npm run db:push
npm run db:seed
```

### 6. Start Development Server (REST API + MCP SSE)
```bash
npm run dev
```
- **OpenAPI Swagger UI**: [http://localhost:3000/docs](http://localhost:3000/docs)
- **Health Check Endpoint**: [http://localhost:3000/health](http://localhost:3000/health)
- **MCP SSE Transport**: [http://localhost:3000/sse](http://localhost:3000/sse)

---

## 🔌 Connecting to AI Agents

LookaBerry is built **AI-Native** and connects seamlessly to any coding agent:

### Option A: Cursor IDE (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "lookaberry": {
      "command": "npx",
      "args": ["-y", "tsx", "src/mcp/transports/stdio.ts"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgrespassword@127.0.0.1:5433/lookaberry?schema=public"
      }
    }
  }
}
```

### Option B: Claude Code / Antigravity / OpenCode / Codex (`stdio`)
```bash
claude mcp add lookaberry npx -y tsx src/mcp/transports/stdio.ts
```

### Option C: Remote AI Agents via SSE (HTTP)
- **SSE URL**: `http://localhost:3000/sse`
- **Messages Endpoint**: `http://localhost:3000/messages`

---

## 🧪 Testing & Verification

LookaBerry includes a complete multi-tier testing suite:

```bash
# 1. Run all unit tests (560 passing)
npm test

# 2. Run official MCP client smoke test (validating all 9 tools)
npm run test:smoke

# 3. Run full end-to-end beta test with test account simulation
npm run test:beta

# 4. Typecheck codebase
npx tsc --noEmit

# 5. Production build
npm run build
```

> **Note**: 4 integration tests require PostgreSQL (127.0.0.1:5433) and Redis (localhost:6379). Unit tests (560) pass without infrastructure.

---

## 📂 Repository Structure

```
LookaBerry/
├── docker-compose.yml       # PostgreSQL 16 (pgvector) on port 5433 & Redis 7.2 on 6379
├── package.json             # Scripts for dev, test, smoke, beta, and database migrations
├── tsconfig.json            # Strict TypeScript ES2022 / NodeNext config
├── vitest.config.ts         # Vitest test runner configuration
├── prisma/
│   ├── schema.prisma        # Complete schema with vector(1536), entity graph & channel fields
│   ├── migrations/          # 6 additive migrations (S1–S4 + GTM Brain 2.0)
│   └── seed.ts              # Rich seed script with demo ICPs, companies, and leads
├── src/
│   ├── config/              # Zod environment variable validation
│   ├── db/                  # Prisma client singleton and pgvector HNSW helpers
│   ├── core/
│   │   ├── icp/             # Scraping engine, LLM Analyzer & pgvector embeddings
│   │   ├── intent/          # Intent signal detector, providers & zero-token hybrid ranking
│   │   ├── decision/        # Deterministic opportunity scoring & action recommendations
│   │   ├── evidence/        # Entity graph—source, person, identity, evidence, observation, relationship
│   │   ├── channels/        # Channel abstraction (ChannelId, ChannelProfile, ChannelRegistry)
│   │   ├── security/        # S15: API keys, RBAC, audit trail, suppression, retention, secrets masking
│   │   ├── enrichment/      # Waterfall enrichment orchestrator with MX verification
│   │   ├── personalization/ # Message synthesizer, static prompt cache & guardrails
│   │   ├── outreach/        # Sequence state machine, human delay & anti-ban rules
│   │   ├── execution/       # Browser Execution Protocol (S5) + Autonomous Loop (S6) + S14 Reliability
│   │   │   ├── adapters/    # LinkedInAdapter, EmailAdapter, WhatsAppAdapter, ManualAdapter
│   │   │   ├── antigravity.ts  # Antigravity Chrome extension HTTP client
│   │   │   ├── router.ts    # ExecutionRouter — routes actions to channel adapters
│   │   │   ├── dispatcher.ts   # BullMQ worker — processes one sequence step at a time
│   │   │   ├── scheduler.ts    # SequenceScheduler — polls for due sequences
│   │   │   ├── inboxWorker.ts  # InboxWorker — reads LinkedIn replies, classifies sentiment
│   │   │   ├── feedbackLoop.ts # FeedbackLoop — delivery verification & intent weight adjustment
│   │   │   ├── idempotency.ts   # S14: Event deduplication & safe replay
│   │   │   ├── backoff.ts       # S14: Exponential backoff with full jitter
│   │   │   ├── dlq.ts           # S14: Dead-Letter Queue
│   │   │   ├── locking.ts       # S14: Distributed locking via pg_advisory_lock
│   │   │   ├── recovery.ts      # S14: Graceful restart & reconnection recovery
│   │   │   └── webhookIdempotency.ts # S14: Idempotent webhook event processing
│   │   ├── analytics/       # Feedback classification & closed-loop RL metrics
│   │   └── queues/          # BullMQ queue definitions and workers
│   ├── mcp/
│   │   ├── server.ts        # McpServer instance & tool catalog
│   │   ├── tools/           # 9 registered MCP tools across all sprints
│   │   ├── schemas/         # Zod schemas with strict validation
│   │   └── transports/      # stdio and SSE transport entrypoints
│   ├── api/
│   │   ├── server.ts        # Fastify factory with CORS and Swagger UI
│   │   ├── routes/          # /health, /api/v1/icp/analyze, /sse, /messages, /webhooks
│   │   └── plugins/         # OpenAPI 3.1 schema documentation
│   └── index.ts             # Server entrypoint with all workers & scheduler
└── tests/
    ├── unit/                # 34 unit test files — 560 tests across all modules
    ├── integration/         # Database, Fastify REST API, MCP, evidence, and S14 reliability integration tests
    ├── mcp-client-smoke.ts  # End-to-end MCP client smoke test
    └── beta-test-account.ts # Full beta test suite with test account simulation
```

---

## 📚 Technical Documentation

- [Sprint Roadmap & Next Steps](docs/ROADMAP.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [Data Model & pgvector Schema](docs/DATA_MODEL.md)
- [MCP Tools Catalog](docs/MCP_TOOLS.md)
- [Implementation Status Audit](docs/IMPLEMENTATION_STATUS.md)
- [Intent Providers Architecture](docs/INTENT_PROVIDERS.md)
- [Entity & Evidence Graph Model](docs/EVIDENCE_MODEL.md)
- [Security & Compliance (LGPD/GDPR)](docs/SECURITY_COMPLIANCE.md)
- [Threat Model (S15)](docs/THREAT_MODEL.md)

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for details.