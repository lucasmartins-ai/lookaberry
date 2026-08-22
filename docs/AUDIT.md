# Auditoria S0 — LookaBerry (baseline antes da refatoração 2.0)

> **Data S0**: 2026-08-22 · **Branch**: `main` (`d1f4ddd`) · **Propósito**: baseline registrada antes da transformação em GTM Brain agent-first / channel-agnostic. A S1 adicionou apenas o modelo relacional de entidades/evidências; canais e decision engine continuam fora do escopo.

---

## 1. Resumo executivo

O repositório é pequeno (~188 KB em `src`, ~2.180 linhas TS) e bem estruturado para o estágio: serviços com injeção de dependência, contratos Zod, filas BullMQ e testes unitários sólidos. **O que existe é real e testado**: pipeline de ICP, ingestão de sinais, scoring híbrido no banco, waterfall enrichment, personalização com guardrails, agendamento de sequências e analytics com feedback loop. São 8 tools MCP registradas, API REST funcional e 2 workers BullMQ ativos.

**Porém, a documentação superestima o estado do sistema em pontos críticos**:

1. **Não existe camada de execução de canais.** Não há envio de e-mail, ação no LinkedIn, nem adaptadores Smartlead/Resend/Unipile — apesar de `ARCHITECTURE.md`, `ROADMAP.md` (Sprint 5) e `README.md` descreverem "disparos executados" e "integração com provedores". O que existe é **apenas agendamento** (persistência de sequência) + funções puras de anti-ban que **nunca são usadas** por nenhum dispatcher.
2. **O ranking híbrido "zero tokens" é semanticamente vazio sem `OPENAI_API_KEY`.** O fallback `generateDeterministicEmbedding` gera vetores pseudo-aleatórios derivados de SHA-256: a similaridade de cosseno entre duas empresas diferentes é ruído. Mecanicamente funciona; semanticamente não.
3. **O beta test exibido no README usa um gerador de mensagens mock (hardcoded)** e scores preenchidos manualmente — o log "Live Beta Test" não representa execução real de modelo nem de ranking.
4. **Mecanismos de compliance documentados não existem no código**: `global_suppression_list`, endpoint `/v1/leads/{id}/anonymize`, proxy residencial, inbox rotation, cache Redis de scraping.
5. **Não há autenticação nem rate limiting** em nenhum endpoint (o diagrama de `ARCHITECTURE.md` mostra uma camada "API Key & Rate Limiter" que não foi implementada).
6. **Há drift entre migration e schema Prisma** na coluna `total_priority_score` (GENERATED na migration vs. coluna comum no schema).

O caminho para a visão 2.0 (agentes, canais, browser extension) parte desta baseline com dívidas claras, mas sem bloqueios estruturais graves: o acoplamento a `LINKEDIN`/`EMAIL` está concentrado em ~5 arquivos (`schema.prisma`, schemas/tools de outreach, personalização, service de outreach) e é contido.

---

## 2. Baseline de verificação executada

| Comando | Resultado | Observação |
| :--- | :--- | :--- |
| `npm test` | **22 passed · 3 failed · 2 skipped** (27) | As 3 falhas são **exclusivamente ambientais**: PostgreSQL `127.0.0.1:5433` e Redis `6379` fora do ar (Docker indisponível neste ambiente). `db.test.ts` pula 2 testes porque o `beforeAll` (`initVectorExtension`) não conecta. |
| `npx tsc --noEmit` | ✅ exit 0 | Typecheck limpo. |
| `npm run build` | ✅ exit 0 | Build `tsc` limpo. |
| lint | ⚠️ **não configurado** | Não existe script `lint`, nem ESLint/Prettier/Biome no repo. |
| `npm run test:smoke` / `npm run test:beta` | ⏸️ não executados | Exigem DB + Redis ativos (não disponíveis). Ver §5.7. |

**Veredito S0**: critério de conclusão atendido com ressalva documentada — suíte verde naquilo que não depende de infra; falhas restantes são ambientais e pré-existentes, não regressões de código.

---

## 3. Inventário do repositório

```
src/  (2.180 linhas TS)
├── index.ts                  Bootstrap: pgvector → workers → Fastify + MCP SSE
├── config/env.ts             Zod env (12 variáveis)
├── db/                       Prisma singleton + helpers pgvector (HNSW)
├── core/
│   ├── icp/                  scraper.ts (210) · analyzer.ts (228) · embeddings.ts (61) · service.ts (110)
│   ├── intent/service.ts     193  — ingestão de sinais + scoring híbrido SQL
│   ├── enrichment/service.ts 179  — waterfall Apollo→Dropcontact→MX/ZeroBounce
│   ├── personalization/…     80   — gerador com guardrails + prompt caching
│   ├── outreach/service.ts   125  — agendamento de sequência + funções puras anti-ban
│   ├── analytics/service.ts  138  — feedback loop, métricas, sentimento Haiku
│   └── queues/               queue.ts (4 filas) + workers (icp, enrichment)
├── mcp/
│   ├── server.ts             Registra as 8 tools
│   ├── schemas/              7 arquivos Zod (icp, intent, enrichment, personalization, outreach, analytics, webhooks)
│   ├── tools/                8 tools
│   └── transports/stdio.ts   stdio (bin lookaberry-mcp)
└── api/
    ├── server.ts             Fastify + CORS(*) + Swagger
    └── routes/               health · icp (POST /analyze, GET /:id) · mcpSse (/sse, /messages) · webhooks
prisma/
├── schema.prisma             352 linhas · 14 models · 6 enums
└── migrations/               0_init · 1_sprint2_intent_indexes · 2_sprint5_outreach · 3_sprint6_analytics
tests/
├── unit/                     8 arquivos · 21 testes ✅
├── integration/              mcp · db · api (exigem infra)
├── mcp-client-smoke.ts       demo script (exige infra)
└── beta-test-account.ts      demo script com gerador mock (exige infra)
docs/                         6 docs rastreados + artefatos pessoais gitignored (CV_*, CAMPAIGN_*, GTM_*, *.pdf)
```

Git: 3 commits; `.gitignore` modificado (não commitado) adicionando artefatos pessoais; `.freebuff/` untracked (metadata do agente). `dist/` e `node_modules/` ignorados. Nada de `dist` versionado.

---

## 4. Discrepâncias: documentação vs. código real

### 4.1 `docs/ARCHITECTURE.md`

| Documentado | Real | Severidade |
| :--- | :--- | :---: |
| `src/core/signals/` e `src/core/scoring/` | Tudo em `src/core/intent/service.ts` | Baixa (paths obsoletos) |
| Camada "Auth — API Key & Rate Limiter (Token Bucket)" no diagrama | **Não existe** auth nem rate limit em lugar nenhum | **Alta** |
| "LinkedIn Execution (Unipile / Isolated Headless Puppeteer)" | Nenhum código de execução; só agendamento | **Alta** |
| "Email Execution (Smartlead / Instantly / Resend)" | **Não existe**; nenhum envio | **Alta** |
| Filas `Q_Signal`, `Q_Outreach`, `Q_Sync` (webhook/CRM sync) | `signalQueue` e `outreachQueue` criadas mas **nunca usadas**; sem fila de sync | **Alta** |
| "Catálogo estrito de 8 tools" | ✅ correto (8 registradas) | — |
| Waterfall: cache → Apollo → Dropcontact → MX/ZeroBounce | ✅ implementado (Apollo/Dropcontact no-op sem chave; ZeroBounce só com chave) | — |

### 4.2 `docs/DATA_MODEL.md`

| Documentado | Real | Severidade |
| :--- | :--- | :---: |
| `total_priority_score` como `GENERATED ALWAYS AS (icp_score*0.4 + intent_score*0.6) STORED` | Migration `0_init` cria GENERATED, mas `schema.prisma` define coluna comum `Decimal?` sem default → **drift migration×schema**; seed grava o valor (falharia em DB gerado por migration) | **Alta** |
| Índices HNSW como parte do schema | Criados em runtime por `initVectorExtension()` no bootstrap; **não estão nas migrations** (deploy só com migrate fica sem índices até o app subir) | Média |
| Query exemplar de ranking | ✅ essencialmente fiel à implementação (`scoreAndRankLeads`) | — |

### 4.3 `docs/MCP_TOOLS.md`

| Documentado | Real | Severidade |
| :--- | :--- | :---: |
| Tool 8 `gtm_record_lead_interaction_feedback`: `required: [message_id, reply_body]` | Schema real: `message_id` opcional, **não existe `reply_body`**; campo é `content` opcional | Média |
| Tool 8 output `feedbackId` (camelCase) | Real: `feedback_id` → output `feedbackId` no service; contrato inconsistente entre doc/schema | Baixa |
| Tool 5 channel enum | ✅ bate (LINKEDIN_CONNECT/MESSAGE/EMAIL) | — |
| Tool 2 `signal_types` enum | ✅ bate (5 tipos) | — |

### 4.4 `docs/ROADMAP.md` (Sprints 1–6)

| Sprint | Status documentado | Real | Severidade |
| :--- | :--- | :--- | :---: |
| 1 Fundação/MCP | ✅ CONCLUÍDO | ✅ Verdadeiro | — |
| 2 Sinais + scoring | ✅ IMPLEMENTADO/TESTADO | ⚠️ Verdadeiro, com ressalva: scoring semântico depende de `OPENAI_API_KEY`; sem chave é hash-determinístico (ruído) | Média |
| 3 Waterfall | ✅ IMPLEMENTADO/TESTADO | ✅ Verdadeiro (provedores autenticados exigem chaves) | — |
| 4 Personalização | ✅ IMPLEMENTADO/TESTADO | ✅ Verdadeiro (cache hit real não verificado) | — |
| 5 Dispatcher + Anti-Ban | ✅ "Disparos agendados e **executados**" + "Integração com Smartlead/Resend e Unipile API" | ⚠️ **Só agendamento.** Sem disparo, sem adaptadores de provedor. Anti-ban são funções puras nunca invocadas por worker. O próprio doc admite em "Limite conhecido", mas o status geral superestima | **Alta** |
| 6 Analytics | ✅ IMPLEMENTADO/TESTADO | ✅ Verdadeiro (webhook sem assinatura — o doc admite) | — |

### 4.5 `docs/SECURITY_COMPLIANCE.md`

| Documentado | Real | Severidade |
| :--- | :--- | :---: |
| `global_suppression_list` + descadastro por análise léxica | **Não existe** tabela nem código (nenhum grep em `src/`/`prisma/`) | **Alta** |
| Endpoint `/v1/leads/{id}/anonymize` (direito ao esquecimento) | **Não existe** rota | **Alta** |
| "Circuit Breaker Automático… quarentena de 48h no Redis" | `applyAntiBanPolicy` retorna `pausedUntil`, mas **nada persiste no Redis/DB** e nenhum dispatcher consome | Média |
| Proxy residencial dedicado / isolamento de IP | **Não implementado** | Média (planejado p/ extensão) |
| Inbox rotation | **Não implementado** | Média |
| Jitter gaussiano 45–210s | ✅ `sampleHumanDelaySeconds` (função pura testada) | — |
| Spam trigger words guard | ✅ `BANNED_TERMS` em personalization | — |
| ZeroBounce / preflight MX | ✅ verifier condicional + MX default | — |
| Assinatura de webhook (Smartlead/Resend/Unipile) | Doc admite que **não** é validada — correto | — |

### 4.6 `docs/TOKEN_OPTIMIZATION.md`

| Documentado | Real | Severidade |
| :--- | :--- | :---: |
| "Cache de Dois Níveis L1 Redis + L2 PostgreSQL" — scraping em cache 7 dias | L1 Redis **não existe** (Redis só é usado por BullMQ). L2 ✅ (cache de e-mails no enrichment) | Média |
| "Embeddings-First Filtering" semântico | Degradado sem `OPENAI_API_KEY` (fallback determinístico = ruído) | **Alta** |
| Model cascading / prompt caching | ✅ implementado (tiering respeitado na prática; caching via `cache_control`) | — |

### 4.7 `README.md`

| Documentado | Real | Severidade |
| :--- | :--- | :---: |
| "27 passing tests" | 22 pass · 3 fail (ambiental) · 2 skip | Média |
| "Live Beta Test Execution Log" com mensagens "geradas por modelo" | `tests/beta-test-account.ts` usa `mockGenerator` hardcoded e scores manuais (`icpScore: 92`, etc.) | **Alta** |
| Links para `file:///Users/Master/LookaBerry/...` | Paths absolutos da máquina do autor | Baixa |

---

## 5. Dívida técnica e pontos frágeis

### 5.1 Schema e migrações
- **Resolvido na S1**: `total_priority_score` foi convertido de GENERATED para coluna comum pela migration `4_sprint1_entity_evidence_graph`, alinhando migration, schema Prisma e seed. O ranking continua calculado explicitamente no SQL.
- `ChannelType` (enum de 4 valores) acopla **canal × ação** em `sequence_steps.channel`, `outreach_messages.channel`, `outreach_accounts.channel`. Impossível expressar "Instagram: MESSAGE" sem estourar o enum.
- `campaigns.daily_limit_linkedin` / `daily_limit_email`: limites por canal cravados como colunas — não extensível a novos canais.
- `OutreachAccount.sessionKey` armazenado em texto plano.
- `intent_signals.signal_type` é `VARCHAR(100)` livre no banco, mas o Zod só aceita 5 valores — o schema Zod é mais restrito que o banco.
- Sem chaves de idempotência em nenhuma tabela (webhook reentregue = métricas duplicadas).
- Sem conceito de tenant/workspace (single-tenant assumido — ok para v0.1, mas relevante para S12).
- Sem modelo de conversa/thread: replies viram eventos isolados em `lead_interaction_feedback`.

### 5.2 Código
- `signalQueue` e `outreachQueue` declaradas e **nunca usadas** (sem produtor/consumidor).
- `FIRECRAWL_API_KEY` declarada em `env.ts` e nunca lida.
- Dependências não utilizadas: `pg`, `zod-to-json-schema` (e types relacionados).
- `analyzer.ts` hardcoda `'claude-3-5-haiku-latest'` em vez de `config.ANTHROPIC_MODEL` (inconsistente com personalization).
- `analytics/service.ts` lê `process.env` diretamente em vez de `config` (inconsistente; quebra o princípio de config validada).
- `src/types/index.ts` é um barrel que re-exporta **valores em runtime** (schemas/services) — importar um type puxa dotenv + Prisma client (side effects).
- `applyAntiBanPolicy`: `isLinkedIn = channel !== 'EMAIL'` — `MANUAL_TASK` seria tratado como LinkedIn (edge case do enum atual).
- `scoreAndRankLeads`: `CROSS JOIN icp_profiles` (filtrado por `p.id`, mas varre todas as linhas).
- `getMetrics`: `sent` é contado de `outreachMessage` e somado a `sent_count` da tabela de métricas (que hoje nunca é incrementada) — risco de dupla contagem quando `sent_count` passar a ser populado.
- Personalization: limite de EMAIL é 800 chars no código vs. "120 words" no prompt estático — contrato interno inconsistente.

### 5.3 Testes
- Suíte unitária **boa** (21 testes, DI limpa) — base sólida para as próximas sprints.
- Testes de integração **não herméticos**: exigem DB/Redis reais (sem testcontainers/profile de CI), fazem **scraping de rede real** (`news.ycombinator.com`, `github.com`) e dependem do estado do banco — flaky e lentos (30s).
- Sem testes para: workers BullMQ, transporte MCP (stdio/SSE), rota de webhook, idempotência, rate limits, falha de provedor além do waterfall, retry/timeout.
- `db.test.ts`: `beforeAll` falha sem DB → 2 testes **skipped** (mascarados como "skip" em vez de falha).
- Smoke test: chama `gtm_generate_hyper_personalized_message` com `tone: 'DIRECT'` (inválido) e o `catch` imprime "guardrail validated" — **falso positivo**.
- Beta test: gerador mock + scores manuais → não valida modelo nem ranking reais.

### 5.4 Segurança
- **Zero autenticação** em API, MCP e webhooks; CORS `origin: '*'`; webhook sem assinatura → qualquer pessoa pode injetar eventos e corromper status de leads/métricas.
- Sem rate limiting (documentado como existente).
- Secrets: apenas env (ok); `sessionKey` de contas em plaintext no banco.
- Sem retention policy nem anonimização de PII (documentado como existente).
- `mcp.config.json` e `.cursor/mcp.json` apontam para `lookaberry:lookaberry_secret@localhost:5433` — **credenciais incompatíveis** com `docker-compose.yml` (`postgres:postgrespassword`) e `.env.example` (`postgres:postgrespassword@127.0.0.1:5433`). O "plug-and-play" MCP falharia a autenticação.

### 5.5 Observabilidade
- Apenas `console.log`/Fastify logger básico. Sem logs estruturados, sem métricas, sem tracing, sem tracking de custo além de `enrichment_logs.cost_credits`.

### 5.6 Dependências e infra
- Sem CI (GitHub Actions) — nada roda testes/typecheck/build automaticamente.
- `LOOKACRAWLER_URL` opcional; integração real com o repositório LookaCrawler (MCP `lookacrawler` em `mcp.config.json`) é externa a este repo e não é testada aqui.

### 5.7 Riscos de infraestrutura
- PostgreSQL (porta 5433) e Redis (6379) não estavam disponíveis na auditoria (Docker indisponível). Toda verificação de integração ficou pendente; **recomenda-se re-rodar `npm test` completo com `docker compose up -d` antes de iniciar a S1**.

---

## 6. Dependências/APIs não utilizadas

| Item | Onde | Status |
| :--- | :--- | :--- |
| `signalQueue` / `outreachQueue` | `src/core/queues/queue.ts` | Nunca usadas |
| `FIRECRAWL_API_KEY` | `src/config/env.ts` | Nunca lida |
| `pg`, `zod-to-json-schema` | `package.json` | Nunca importados |
| Rota `/api/v1/webhooks/outreach` | `src/api/routes/webhooks.ts` | Existe, mas nenhum provedor real a invoca |
| `OutreachAccount` | schema | Só usado em seed/beta test; sem worker de envio |
| `sessionKey` (LinkedIn) | schema | Nunca lida |

---

## 7. Riscos para o plano 2.0 (S1–S12)

1. **Começar S1 sem reconciliar o drift de migrations** propaga inconsistência para as novas tabelas de evidência.
2. **Basear decisões nos demo scripts** (beta/smoke) dá falsa sensação de completude — os scripts precisam virar testes honestos ou ser rotulados como demos.
3. **Ranking semântico é hoje opcional** (depende de OpenAI). A S2 (Intent Intelligence) deve manter o princípio "determinístico primeiro", mas com scoring honesto (ou documentar claramente o modo degradado).
4. **Refatoração de canais (S4)** toca enum + `Campaign` + `SequenceStep` + `OutreachMessage` + `OutreachAccount` + schemas/tools + testes — escopo contido (~5 arquivos + testes), viável.
5. **Ausência de auth/rate limit** torna arriscado expor qualquer endpoint novo (webhooks de extensão browser em S5/S8) antes da S12.
6. **Sem CI**, cada sprint depende de verificação manual — risco de regressão silenciosa entre sprints.
7. **Testes de integração frágeis** vão atrapalhar a exigência "sprint termina com testes passando" se não forem hermeticizados.

---

## 8. Estado após S1

- O modelo de entidades/evidências foi adicionado em `prisma/schema.prisma` e na migration `4_sprint1_entity_evidence_graph`.
- `src/core/evidence/service.ts` persiste `Source`, `Person`, `Identity`, evidências e relações, com classificação explícita e sanitização de payloads.
- `tests/unit/evidence.test.ts` passa; `tests/integration/evidence.test.ts` aguarda PostgreSQL disponível.
- A migration ainda precisa ser aplicada/validada contra um PostgreSQL real. O ambiente da auditoria não tinha Docker, PostgreSQL ou Redis ativos.

## 9. Recomendações remanescentes

1. Rodar a suíte completa com infra (`docker compose up -d && npm test`) e registrar o resultado verde como baseline.
2. Reconciliar migration × schema Prisma para `total_priority_score` (decisão: manter GENERATED ou coluna comum — **não misturar**).
3. Corrigir credenciais em `mcp.config.json` / `.cursor/mcp.json` para bater com `docker-compose.yml`.
4. Rotular `tests/beta-test-account.ts` e `tests/mcp-client-smoke.ts` como **demo scripts** (ou corrigir os falsos positivos) e parar de citá-los como prova de "8 tools operacionais".
5. Adicionar lint + CI (GitHub Actions) como parte da estabilização — barato e elimina o maior risco de regressão entre sprints.
6. Remover código morto de baixo risco (queues não usadas, deps não usadas) — ou documentar como intencional.
