# 🍓 LookaBerry — AI GTM Outbound Engine (API + MCP Server)

> **Infraestrutura autônoma e headless de Go-to-Market (GTM) e Outbound B2B orientada a agentes de IA, com banco de dados vetorial PostgreSQL 16 + pgvector, motor de scraping otimizado com LookaCrawler e servidor MCP.**

[![Node.js](https://img.shields.io/badge/Node.js-v22%20LTS-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-336791.svg)](https://github.com/pgvector/pgvector)
[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8A2BE2.svg)](https://modelcontextprotocol.io)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-black.svg)](https://fastify.dev)
[![BullMQ](https://img.shields.io/badge/BullMQ-Redis%20Queues-red.svg)](https://bullmq.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 📌 Visão Geral

O **LookaBerry** é uma plataforma de prospecção e engajamento B2B de última geração projetada para ser operada diretamente por **Agentes de IA** (Claude Code, Cursor, Codex, Antigravity, Windsurf) através do **Model Context Protocol (MCP)** e endpoints **REST OpenAPI 3.1**.

### Por que o LookaBerry é diferente?
- **Zero Token Waste**: Toda a busca semântica, ranqueamento de contas e ponderação de sinais é executada diretamente no PostgreSQL 16 com `pgvector` em índices HNSW — consumindo **0 tokens de LLM** para ordenar milhares de leads.
- **LookaCrawler Engine**: Poda agressiva de ruído de HTML (>73% de redução de tamanho) entregando apenas Markdown semântico destilado para a IA.
- **Protocolo Híbrido**: Opera como servidor MCP sobre transporte `stdio` (local para IDEs) e `SSE` (remoto via HTTP/Fastify), além de expor REST API completa com Swagger UI.

---

## 🏗️ Arquitetura do Sistema

```mermaid
flowchart TB
    subgraph Clients["Orquestradores & Clientes (IA Consumidora)"]
        A1["Cursor / Claude Code / Codex"]
        A2["Antigravity / Windsurf"]
        A3["Agentes Autônomos / Cron"]
    end

    subgraph InterfaceLayer["Camada de Interface & Protocolos"]
        MCP_STDIO["MCP Server (stdio)"]
        MCP_SSE["MCP Server (SSE via /sse & /messages)"]
        REST["Fastify REST API (OpenAPI 3.1 /docs)"]
    end

    subgraph CoreEngine["LookaBerry Core Engine (TypeScript)"]
        ICPEngine["1. ICP Profiler & Matrix Generator"]
        LookaCrawler["LookaCrawler Engine (Token-Pruning & Turndown)"]
        SignalEngine["2. Intent Signal Detector & Ingestor"]
        ScoringEngine["3. Hybrid Scoring (pgvector HNSW + Rules)"]
        WaterfallEngine["4. Waterfall Enrichment Orchestrator"]
        PersonalizationEngine["5. Hyper-Personalization Engine"]
        OutreachEngine["6. Multi-Channel Outreach State Machine"]
        AnalyticsEngine["7. Feedback Loop & Continuous RL"]
    end

    subgraph WorkerLayer["Filas & Processamento Assíncrono (BullMQ + Redis)"]
        Q_ICP["Queue: ICP Analysis"]
        Q_Signal["Queue: Signal Ingestion"]
        Q_Enrich["Queue: Waterfall Enrichment"]
        Q_Outreach["Queue: Outreach Dispatcher"]
    end

    subgraph DataLayer["Persistência & Caching"]
        PG[("PostgreSQL 16 + pgvector (HNSW)")]
        RedisCache[("Redis 7.2 (Queues, Cache, Locks)")]
    end

    Clients -->|stdio / SSE / REST| InterfaceLayer
    InterfaceLayer --> CoreEngine
    CoreEngine --> LookaCrawler
    CoreEngine --> WorkerLayer
    WorkerLayer --> DataLayer
    CoreEngine --> DataLayer
```

---

## 🗺️ Roadmap de Execução & Status das Sprints

| Sprint | Foco | Tools MCP Ativas | Status |
| :--- | :--- | :--- | :---: |
| **Sprint 1** | **Fundação do Core, Banco Vetorial e MCP Server Base** | `gtm_analyze_icp` | 🟢 **Operacional** |
| **Sprint 2** | Ingestão de Sinais de Intenção e Hybrid Scoring Engine | `gtm_detect_intent_signals`, `gtm_score_and_rank_leads` | 🟢 **Implementado e testado** |
| **Sprint 3** | Waterfall Enrichment e Validação de Entregabilidade | `gtm_waterfall_enrich_lead` | 🟢 **Implementado e testado** |
| **Sprint 4** | Motor de Hiper-Personalização com Prompt Caching | `gtm_generate_hyper_personalized_message` | ⚪ Planejado |
| **Sprint 5** | Dispatcher Multicanal, Sequências e Anti-Ban Engine | `gtm_schedule_outreach_sequence` | ⚪ Planejado |
| **Sprint 6** | Analytics, Loop de Feedback e Aprendizado Contínuo | `gtm_track_campaign_metrics`, `gtm_record_lead_interaction_feedback` | ⚪ Planejado |

---

## 📂 Estrutura do Repositório

```
LookaBerry/
├── docker-compose.yml       # PostgreSQL 16 (pgvector) na porta 5433 e Redis 7.2 na 6379
├── package.json             # Scripts de dev, build, MCP, testes e migrações
├── tsconfig.json            # Configurações do TypeScript ES2022 / NodeNext
├── vitest.config.ts         # Configuração da suíte de testes Vitest
├── prisma/
│   ├── schema.prisma        # Schema completo com tipos vector(1536) e enums
│   └── migrations/          # Migrações SQL iniciais e criação de índices HNSW
├── src/
│   ├── config/              # Validação de variáveis de ambiente com Zod
│   ├── db/                  # Singleton Prisma e helpers pgvector para HNSW
│   ├── core/
│   │   ├── icp/             # Engine de Scraping (LookaCrawler), LLM Analyzer e Embeddings
│   │   └── queues/          # Filas BullMQ e background workers
│   ├── mcp/
│   │   ├── server.ts        # Instanciação do McpServer
│   │   ├── tools/           # Catálogo de ferramentas MCP (gtm_analyze_icp)
│   │   ├── schemas/         # Schemas Zod de entrada e saída
│   │   └── transports/      # Transportes stdio e SSE
│   ├── api/
│   │   ├── server.ts        # Fastify factory com CORS e Swagger UI
│   │   ├── routes/          # /health, /api/v1/icp/analyze, /sse, /messages
│   │   └── plugins/         # Documentação OpenAPI 3.1
│   └── index.ts             # Entrypoint principal do servidor
└── tests/
    ├── unit/                # Testes de embeddings, scraper e analyzer
    ├── integration/         # Testes de pgvector HNSW, Fastify API e MCP
    └── mcp-client-smoke.ts  # Smoke test ponta-a-ponta com cliente MCP oficial
```

---

## ⚡ Inicialização Rápida Local

### 1. Pré-requisitos
- **Node.js**: v22 LTS ou superior
- **Docker Desktop**: Em execução para subir o banco e o cache

### 2. Instalar Dependências
```bash
cd LookaBerry
npm install
```

### 3. Configurar Variáveis de Ambiente
```bash
cp .env.example .env
```
> **Nota de Porta**: O PostgreSQL roda na porta `5433` mapeada para `5432` no container para evitar conflitos com instâncias locais do PostgreSQL.

### 4. Subir Banco de Dados e Cache
```bash
docker compose up -d
```

### 5. Sincronizar Schema com o Banco
```bash
npm run db:push
```

### 6. Iniciar Servidor (REST API + MCP SSE)
```bash
npm run dev
```
- **Documentação Swagger UI**: [http://localhost:3000/docs](http://localhost:3000/docs)
- **Healthcheck**: [http://localhost:3000/health](http://localhost:3000/health)
- **Transporte MCP SSE**: [http://localhost:3000/sse](http://localhost:3000/sse)

---

## 🔌 Conectando ao Servidor MCP

### Opção A: Claude Code / Cursor / Codex (via stdio)

Adicione ao arquivo de configuração MCP do seu ambiente (`claude_desktop_config.json`, `~/.cursor/mcp.json` ou `.gemini/config/skills`):

```json
{
  "mcpServers": {
    "lookaberry": {
      "command": "npx",
      "args": ["-y", "tsx", "/Users/Master/LookaBerry/src/mcp/transports/stdio.ts"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgrespassword@127.0.0.1:5433/lookaberry?schema=public",
        "REDIS_URL": "redis://localhost:6379",
        "ANTHROPIC_API_KEY": "sua-chave-aqui",
        "OPENAI_API_KEY": "sua-chave-aqui"
      }
    }
  }
}
```

### Opção B: Agentes Remotos / Windsurf (via SSE)

Inicie o servidor com `npm run dev` e aponte seu cliente MCP para:
- **SSE URL**: `http://localhost:3000/sse`
- **Messages Endpoint**: `http://localhost:3000/messages`

---

## 🛠️ Ferramentas MCP Ativas (Sprints 1–3)

### `gtm_analyze_icp`
Extrai a tese de valor de uma empresa a partir do seu website e gera o perfil do ICP com personas, dores agudas e embeddings vetoriais de 1536 dimensões indexados em HNSW.

#### Exemplo de Chamada:
```json
{
  "website_url": "https://stripe.com",
  "description": "Financial infrastructure for the internet",
  "target_geos": ["US", "LATAM", "EU"]
}
```

#### Exemplo de Resposta Estruturada:
```json
{
  "icp_id": "2256c89e-be74-45ff-a1d7-6dc81ce6de7a",
  "company_summary": "Stripe provides economic infrastructure for internet businesses, enabling payments, payouts, and billing automation.",
  "target_personas": [
    {
      "title": "Head of Engineering / CTO",
      "seniority": "C-Level",
      "core_pain": "Complex multi-currency payment reconciliation and high fraud chargeback rates."
    },
    {
      "title": "VP of Finance / CFO",
      "seniority": "VP",
      "core_pain": "Manual billing workflows and slow international expansion."
    }
  ],
  "value_propositions": [
    "Unified API for global payments and card acquiring",
    "Real-time fraud prevention with machine learning",
    "Automated recurring revenue and billing compliance"
  ]
}
```

---

## 🧪 Testes e Validação

Execute a suíte completa de testes automatizados com Vitest:

```bash
# Executar todos os testes unitários e de integração
npm test

# Executar smoke test ponta-a-ponta com cliente MCP oficial
npm run test:smoke

# Compilar TypeScript para produção
npm run build
```

---

## 📚 Documentação Técnica Completa

- [Arquitetura do Sistema](file:///Users/Master/LookaBerry/docs/ARCHITECTURE.md)
- [Modelagem de Dados (PostgreSQL + pgvector)](file:///Users/Master/LookaBerry/docs/DATA_MODEL.md)
- [Catálogo de Ferramentas MCP](file:///Users/Master/LookaBerry/docs/MCP_TOOLS.md)
- [Estratégia de Otimização de Tokens](file:///Users/Master/LookaBerry/docs/TOKEN_OPTIMIZATION.md)
- [Segurança e Compliance](file:///Users/Master/LookaBerry/docs/SECURITY_COMPLIANCE.md)
- [Roadmap de Execução (6 Sprints)](file:///Users/Master/LookaBerry/docs/ROADMAP.md)

---

## 📄 Licença

Distribuído sob a licença MIT. Veja `LICENSE` para mais detalhes.
