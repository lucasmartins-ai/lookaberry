# Arquitetura do Sistema — LookaBerry

---

## 1. Visão Geral

O LookaBerry é uma arquitetura orientada a serviços assíncronos e orientada a ferramentas (Tool-Oriented Architecture), projetada para ser invocada por agentes de IA e LLMs via Model Context Protocol (MCP) e endpoints REST compatíveis com OpenAPI 3.1.

O sistema opera de forma headless e modular, delegando processamento pesado e I/O de rede para filas com controle fino de taxa e concorrência.

---

## 2. Diagrama de Arquitetura

```mermaid
flowchart TB
    subgraph Clients["Orquestradores & Clientes (IA Consumidora)"]
        A1["Cursor / Claude Code / Codex"]
        A2["Antigravity / Windsurf"]
        A3["CRON / Autonomous Scheduler"]
    end

    subgraph InterfaceLayer["Camada de Interface & Protocolos"]
        MCP["MCP Server (JSON-RPC 2.0 via stdio / SSE)"]
        REST["Fastify REST API (OpenAPI 3.1)"]
        Auth["API Key & Rate Limiter (NOT IMPLEMENTED)"]
    end

    subgraph CoreEngine["LookaBerry Core Engine (TypeScript / Fastify)"]
        ICPEngine["1. ICP Profiler & Matrix Generator"]
        SignalEngine["2. Intent Signal Detector & Ingestor"]
        ScoringEngine["3. Hybrid Scoring (Vector + Rules)"]
        WaterfallEngine["4. Waterfall Enrichment Orchestrator"]
        PersonalizationEngine["5. Hyper-Personalization Engine"]
        ExecutionLayer["6. Browser Execution Protocol (S5)"]
        OutreachEngine["6. Multi-Channel Outreach State Machine"]
        AnalyticsEngine["7. Feedback Loop & RL Fine-tuning"]
    end

    subgraph WorkerLayer["Filas & Processamento Assíncrono (BullMQ + Redis)"]
        Q_Signal["Queue: Signal Ingestion (no worker)"]
        Q_Enrich["Queue: Waterfall Enrichment"]
        Q_Outreach["Queue: Rate-Limited Dispatcher (worker active, graceful degradation)"]
        Q_Sync["Queue: Webhook & CRM Sync"]
    end

    subgraph DataLayer["Persistência & Caching"]
        PG[("PostgreSQL 16 + pgvector")]
        RedisCache[("Redis 7.2 (Cache, State, Lock & Queues)")]
    end

    subgraph ExternalProviders["Provedores Externos & Provedores de Dados"]
        Scraping["Web Scraping & Crawling (LookaCrawler / Jina Reader)"]
        Signals["Public inputs + local signal providers"]
         Waterfall["Enrichment (Cache -> Apollo -> Dropcontact -> MX/ZeroBounce)"]
        LinkedInBridge["LinkedIn via Antigravity Extension (bridge 127.0.0.1:8765)"]
        MailboxStub["Email Execution (NOT IMPLEMENTED)"]
    end

    Clients -->|Tools / Prompts / Resources| InterfaceLayer
    InterfaceLayer --> CoreEngine
    CoreEngine --> WorkerLayer
    WorkerLayer --> DataLayer
    CoreEngine --> DataLayer        ExecutionLayer --> LinkedInBridge
        WorkerLayer --> ExternalProviders
    ExternalProviders -->|Webhooks / Callbacks| REST
```

---

## 3. Componentes Principais e Responsabilidades

### 3.1. MCP Server Gateway (`src/mcp/`)
- Implementa o protocolo MCP sobre `stdio` (para uso local pelo Cursor/Claude Code) e `SSE` (Server-Sent Events) para orquestrações distribuídas.
- Expõe um catálogo estrito de 8 tools tipadas com validação Zod.
- As tools delegam aos serviços core; resources e prompts adicionais não fazem parte do catálogo implementado nesta versão.

### 3.2. ICP Profiler Engine (`src/core/icp/`)
- Recebe a URL do website e o briefing inicial do cliente.
- Efetua crawling com o motor de alta performance do **LookaCrawler**, com remoção de boilerplate HTML, poda agressiva de ruído (>70% de economia de tokens), `@mozilla/readability` e `Turndown`.
- Sintetiza as dores, personas ideais e propostas de valor, gerando embeddings de 1536 dimensões para armazenamento no `pgvector`.

### 3.3. Intent Signal Engine (`src/core/intent/`)
- Separa coleta, normalização, classificação, confiança, persistência e scoring por meio do contrato `SignalProvider`.
- Providers locais implementados: `website-changes`, `hiring` e `public-announcements`; o adapter `funding-api` retorna explicitamente `REQUIRES_CREDENTIALS` sem simular uma integração paga.
- Sinais podem vir de snapshots, HTML, itens normalizados ou URLs públicas. Cada sinal registra provider, fonte, URL, observação, TTL, confiança, qualidade da fonte, custo, classificação de evidência, payload normalizado/sanitizado e chave de deduplicação.
- A coleta reporta `IMPLEMENTED`, `NOT_AVAILABLE`, `FAILED`, `TIMEOUT`, `PARTIALLY_IMPLEMENTED` ou `REQUIRES_CREDENTIALS`; falhas não são convertidas silenciosamente em sinais válidos.

### 3.4. Hybrid Scoring Engine (`src/core/intent/service.ts` + `scoring.ts`)
- Combina a aderência estática (distância de cosseno entre a empresa e o perfil de ICP no pgvector) com sinais ativos ponderados por recência/TTL, confiança, qualidade da fonte, tipo, classificação e peso configurável.
- Deduplica contribuições por chave de evento, ignora sinais expirados/inativos e usa desempate estável por identificador.
- O ranking é determinístico e não usa LLM. Sem `OPENAI_API_KEY`, o embedding SHA-256 é somente fallback offline e não representa similaridade semântica.

### 3.5. Waterfall Enrichment Orchestrator (`src/core/enrichment/`)
- Resolve dados de contato de forma escalonada para otimizar custos de créditos:
  1. Consulta ao cache local de contatos já verificados.
  2. Consulta Apollo e, em caso de ausência ou falha, Dropcontact.
  3. Validação de entregabilidade por MX antes de marcar como `VERIFIED`.
  4. Registra cada tentativa, status, payload sanitizado e créditos em `enrichment_logs`.
  5. Processa jobs em BullMQ com limite de taxa, retries e backoff exponencial.

### 3.6. Hyper-Personalization Engine (`src/core/personalization/`)
- Constrói o gancho (hook) inicial cruzando estritamente:
  - Contexto da empresa e cargo do lead.
  - O sinal de intenção específico detectado.
  - A dor do ICP correspondente.
- Utiliza **Prompt Caching** da Anthropic para reduzir a latência e o custo de inferência em até 90%.

### 3.7. Outreach Scheduler & Execution (`src/core/outreach/` + `src/core/execution/`)
- `OutreachService.scheduleSequence` persiste cadências multicanal, gera mensagens planejadas e enfileira o primeiro step no BullMQ (`outreach_dispatcher_queue`) com graceful degradation (3s timeout para Redis).
- `applyAntiBanPolicy`, `sampleHumanDelaySeconds` e `advanceSequenceState` são guardrails puros usados pelo dispatcher.
- `executionRouter` é o singleton de roteamento que seleciona `ChannelAdapter` por `ChannelId`, valida capabilities via `ChannelRegistry` e executa ações.

### 3.8. Analytics & Continuous Learning Loop (`src/core/analytics/`)
- Captura de eventos via `POST /api/v1/webhooks/outreach` (abertura, clique, resposta e bounce).
- Agregação transacional em `campaign_metrics`, com taxas calculadas na consulta MCP.
- Classificação de resposta via Haiku; resultados abaixo de 85% ficam marcados para revisão humana.
- Resposta pausa sequências ativas, atualiza o status do lead e ajusta o peso do sinal associado em passos de 5 pontos, limitado entre 0 e 100.

### 3.9. Entity & Evidence Graph (S1)
- `Company`, `Person` e `Identity` representam contas, pessoas e identificadores sem acoplar o core a um canal específico.
- `Source` registra a proveniência compartilhada por evidências, observações, relações e interações.
- `CompanyEvidence` e `PersonEvidence` registram `source`, URL, `observedAt`, `expiresAt`, `confidence`, classificação (`FACT`, `INFERENCE`, `LLM_INFERENCE`, `USER_PROVIDED`, `UNVERIFIED`) e dados normalizados.
- Payloads brutos são sanitizados no serviço de entidades antes da persistência; chaves sensíveis são redigidas e cada evidência recebe um hash de conteúdo.
- `Observation`, `Relationship` e `Interaction` completam a base relacional para o ciclo futuro `Observe → Understand → Decide → Act`.
- O modelo legado `Lead` permanece compatível e pode apontar para `Person` por `personId`.

### 3.10. Intent Provider Pipeline (S2)
- `IntentSignal` mantém os campos legados e adiciona proveniência, `CompanyEvidence` opcional, TTL, confiança, classificação, custo e dados normalizados.
- A persistência reutiliza `Source` e `CompanyEvidence` da S1; o payload legado `rawPayload` permanece por compatibilidade, mas as novas entradas passam pela sanitização do serviço de evidências.
- `gtm_detect_intent_signals` preserva `signals` e recebe campos aditivos para `collection_inputs`, providers e timeout. `gtm_score_and_rank_leads` preserva seus campos existentes e acrescenta contagens de sinais.
- A implementação pública não inclui APIs pagas, LinkedIn autenticado, agendamento de crawls ou workers de ingestão; esses pontos continuam parciais ou fora do escopo.

### 3.11. Decision & Reasoning Engine (S3)
- Transforma sinais ativos + evidências + ICP fit em `OpportunityScore` determinístico, sem LLM.
- Pipeline de score: 40% signal score (recência, confiança, classificação, dedup), 25% evidence strength (FACT > INFERENCE > UNVERIFIED), 20% ICP fit (pgvector cosine distance), 15% lead seniority match (C-Level > VP > Director > Manager, buying roles > support roles).
- `WHY_NOW`: justificativas por tipo de sinal — hiring → "empresa está expandindo o time", funding → "rodada recente libera orçamento para novas ferramentas", etc.
- Ações recomendadas: templates por tipo de sinal e canal (linkedin connect/message, email, whatsapp, manual task), interpoladas com nome do lead, empresa e título do sinal.
- `DecisionService` consulta PostgreSQL (`intent_signals`, `company_evidence`, `companies` com pgvector) e delega ao engine determinístico.
- Tool MCP `gtm_evaluate_opportunity` aceita `lead_id`, `company_id` ou todos os leads ativos; retorna `OpportunityScore[]` com score, urgência, fatores, WHY_NOW e ações.
- Reusa `signalRecencyFactor` e `isActiveSignal` de S2. Não depende de LLM, credenciais externas ou filas.

### 3.12. Channel Abstraction Protocol (S4)
- Substitui o `ChannelType` rígido (enum Prisma de 4 valores) por uma abstração de capabilities.
- `ChannelId` (`linkedin`, `email`, `whatsapp`, `manual`) — identificadores abertos, não vinculados ao enum do banco.
- `ChannelCapability` (`connect`, `sendMessage`, `readMessages`, `searchProfiles`, `followUp`, `verifyDelivery`) — o que cada canal pode fazer automaticamente.
- `ChannelProfile` — limites operacionais por canal: `defaultDailyLimit`, `requiresAuth`, `requiresBrowser`, `supportedActions`, `rateLimitWindowMs`, `safetyPauseMs`.
- `ChannelRegistry` — mapeia `ChannelId → ChannelProfile`, expõe `can(channel, capability): boolean` e `getProfile(channel)`.
- `buildRecommendedActions` filtra ações por `ChannelRegistry.can(channel, capability)` antes de sugerir.
- `applyAntiBanPolicy` usa `ChannelProfile.safetyPauseMs` do registry em vez de constantes hardcoded.
- Migration aditiva (`6_sprint4_channel_abstraction`): adiciona `channel_id` (VARCHAR) a `outreach_accounts` e `outreach_messages` com backfill dos valores legados. `channel` (enum) e `channel_id` coexistem.
- `legacyChannelToChannelId` garante compatibilidade retroativa: `LINKEDIN_CONNECT`/`LINKEDIN_MESSAGE` → `linkedin`, `EMAIL` → `email`, `MANUAL_TASK` → `manual`.
- MCP schema `OutreachChannelSchema` aceita valores legados e novos (`linkedin`, `email`, `whatsapp`, `manual`).
- 16 testes unitários cobrindo registry, capabilities, legacy mapping e anti-ban com profiles.

### 3.13. Browser Execution Protocol (S5) — `src/core/execution/`
- **ChannelAdapter**: contrato que todo adaptador de canal implementa (`execute`, `canHandle`). Cada adapter mapeia capabilities para comandos reais.
- **ExecutionContext**: dados necessários para executar uma ação — lead, company, account (com credenciais/session), message, dryRun.
- **ExecutionResult**: resultado padronizado — `success`, `externalId`, `error`, `retryable`, `rateLimitHit`, `channelPausedUntil`.
- **ExecutionRouter**: recebe `RecommendedAction`, seleciona o `ChannelAdapter` pelo `ChannelId`, valida capability no `ChannelRegistry`, chama `execute`.
- **LinkedInAdapter**: usa a extensão Antigravity (bridge HTTP `127.0.0.1:8765`) como único meio de comunicação com o LinkedIn. Health check obrigatório antes de qualquer ação. Mapeia capabilities para comandos (`connect → POST /linkedin/connect`, `sendMessage → POST /linkedin/message`, `searchProfiles → POST /linkedin/search`, `readMessages → GET /linkedin/inbox`).
- **AntigravityClient**: cliente HTTP tipado com timeout (30s ações, 5s health), retry (até 2 tentativas com backoff 2s/4s), classificação de erros (`ECONNREFUSED → retryable`, `429/CAPTCHA → rateLimitHit + pausa 48h`, `403 → permanent`).
- **Stub adapters**: `EmailAdapter`, `WhatsAppAdapter` retornam `NOT_IMPLEMENTED`; `ManualAdapter` retorna sucesso para `followUp`.
- **Dispatcher Worker** (`createDispatcherWorker`): BullMQ worker que consome `outreach_dispatcher_queue`. Busca `OutreachSequence` com `status=ACTIVE`, para cada lead pendente monta `ExecutionContext`, aplica `applyAntiBanPolicy`, chama `executionRouter.execute()` com delay humano gaussiano entre ações. Graceful degradation: se Redis indisponível, worker não inicia mas sistema continua operando.
- **Regra GLOBAL**: NUNCA usar Playwright/Puppeteer/Selenium/Chrome DevTools MCP. Sempre pela extensão Antigravity.
- 42 testes unitários cobrindo: AntigravityClient (health check, retry, timeout, classificação 429/403/CAPTCHA), LinkedInAdapter (dryRun, health fail, sem LinkedIn URL, rate limit, 403, success), ExecutionRouter (rotas, canal desconhecido, capability não suportada), stub adapters e anti-ban integration.
