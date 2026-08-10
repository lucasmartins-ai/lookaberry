# 🍓 LookaBerry — AI GTM Outbound Engine (API + MCP Server)

> **Autonomous, headless Go-to-Market (GTM) and B2B Outbound infrastructure designed for AI agents. Powered by PostgreSQL 16 + pgvector (HNSW), aggressive token-pruning crawler integration, and a production-grade Model Context Protocol (MCP) server.**

[![Node.js](https://img.shields.io/badge/Node.js-v22%20LTS-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-336791.svg)](https://github.com/pgvector/pgvector)
[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8A2BE2.svg)](https://modelcontextprotocol.io)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-black.svg)](https://fastify.dev)
[![BullMQ](https://img.shields.io/badge/BullMQ-Redis%20Queues-red.svg)](https://bullmq.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🏷️ Tags & Keywords

`ai-agent` • `model-context-protocol` • `mcp-server` • `gtm-outbound` • `b2b-sales-intelligence` • `pgvector` • `hnsw-indexing` • `zero-token-waste` • `lead-scoring` • `intent-signals` • `waterfall-enrichment` • `cold-email-automation` • `linkedin-outreach` • `sales-enablement` • `prompt-caching` • `anti-ban` • `typescript` • `fastify` • `bullmq` • `redis`

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
        LookaCrawler["LookaCrawler Engine (Token-Pruning & Turndown)"]
        SignalEngine["2. Intent Signal Detector & Ingestor"]
        ScoringEngine["3. Zero-Token Hybrid Scoring (pgvector HNSW)"]
        WaterfallEngine["4. Waterfall Enrichment Orchestrator"]
        PersonalizationEngine["5. Hyper-Personalization & Guardrails Engine"]
        OutreachEngine["6. Multi-Channel Outreach State Machine"]
        AnalyticsEngine["7. Closed-Loop Feedback & RL Analytics"]
    end

    subgraph WorkerLayer["Asynchronous Queues (BullMQ + Redis 7.2)"]
        Q_ICP["Queue: ICP Analysis"]
        Q_Signal["Queue: Signal Ingestion"]
        Q_Enrich["Queue: Waterfall Enrichment"]
        Q_Outreach["Queue: Outreach Dispatcher"]
    end

    subgraph DataLayer["Persistence & Vector Storage"]
        PG[("PostgreSQL 16 + pgvector (HNSW Indexing)")]
        RedisCache[("Redis 7.2 (Queues, Rate Limits, Deduplication)")]
    end

    Clients -->|stdio / SSE / REST| InterfaceLayer
    InterfaceLayer --> CoreEngine
    CoreEngine --> LookaCrawler
    CoreEngine --> WorkerLayer
    WorkerLayer --> DataLayer
    CoreEngine --> DataLayer
```

---

## 🧪 Real Beta Test Execution & Output Walkthrough

LookaBerry includes an end-to-end beta test suite simulating a real customer account across all 6 sprints of the engine:

```bash
npm run test:beta
```

### 📋 Live Beta Test Execution Log

```text
═══════════════════════════════════════════════════════════════════════
🚀 STARTING FULL LOOKABERRY BETA TEST WITH TEST ACCOUNT
═══════════════════════════════════════════════════════════════════════

🔹 1. Provisioning Test Account (Outreach Account)...
   ✅ Test account created: beta_test_account_smartlead_01 (Daily limit: 75, Sent today: 5)

🔹 2. Creating ICP Profile & Generating Vector Embedding in pgvector...
   ✅ ICP Profile created: Beta Test: High-Growth AI & SaaS Scale-ups (c87b2f01-5c15-495b-8306-557e227f4115)
   ✅ 1536-dim vector embedding persisted in pgvector: YES (100% OK)

🔹 3. Ingesting Target Company & Live Intent Signals...
   ✅ Company created: Neura SaaS Technologies (neura-saas-tech.com)
   ✅ Signals ingested: 
      - "Neura SaaS is actively hiring 5 SDRs and 1 Head of Outbound" (Weight: 88.0)
      - "Neura SaaS raises $8M to scale commercial sales team" (Weight: 92.0)

🔹 4. Creating Lead & Executing Hybrid Scoring (Zero Token Cost pgvector)...
   ✅ Top ranked lead: Guilherme Medeiros (Head of Sales)
   📊 ICP Score: 92.0 | Intent Score: 90.0 | Total Priority Score: 90.8
   🎯 Primary Intent Signal detected: "Neura SaaS is actively hiring 5 SDRs and 1 Head of Outbound"

🔹 5. Running Waterfall Lead Enrichment & MX Deliverability Check...
   ✅ Verified Email: guilherme.medeiros@neura-saas-tech.com
   ✅ Deliverability status: VERIFIED
   ✅ Provider used: LOCAL_CACHE / MX_VALIDATOR

🔹 6. Testing AI Personalization Model & Anti-Spam Guardrails...

   📨 [Channel: LINKEDIN_CONNECT]
      Body: "Hi Guilherme, noticed you're expanding your outbound team for scale. How are you currently tackling data quality and pipeline velocity for your new SDRs?"
      Hook used: "Neura SaaS is actively hiring 5 SDRs and 1 Head of Outbound"
      Tokens estimated: 59 | Length: 142 chars (Within channel limit: OK)

   📨 [Channel: LINKEDIN_MESSAGE]
      Body: "Hi Guilherme, congrats on the recent funding and outbound team expansion at Neura SaaS Technologies. We built a zero token-waste pgvector ranking engine that identifies active buying intent accounts automatically. Would you be open to a brief 10-min chat this Thursday?"
      Hook used: "Neura SaaS raises $8M to scale commercial sales team"
      Tokens estimated: 88 | Length: 268 chars (Within channel limit: OK)

   📨 [Channel: EMAIL]
      Subject: "Guilherme, accelerating outbound pipeline at Neura SaaS Technologies"
      Body: "Hi Guilherme,

Notice that Neura SaaS Technologies is expanding its SDR team for Q3.

We help revenue leaders automate high-intent account identification using hybrid pgvector ranking and verified waterfall enrichment, eliminating closer prospecting waste.

Would you be open to a quick 15-minute sync later this week?

Best regards,
LookaBerry Team"
      Hook used: "Neura SaaS is actively hiring 5 SDRs and 1 Head of Outbound"
      Tokens estimated: 127 | Length: 360 chars (Within channel limit: OK)

🔹 7. Creating Test Campaign & Scheduling Multi-Channel Sequence...
   ✅ Campaign created: Beta Test Campaign - Q3 Scale (fcad1f47-781c-408d-b4a3-663b9ff5c113)
   ✅ Sequence scheduled: ID 58944c86-d505-455c-88f2-a3d6815e91bc (Status: ACTIVE)
   ⏱️  Sampled Human Gaussian Delay: 115 seconds (Anti-ban protection active)
   🛡️  Account Quota Check: ALLOWED (Within daily limits)

🔹 8. Testing Closed-Loop Feedback & Real-Time Analytics Tracking...
   📬 Event recorded: OPEN (Email opened by prospect)
   🖱️  Event recorded: CLICK (Link clicked in proposition)
   💬 Event recorded: POSITIVE REPLY (Feedback ID: eda34d35-7c59-494b-b6ac-af867ae7a125)
   📈 Intent signal weight reinforced: 88.0 ➔ 93.0 (+5 boost on positive reply)
   ⏸️  Sequence auto-paused after reply: YES (100% OK)
   🎯 Lead status updated: REPLIED_POSITIVE
   📊 Message status: REPLIED (Sentiment: POSITIVE)
   📊 Campaign Conversion Metrics:
      {
        "sent": 1,
        "opens": 1,
        "clicks": 1,
        "replies": 1,
        "bounces": 0,
        "positive_replies": 1,
        "negative_replies": 0,
        "open_rate": 1.0,
        "click_rate": 1.0,
        "reply_rate": 1.0,
        "bounce_rate": 0.0
      }

🔹 9. Cleaning up temporary test records...
   🧹 Test data cleanup completed successfully.

======================================================================
🎉 BETA TEST COMPLETED WITH 100% SUCCESS! ALL MODULES FUNCTIONAL.
======================================================================
```

---

## 🗺️ Sprint Execution Roadmap & Operational Status

| Sprint | Focus & Milestone | Active MCP Tools | Status |
| :--- | :--- | :--- | :---: |
| **Sprint 1** | **Core Foundation, pgvector Database & MCP Server Base** | `gtm_analyze_icp` | 🟢 **Operational** |
| **Sprint 2** | **Intent Signal Ingestion & Zero-Token Hybrid Scoring** | `gtm_detect_intent_signals`, `gtm_score_and_rank_leads` | 🟢 **Operational** |
| **Sprint 3** | **Waterfall Enrichment & Deliverability Validation** | `gtm_waterfall_enrich_lead` | 🟢 **Operational** |
| **Sprint 4** | **Hyper-Personalization Engine & Anti-Spam Guardrails** | `gtm_generate_hyper_personalized_message` | 🟢 **Operational** |
| **Sprint 5** | **Multi-Channel Dispatcher & Anti-Ban State Machine** | `gtm_schedule_outreach_sequence` | 🟢 **Operational** |
| **Sprint 6** | **Closed-Loop Analytics, Feedback & Reinforcement** | `gtm_track_campaign_metrics`, `gtm_record_lead_interaction_feedback` | 🟢 **Operational** |

---

## 🛠️ Complete MCP Tool Catalog (8 Registered Tools)

| MCP Tool | Description | Sprint |
| :--- | :--- | :---: |
| [`gtm_analyze_icp`](#gtm_analyze_icp) | Scrapes website, extracts value thesis, and indexes 1536-dim ICP embeddings in pgvector | Sprint 1 |
| [`gtm_detect_intent_signals`](#gtm_detect_intent_signals) | Ingests and detects hiring, funding, and tech signals with calibrated weights | Sprint 2 |
| [`gtm_score_and_rank_leads`](#gtm_score_and_rank_leads) | In-database SQL hybrid scoring `(ICP * 0.4) + (Signal * 0.6)` consuming **0 tokens** | Sprint 2 |
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
# 1. Run all unit and integration tests (27 passing tests)
npm test

# 2. Run official MCP client smoke test (validating all 8 tools)
npm run test:smoke

# 3. Run full end-to-end beta test with test account simulation
npm run test:beta

# 4. Typecheck codebase
npx tsc --noEmit

# 5. Production build
npm run build
```

---

## 📂 Repository Structure

```
LookaBerry/
├── docker-compose.yml       # PostgreSQL 16 (pgvector) on port 5433 & Redis 7.2 on 6379
├── package.json             # Scripts for dev, test, smoke, beta, and database migrations
├── tsconfig.json            # Strict TypeScript ES2022 / NodeNext config
├── vitest.config.ts         # Vitest test runner configuration
├── prisma/
│   ├── schema.prisma        # Complete schema with vector(1536) columns & relations
│   └── seed.ts              # Rich seed script with demo ICPs, companies, and leads
├── src/
│   ├── config/              # Zod environment variable validation
│   ├── db/                  # Prisma client singleton and pgvector HNSW helpers
│   ├── core/
│   │   ├── icp/             # Scraping engine, LLM Analyzer & pgvector embeddings
│   │   ├── intent/          # Intent signal detector & zero-token hybrid ranking
│   │   ├── enrichment/      # Waterfall enrichment orchestrator with MX verification
│   │   ├── personalization/ # Message synthesizer, static prompt cache & guardrails
│   │   ├── outreach/        # Sequence state machine, human delay & anti-ban rules
│   │   ├── analytics/       # Feedback classification & closed-loop RL metrics
│   │   └── queues/          # BullMQ queue definitions and workers
│   ├── mcp/
│   │   ├── server.ts        # McpServer instance & tool catalog
│   │   ├── tools/           # 8 registered MCP tools across all 6 sprints
│   │   ├── schemas/         # Zod schemas with strict validation
│   │   └── transports/      # stdio and SSE transport entrypoints
│   ├── api/
│   │   ├── server.ts        # Fastify factory with CORS and Swagger UI
│   │   ├── routes/          # /health, /api/v1/icp/analyze, /sse, /messages, /webhooks
│   │   └── plugins/         # OpenAPI 3.1 schema documentation
│   └── index.ts             # Server entrypoint
└── tests/
    ├── unit/                # Unit test suites for all 6 sprint modules
    ├── integration/         # Database, Fastify REST API, and MCP integration tests
    ├── mcp-client-smoke.ts  # End-to-end MCP client smoke test
    └── beta-test-account.ts # Full beta test suite with test account simulation
```

---

## 📚 Technical Documentation

- [System Architecture](file:///Users/Master/LookaBerry/docs/ARCHITECTURE.md)
- [Data Model & pgvector Schema](file:///Users/Master/LookaBerry/docs/DATA_MODEL.md)
- [MCP Tools Catalog](file:///Users/Master/LookaBerry/docs/MCP_TOOLS.md)
- [Zero-Token Optimization Strategy](file:///Users/Master/LookaBerry/docs/TOKEN_OPTIMIZATION.md)
- [Security & Compliance](file:///Users/Master/LookaBerry/docs/SECURITY_COMPLIANCE.md)
- [Sprint Roadmap](file:///Users/Master/LookaBerry/docs/ROADMAP.md)

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for details.
