# Status de Implementação — LookaBerry

> **Data**: 2026-11-21 · **Base**: `origin/main` `23e150a` + branch `feat/p2-gtm-wiring` · **Testes**: 730 passando (708 unit em 43 arquivos + 22 de integração em 7 arquivos), medido com `vitest run` contra Postgres 16/pgvector + Redis 7 locais · `tsc --noEmit` limpo.
> O CI (`.github/workflows/ci.yml`) roda `tsc --noEmit` e só `vitest run tests/unit`; a integração precisa de Postgres + Redis.

## Classificações

| Status | Significado |
| :--- | :--- |
| **IMPLEMENTED** | Funciona de ponta a ponta e tem teste. |
| **REQUIRES CREDENTIALS** | Implementado, inerte sem chave/conta configurada. |
| **BETA** | Funciona, mas sem uso real suficiente para chamar de estável. |
| **ORPHAN** | Existe, mas nada no código chama (ver seção 2). |

---

## 1. Módulos core

| Módulo | Arquivo | Status | Nota |
| :--- | :--- | :--- | :--- |
| ICP Profiler | `src/core/icp/*` | **IMPLEMENTED** | Scraper em cascata (LookaCrawler → nativo → Jina → cheerio). `LLM_MODE=agent` (padrão) devolve o brief para o agente; `server` usa Anthropic ou endpoint OpenAI-compatível. |
| Embeddings | `src/core/icp/embeddings.ts` | **IMPLEMENTED** | Padrão `lexical-v2` (mapa de conceitos pt/en, sem chave). Endpoint OpenAI-compatível ou OpenAI opcional. |
| Intent signals | `src/core/intent/*` | **IMPLEMENTED** | Providers website, hiring, anúncios públicos, funding com credencial, CUSTOMER_LOSS (reviews de negócios locais). |
| Scoring / Decision Engine | `src/core/intent/scoring.ts`, `src/core/decision/*` | **IMPLEMENTED** | Determinístico, 0 tokens. |
| Evidence graph | `src/core/evidence/*` | **IMPLEMENTED** | Source, Person, Identity, evidências com TTL/confiança/hash. |
| Waterfall enrichment | `src/core/enrichment/service.ts` | **REQUIRES CREDENTIALS** | Cache → Apollo → Dropcontact → MX/ZeroBounce. Só roda via MCP `gtm_waterfall_enrich_lead`; nada no código enfileira na `waterfall_enrichment_queue` (seção 2). |
| Lead delivery (gate de verificação) | `src/core/delivery/*`, `src/core/verification/*` | **IMPLEMENTED** | Contato com 2 confirmações independentes, dossiê do site, fatos com fonte, abordagens com anti-slop. |
| UK PECR | `src/core/verification/companiesHouse.ts` | **IMPLEMENTED** | Dentro de `gtm_build_lead_delivery`: lead UK (país, domínio `.uk`, telefone +44 ou localização) só passa se a empresa for Ltd/PLC/LLP ativa e confirmada na Companies House (número no site com nome compatível, ou nome exato + mesmo distrito postal). Sole trader, homônima, outro tipo, dissolvida ou consulta fora do ar → `rejected` com `pecr.status` e `pecr.reason`. Consulta sem chave no site público (~1,6 req/s). |
| Personalização | `src/core/personalization/*` | **IMPLEMENTED** | Guardrails + anti-slop. Gera rascunho no modo agent; no servidor precisa de LLM configurado. |
| Outreach / cadências | `src/core/outreach/*`, `src/core/execution/*` | **IMPLEMENTED** | Scheduler de 60 s, dispatcher, branching, A/B, smart scheduling, cadence governor, DLQ, idempotência, locking. |
| Analytics / aprendizado | `src/core/analytics/*`, `src/core/learning/*` | **IMPLEMENTED** | Métricas, eventos em `POST /api/v1/events`, centroides lookalike de hora em hora. |
| Segurança e governança | `src/core/security/*` | **IMPLEMENTED** | API keys com papéis, rate limit, assinatura de webhooks, filtro de IP, TOTP, supressão, retenção/anonimização, guarda de SSRF. |

## 2. Filas e workers (BullMQ)

| Fila | Produtor | Worker | Status |
| :--- | :--- | :--- | :--- |
| `outreach_dispatcher_queue` | outreach service, scheduler, scheduleWorker, feedbackLoop | `dispatcher` | **IMPLEMENTED** |
| `icp_analysis_queue` | nenhum | `icpWorker` | **ORPHAN** (a análise roda direto pela API/MCP) |
| `waterfall_enrichment_queue` | nenhum | `enrichmentWorker` | **ORPHAN** (o enrichment roda direto pelo MCP) |
| `outreach_inbox_queue` | nenhum | `inboxWorker` | **ORPHAN** (o worker sobe no boot, mas nada agenda leitura do inbox) |
| ~~`signal_ingestion_queue`~~ | — | — | Removida em 2026-11-21: não tinha produtor nem worker. |

`tests/unit/queues-no-orphans.test.ts` falha se surgir fila nova sem produtor; as três órfãs acima estão listadas lá como dívida conhecida.

## 3. Canais

| Canal | Status | Detalhe |
| :--- | :--- | :--- |
| Email (Resend / SMTP) | **IMPLEMENTED** | Tracking, webhooks, bounce. Ainda sem header `List-Unsubscribe` nem rodapé do remetente (o opt-out é tratado pelas respostas). |
| WhatsApp (Cloud API) | **BETA** · **REQUIRES CREDENTIALS** | `src/core/execution/adapters/whatsapp.ts`, MCP `gtm_send_whatsapp`, webhook próprio. |
| LinkedIn | **IMPLEMENTED** | Via bridge da extensão Antigravity (`127.0.0.1:8765`). |
| Manual | **IMPLEMENTED** | `ManualAdapter`. |

## 4. Interfaces

| Item | Status | Nota |
| :--- | :--- | :--- |
| MCP (stdio + SSE) | **IMPLEMENTED** | 12 tools: `gtm_analyze_icp`, `gtm_detect_intent_signals`, `gtm_score_and_rank_leads`, `gtm_evaluate_opportunity`, `gtm_waterfall_enrich_lead`, `gtm_build_lead_delivery`, `gtm_generate_hyper_personalized_message`, `gtm_schedule_outreach_sequence`, `gtm_send_whatsapp`, `gtm_track_campaign_metrics`, `gtm_record_lead_interaction_feedback`, `gtm_insights`. |
| REST API | **IMPLEMENTED** | ICP, campanhas, admin, eventos, insights, health, webhooks (outreach, email, WhatsApp), tracking de email. Auth por API key. Swagger em `/docs`. |
| Dashboard de operação | **BETA** | `dashboard/` (Next.js). |

## 5. Dívida conhecida

| Item | Severidade | Nota |
| :--- | :---: | :--- |
| Três filas órfãs (seção 2) | 🟢 Medium | Os workers sobem no boot sem produtor. Ligar um produtor ou remover. |
| `prisma migrate deploy` falha num banco vazio | 🟡 High | `10_outreach_events` usa `suppression_type_enum`, que nenhuma migration cria, e as pastas `10_`/`11_` ordenam antes de `1_` (medido em 2026-11-21). Banco novo hoje só sobe com `prisma db push`. |
| Email sem `List-Unsubscribe` | 🟡 High | Necessário para envio frio em volume. |
| Companies House por scraping do site público | 🟢 Medium | Sem chave, ~1,6 req/s global. Se o HTML mudar, a consulta vira `UNAVAILABLE` e o lead UK é excluído (falha fechada). A API oficial com chave elimina isso. |
| Inbox reader com heurística por palavra-chave | 🟢 Medium | Sem classificador de modelo. |
