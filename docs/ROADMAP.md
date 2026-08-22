# Roadmap Detalhado de Execução — LookaBerry

> **Última atualização**: 2026-08-22 · **Commit**: S6 complete, 172 tests, autonomous loop operational

---

## 1. Visão Geral

Este roadmap é estruturado para permitir que desenvolvedores ou agentes de IA (Cursor, Claude Code, Codex, Antigravity) implementem o LookaBerry de forma estritamente modular e incremental.

Ao final de **cada Sprint**, o sistema possui um conjunto utilizável e testável de ferramentas expostas via **MCP Server**.

---

## 2. Sprints de Execução (S1–S6 ✅ Concluídos)

### Sprint 1: Fundação do Core, Banco Vetorial e MCP Server Base `[✅ CONCLUÍDO]`
- PostgreSQL 16 + pgvector + HNSW indexes
- Fastify API + MCP Server (stdio + SSE)
- LookaCrawler engine (>70% token savings)
- Tool: `gtm_analyze_icp`
- **Testes**: unitários + smoke test

---

### Sprint 2: Intent Intelligence 2.0 `[✅ CONCLUÍDO]`
- Contrato `SignalProvider` (coleta, normalização, classificação, confiança, scoring)
- Providers: websiteChanges, hiring, publicAnnouncements, credentialedFunding
- Scoring SQL determinístico por recência/TTL, confiança, qualidade, tipo, classificação
- Reuso de `Source` e `CompanyEvidence` da S1
- Tools: `gtm_detect_intent_signals`, `gtm_score_and_rank_leads`
- **Testes**: 39 testes unitários

---

### Sprint 3: Waterfall Enrichment `[✅ CONCLUÍDO]`
- Cascata: Cache → Apollo → Dropcontact → MX/ZeroBounce
- Workers BullMQ com concorrência 5, limite 10 jobs/s, 3 tentativas + backoff
- Tool: `gtm_waterfall_enrich_lead`

---

### Sprint 4: Hiper-Personalização com Prompt Caching `[✅ CONCLUÍDO]`
- Template engine com sinal ativo + cargo do lead + ICP value matrix
- Prompt Caching Anthropic (`cache_control: ephemeral`)
- Guardrails anti-spam e limites por canal
- Tool: `gtm_generate_hyper_personalized_message`

---

### Sprint 5: Dispatcher Multicanal e Anti-Ban Engine `[✅ CONCLUÍDO]`
- Máquina de estados de cadência multicanal
- Anti-Ban: quotas diárias, jitter gaussiano (45–210s), pausa 48h em CAPTCHA/429
- Tool: `gtm_schedule_outreach_sequence`

---

### Sprint 6: Analytics, Feedback Loop e Loop Autônomo `[✅ CONCLUÍDO]`

#### 6a. Analytics & Closed-Loop Feedback
- Handlers de webhooks (OPEN, CLICK, REPLY, BOUNCE)
- Classificação de sentimento via Haiku (ou heurística keyword-based offline)
- Ajuste de peso do sinal ±5 pontos (limitado 0–100)
- Pausa automática de sequências em replies
- Tools: `gtm_track_campaign_metrics`, `gtm_record_lead_interaction_feedback`

#### 6b. Autonomous Outreach Loop (NOVO)
- **SequenceScheduler** (`src/core/execution/scheduler.ts`): polling interno (60s default), encontra sequências ACTIVE com `nextRunAt <= NOW`, enfileira no BullMQ, graceful degradation
- **InboxWorker** (`src/core/execution/inboxWorker.ts`): worker BullMQ em `outreach_inbox_queue`, lê inbox LinkedIn via Antigravity, classifica sentimento, cria feedback, atualiza Lead/Message, pausa sequências, ajusta pesos
- **FeedbackLoop** (`src/core/execution/feedbackLoop.ts`): agendamento de verificação de entrega (24h delay), `verifyDelivery` capability, ajuste de weight ±5
- **Dispatcher fix**: processa UM step por vez (`sequence.steps[nextStep]`), `nextRunAt = NOW() + currentStep.delayHours`, integração com feedback loop pós-envio

**O loop completo**: scheduler → dispatcher (step 0) → scheduler (step 1 após delay) → inbox worker (detecta reply) → feedback loop (ajusta scores)

---

## 3. GTM Brain 2.0 (Addendum S1–S5 ✅ Concluídos)

### S1: Entity + Evidence Graph `[✅ CONCLUÍDO]`
- `Source`, `Person`, `Identity`, `CompanyEvidence`, `PersonEvidence`, `Observation`, `Relationship`, `Interaction`
- Classificação: `FACT`, `INFERENCE`, `LLM_INFERENCE`, `USER_PROVIDED`, `UNVERIFIED`
- Sanitização de dados sensíveis, hash SHA-256, TTL opcional
- Migration: `4_sprint1_entity_evidence_graph`

### S2: Intent Providers 2.0 `[✅ CONCLUÍDO]`
- Contrato `SignalProvider` implementado com runner
- Provider de funding API como fronteira explícita (`REQUIRES_CREDENTIALS`)
- Normalização, TTL, confiança, classificação, custo, hash, deduplicação
- Documentação: `docs/INTENT_PROVIDERS.md`

### S3: Decision & Reasoning Engine `[✅ CONCLUÍDO]`
- `DecisionEngine` determinístico (sem LLM)
- Pipeline: signal score (40%) + evidence strength (25%) + ICP fit (20%) + lead seniority match (15%)
- Urgency (`HIGH`/`MEDIUM`/`LOW`), `WHY_NOW`, `RecommendedAction`
- `DecisionFactor` com nome, contribuição, evidência de suporte
- Tool: `gtm_evaluate_opportunity`
- 31 testes unitários

### S4: Channel Abstraction Protocol `[✅ CONCLUÍDO]`
- `ChannelId`: `linkedin`, `email`, `whatsapp`, `manual` (aberto, não vinculado ao enum Prisma)
- `ChannelCapability`: `connect`, `sendMessage`, `readMessages`, `searchProfiles`, `followUp`, `verifyDelivery`
- `ChannelProfile`: `defaultDailyLimit`, `requiresAuth`, `requiresBrowser`, `supportedActions`, `rateLimitWindowMs`, `safetyPauseMs`
- `ChannelRegistry`: `can(channel, capability)`, `getProfile(channel)`
- Migration aditiva: `channel_id` VARCHAR em `outreach_accounts` e `outreach_messages`
- `legacyChannelToChannelId` para compatibilidade retroativa
- 16 testes unitários

### S5: Browser Execution Protocol `[✅ CONCLUÍDO]`
- `ChannelAdapter` contract → `LinkedInAdapter`, `EmailAdapter`, `WhatsAppAdapter`, `ManualAdapter`
- `ExecutionContext`, `ExecutionResult` tipados
- `ExecutionRouter`: `RecommendedAction` → `ChannelAdapter.execute()`
- `AntigravityClient`: HTTP client tipado (timeout 30s ações, 5s health), retry (2x, backoff 2s/4s), classificação de erros
- `LinkedInAdapter`: health check obrigatório, mapeamento de capabilities para endpoints da bridge
- Dispatcher worker: `outreach_dispatcher_queue`, delay humano gaussiano, anti-ban guardrails
- **Regra GLOBAL**: LinkedIn sempre via extensão Antigravity (bridge 127.0.0.1:8765)
- 42 testes unitários

---

## 4. Próximos Passos — Sprints Planejados

### Sprint 7: Authentication, Rate Limiting & Security Hardening `[🔜 PLANEJADO]`
- **Objetivo**: Tornar o sistema production-ready com segurança em todas as camadas.
- **Escopo**:
  - Autenticação via API keys com middleware Fastify
  - Rate limiting por key/IP (usando Redis)
  - Validação de assinatura HMAC em webhooks de outreach
  - Idempotência nos endpoints de webhook
  - CORS restrito por domínio
  - Secrets via variáveis de ambiente (nunca hardcoded)
  - Auditoria de acesso (logs estruturados)
- **Tools MCP**: sem novas tools — hardening das existentes
- **Testes**: middleware tests, rate limit tests, webhook signature tests
- **Complexidade**: Média (3 dias)

### Sprint 8: Email Execution (Smartlead/Resend SMTP) `[🔜 PLANEJADO]`
- **Objetivo**: Substituir o stub `EmailAdapter` (`NOT_IMPLEMENTED`) por envio real de email.
- **Escopo**:
  - `EmailAdapter` real com SMTP/API (Smartlead, Resend, SendGrid)
  - Template rendering com variáveis do lead
  - Tracking de open/click/bounce via webhooks dos provedores
  - Mapeamento de eventos do provedor → contrato interno de webhook
  - Retry e bounce handling
- **Tool MCP**: `gtm_send_email` (opcional — integrado ao dispatcher)
- **Complexidade**: Alta (5 dias)

### Sprint 9: WhatsApp Execution & Multi-Account LinkedIn `[🔜 PLANEJADO]`
- **Objetivo**: Substituir stub `WhatsAppAdapter` e adicionar rotação de contas LinkedIn.
- **Escopo**:
  - `WhatsAppAdapter` real via WhatsApp Business API
  - Multi-account LinkedIn: `OutreachAccount.sessionKey` → rotacionar entre contas
  - Session management (criação, refresh, invalidação)
  - Detecção de conta bloqueada e failover automático
  - Quota tracking por conta (não só por canal)
- **Tool MCP**: `gtm_send_whatsapp` (opcional)
- **Complexidade**: Alta (5 dias)

### Sprint 10: Ops Dashboard, Real-Time Monitoring & Alerting `[🔜 PLANEJADO]`
- **Objetivo**: Visibilidade operacional completa do motor autônomo.
- **Escopo**:
  - Dashboard web (React/Vite) com métricas em tempo real
  - Monitoramento de filas BullMQ (jobs pendentes, falhos, latência)
  - Status das contas de outreach (quotas, pausas, health)
  - Alertas: conta bloqueada, quota excedida, fila parada
  - Histórico de execução de sequências
  - Export de métricas (CSV/JSON)
- **Complexidade**: Média (4 dias)

---

## 5. Horizontes Futuros (Pós-S10)

| Horizonte | Descrição | Complexidade |
| :--- | :--- | :---: |
| **Multi-tenant SaaS** | Isolamento de dados por organização, billing, onboarding | Muito Alta |
| **AI Copilot Chat** | Interface conversacional para configurar campanhas e analisar resultados via LLM | Média |
| **CRM Integrations** | Salesforce, HubSpot, Pipedrive — sync bidirecional de leads e atividades | Alta |
| **Advanced RL** | Aprendizado por reforço real: A/B testing automático de templates, timing e canais | Muito Alta |
| **Compliance Suite** | GDPR, LGPD, CAN-SPAM compliance automation, consent management | Média |