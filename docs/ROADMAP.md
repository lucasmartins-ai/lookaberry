# Roadmap Detalhado de Execução (6 Sprints) — LookaBerry

---

## 1. Visão Geral

Este roadmap é estruturado para permitir que desenvolvedores ou agentes de IA (Cursor, Claude Code, Codex, Antigravity) implementem o LookaBerry de forma estritamente modular e incremental.

Ao final de **cada Sprint**, o sistema possui um conjunto utilizável e testável de ferramentas expostas via **MCP Server**.

---

## 2. Sprints de Execução

### Sprint 1: Fundação do Core, Banco Vetorial e MCP Server Base `[STATUS: ✅ CONCLUÍDO / OPERACIONAL]`
- **Objetivo**: Subir a infraestrutura básica, banco de dados vetorial com pgvector e o servidor MCP com a primeira ferramenta de ICP.
- **O que foi construído**:
  - Setup do projeto TypeScript com Fastify, Prisma ORM e BullMQ.
  - Setup do PostgreSQL 16 com extensão `pgvector` na porta 5433 e índices HNSW (`vector_cosine_ops`).
  - Servidor MCP base com suporte a transporte `stdio` e `SSE` (`/sse` e `/messages`).
  - Engine de Scraping com **LookaCrawler** (poda de ruído com >70% de economia de tokens + Readability + Turndown).
  - Tool MCP `gtm_analyze_icp` com scraping de website e geração de embeddings vetoriais (1536 dimensões).
  - Suíte de testes automatizados com Vitest e smoke test ponta-a-ponta com MCP Client oficial.
- **Tools MCP Ativas ao Final da Sprint**:
  - `gtm_analyze_icp` ✅
- **Critérios de Aceite (Done)**:
  - Servidor MCP conecta com sucesso no Claude Code / Cursor / Antigravity via `stdio` e `SSE`.
  - Passar uma URL válida gera o registro de ICP no banco com vetor indexado em HNSW.
- **Complexidade**: Média (3 dias).
- **Riscos Técnicos**: Variação na estrutura de websites $\rightarrow$ *Mitigação*: Sanitização prévia de Markdown via LookaCrawler / Jina / Readability.

---

### Sprint 2: Intent Intelligence 2.0 `[STATUS: ✅ IMPLEMENTADO / PERSISTÊNCIA PENDENTE DE EXECUÇÃO LOCAL]`
- **Objetivo**: Evoluir a ingestão legada para providers extensíveis e scoring determinístico com proveniência.
- **Implementado**:
  - Contrato `SignalProvider` separando coleta, normalização, classificação, confiança, persistência e scoring.
  - Providers locais para mudanças de website, hiring e anúncios públicos; funding API permanece `REQUIRES_CREDENTIALS`.
  - `IntentSignal` com provider, URL, observação, expiração, confiança, qualidade da fonte, classificação, dados normalizados/sanitizados, custo, hash e deduplicação.
  - Reuso de `Source` e `CompanyEvidence` da S1.
  - Scoring SQL determinístico por recência/TTL, confiança, qualidade, tipo, classificação, peso e duplicidade.
  - Compatibilidade aditiva das tools `gtm_detect_intent_signals` e `gtm_score_and_rank_leads`.
- **Testes**: providers válidos/indisponíveis, timeout, falha, partial failure, custo, TTL, classificação, deduplicação, ranking determinístico e contratos MCP.
- **Verificação pendente**: migration S2, persistência e ranking PostgreSQL não foram executados porque PostgreSQL `127.0.0.1:5433` e Redis `localhost:6379` não estavam disponíveis.
- **Limitação**: o fallback determinístico de embeddings é offline e não representa similaridade semântica sem `OPENAI_API_KEY`.
- **Documentação**: [INTENT_PROVIDERS.md](INTENT_PROVIDERS.md).
- **Complexidade**: Média-Alta.
- **Risco remanescente**: adapters pagos, crawl scheduling e workers de ingestão ainda não fazem parte desta sprint.

---

### Sprint 3: Waterfall Enrichment e Validação de Entregabilidade `[STATUS: ✅ IMPLEMENTADO / TESTADO]`
- **Objetivo**: Construir a esteira assíncrona de descoberta e validação de e-mails corporativos.
- **O que construir**:
  - Orquestrador em cascata com fallback (Cache Local $\rightarrow$ Apollo API $\rightarrow$ Dropcontact $\rightarrow$ ZeroBounce).
  - Workers assíncronos via BullMQ com concorrência 5, limite de 10 jobs/s, 3 tentativas e backoff exponencial.
  - Tool MCP `gtm_waterfall_enrich_lead`.
- **Tools MCP Ativas ao Final da Sprint**:
  - `gtm_analyze_icp`
  - `gtm_detect_intent_signals`
  - `gtm_score_and_rank_leads`
  - `gtm_waterfall_enrich_lead`
- **Critérios de Aceite (Done)**:
  - Leads enriquecidos possuem e-mail validado por MX/entregabilidade; cada tentativa e crédito consumido é auditado em `enrichment_logs`.
- **Complexidade**: Média-Alta (4 dias).
- **Riscos Técnicos**: Rate limits e timeouts de provedores $\rightarrow$ *Mitigação*: limite BullMQ, retries com backoff e fallback imediato. Os adaptadores HTTP autenticados dos provedores devem ser habilitados antes de produção.

---

### Sprint 4: Motor de Hiper-Personalização com Prompt Caching `[STATUS: ✅ IMPLEMENTADO / TESTADO]`
- **Objetivo**: Gerar mensagens de alta conversão sem clichês usando Prompt Caching da Anthropic.
- **O que construir**:
  - Template engine de sintetização de dor (Sinal Ativo + Cargo do Lead + ICP Value Matrix).
  - Integração com Anthropic Prompt Caching no SDK usando `cache_control: ephemeral` no prompt estático.
  - Guardrails sintáticos para bloquear palavras de spam, clichês de IA e mensagens acima do limite do canal.
  - Tool MCP `gtm_generate_hyper_personalized_message`.
- **Tools MCP Ativas ao Final da Sprint**:
  - `gtm_analyze_icp`
  - `gtm_detect_intent_signals`
  - `gtm_score_and_rank_leads`
  - `gtm_waterfall_enrich_lead`
  - `gtm_generate_hyper_personalized_message`
- **Critérios de Aceite (Done)**:
   - Mensagens contextuais usam payload dinâmico condensado e o prompt estático é enviado com cache control.
   - Mensagens sem sinal ativo, com termos bloqueados ou acima do limite do canal são rejeitadas.
   - Testes unitários cobrem geração, ausência de sinal e guardrails.
- **Complexidade**: Baixa-Média (2 dias).
- **Riscos Técnicos**: Alucinações sobre a empresa $\rightarrow$ *Mitigação*: Restrição estrita no prompt para usar apenas fatos contidos no payload do sinal.

#### Execução da Sprint 4
- **Implementado em**: `src/core/personalization/service.ts`, `src/mcp/schemas/personalization.ts` e `src/mcp/tools/personalization.ts`.
- **Integração**: Tool registrada em `src/mcp/server.ts`; modelo configurável por `ANTHROPIC_MODEL`.
- **Fonte de contexto**: lead, empresa e sinal ativo do banco; quando `signal_id` é omitido, seleciona o sinal ativo de maior peso.
- **Segurança de conteúdo**: prompt instrui uso exclusivo dos fatos recebidos; validação local bloqueia clichês/spam e limita o tamanho por canal.
- **Verificação**: `tests/unit/personalization.test.ts` cobre o contrato principal e os casos de rejeição.
- **Ponto operacional**: a taxa real de cache hit depende de chamadas autenticadas à Anthropic e deve ser observada pelo campo de uso retornado pela API em produção.

---

### Sprint 5: Dispatcher Multicanal, Sequências e Anti-Ban Engine `[STATUS: ✅ IMPLEMENTADO / TESTADO]`
- **Objetivo**: Executar sequências de outreach multicanal (LinkedIn + Email) com salvaguardas de segurança ativas.
- **O que construir**:
  - Máquina de estados de cadência multicanal (Conexão $\rightarrow$ Mensagem $\rightarrow$ Email $\rightarrow$ Follow-up).
  - Anti-Ban Engine para LinkedIn (limites diários, jitter gaussiano de 45-210s, isolamento de sessão).
  - Integração com Smartlead/Resend e Unipile API.
  - Tool MCP `gtm_schedule_outreach_sequence`.
- **Tools MCP Ativas ao Final da Sprint**:
  - `gtm_analyze_icp`
  - `gtm_detect_intent_signals`
  - `gtm_score_and_rank_leads`
  - `gtm_waterfall_enrich_lead`
  - `gtm_generate_hyper_personalized_message`
  - `gtm_schedule_outreach_sequence`
- **Critérios de Aceite (Done)**:
  - Disparos agendados e executados respeitando estritamente as cotas diárias de cada conta.
- **Complexidade**: Alta (4 dias).
- **Riscos Técnicos**: Bloqueios do LinkedIn $\rightarrow$ *Mitigação*: Pausa automática de 48 horas ao menor indício de captcha/erro 429.

#### Execução da Sprint 5
- **Persistência**: `OutreachSequence` mantém status (`ACTIVE`, `PAUSED`, `COMPLETED`), próximo passo, data de execução e leads associados. `OutreachAccount` mantém quota diária, contador, sessão e pausa.
- **Contrato MCP**: `gtm_schedule_outreach_sequence` valida de 2 a 12 etapas, exige ao menos uma etapa LinkedIn e uma etapa Email, limita a 1.000 leads e devolve o próximo horário de execução.
- **Segurança operacional**: quotas são avaliadas por canal; contas pausadas não disparam; CAPTCHA ou HTTP 429 em LinkedIn bloqueia a conta por 48 horas.
- **Código**: `src/core/outreach/service.ts`, `src/mcp/schemas/outreach.ts`, `src/mcp/tools/outreach.ts` e `prisma/migrations/2_sprint5_outreach/migration.sql`.
- **Verificação**: `tests/unit/outreach.test.ts` cobre agendamento, composição mínima da cadência, esgotamento de quota e pausa de 48 horas.
- **Limite conhecido**: Smartlead/Resend/Unipile exigem credenciais e endpoints configurados antes do disparo em produção; o agendamento não envia mensagens sem essa camada operacional.

---

### Sprint 6: Analytics, Loop de Feedback e Aprendizado Contínuo `[STATUS: ✅ IMPLEMENTADO / TESTADO]`
- **Objetivo**: Fechar o ciclo completo de GTM com tracking de engajamento e autoajuste de pesos.
- **O que construir**:
  - Handlers de webhooks para opens, clicks, replies e bounces.
  - Classificador de sentimento de respostas via LLM ultrarrápido (Haiku).
  - Algoritmo de retroalimentação de pesos dos sinais de intenção que mais convertem.
  - Tool MCP `gtm_track_campaign_metrics`.
  - Tool MCP `gtm_record_lead_interaction_feedback`.
- **Tools MCP Ativas ao Final da Sprint**:
  - **Catálogo Completo com as 8 Tools MCP Operacionais**.
- **Critérios de Aceite (Done)**:
  - Ao receber resposta do lead, a sequência é pausada automaticamente, o sentimento é classificado e as métricas de campanha são atualizadas em tempo real.
- **Complexidade**: Média (3 dias).
- **Riscos Técnicos**: Respostas ambíguas $\rightarrow$ *Mitigação*: Fallback para flag de revisão humana caso a confiança seja inferior a 85%.

#### Execução da Sprint 6
- **Persistência**: `CampaignMetric` agrega eventos por campanha e dia; `LeadInteractionFeedback` registra evento, sentimento, confiança, provedor e necessidade de revisão humana.
- **Webhooks**: `POST /api/v1/webhooks/outreach` recebe `OPEN`, `CLICK`, `REPLY` e `BOUNCE`, atualiza a mensagem e métricas de forma transacional.
- **Feedback de resposta**: replies são classificados com `claude-3-5-haiku-latest`; ausência de credencial, erro de parsing ou confiança abaixo de 85% resulta em `AMBIGUOUS`/revisão humana.
- **Aprendizado contínuo**: sinal associado a uma resposta positiva recebe +5 pontos e sinal associado a resposta negativa recebe -5, sempre limitado entre 0 e 100.
- **Automação**: resposta pausa sequências ativas do lead e atualiza seu status para `REPLIED_POSITIVE`, `REPLIED_NEGATIVE` ou `ENGAGED`; bounce marca `BOUNCED`.
- **Contrato MCP**: adicionadas `gtm_track_campaign_metrics` e `gtm_record_lead_interaction_feedback`, completando o catálogo de 8 tools.
- **Código**: `src/core/analytics/service.ts`, `src/api/routes/webhooks.ts`, schemas de analytics/webhook, tools MCP e `prisma/migrations/3_sprint6_analytics/migration.sql`.
- **Verificação**: `tests/unit/analytics.test.ts` cobre limites de peso, limiar de revisão humana e registro explícito de feedback.
- **Limite conhecido**: o payload do webhook é um contrato interno normalizado; adaptadores específicos de Smartlead, Resend e Unipile ainda precisam mapear seus formatos nativos.

---

## 3. Addendum GTM Brain 2.0

### S1: Entity + Evidence Graph `[STATUS: ✅ IMPLEMENTADO / PERSISTÊNCIA PENDENTE DE EXECUÇÃO LOCAL]`

- **Implementado**: `Source`, `Person`, `Identity`, `CompanyEvidence`, `PersonEvidence`, `Observation`, `Relationship` e `Interaction` no Prisma/PostgreSQL.
- **Compatibilidade**: `Lead.personId` conecta o modelo legado a `Person`; os campos existentes de lead não foram removidos.
- **Proveniência**: evidências exigem `sourceId`, `observedAt`, `confidence`, `classification`, dados normalizados e TTL opcional (`expiresAt`).
- **Classificação**: `FACT`, `INFERENCE`, `LLM_INFERENCE`, `USER_PROVIDED`, `UNVERIFIED`.
- **Proteção de dados**: `rawData` é sanitizado, campos sensíveis são redigidos e `contentHash` é calculado com SHA-256.
- **Reconciliação**: `total_priority_score` deixa de ser coluna gerada na migration S1 e passa a ser coluna comum, alinhada ao `schema.prisma` e ao seed. A fórmula de ranking continua no SQL do Intent Engine.
- **Código**: `src/core/evidence/service.ts`, `prisma/schema.prisma` e `prisma/migrations/4_sprint1_entity_evidence_graph/migration.sql`.
- **Testes**: `tests/unit/evidence.test.ts` cobre sanitização, confiança, hash e contrato de persistência; `tests/integration/evidence.test.ts` cobre o caminho PostgreSQL.
- **Verificação histórica da S1**: `prisma validate`, `prisma generate`, `npx tsc --noEmit` e `npm run build` passaram; a suíte unitária atual da S1/S2 tem 39 testes. O teste de persistência não foi executado porque PostgreSQL/Redis não estavam disponíveis.
- **Limitação real**: a migration S1 foi revisada para PostgreSQL 16 e foreign keys idempotentes, mas ainda não foi aplicada neste ambiente. O cleanup do teste respeita `Person`/evidências antes de remover a `Source`.

### S2: Intent Intelligence 2.0 `[STATUS: ✅ IMPLEMENTADO / PERSISTÊNCIA PENDENTE DE EXECUÇÃO LOCAL]`

- **IMPLEMENTED**: contrato e runner de providers; website changes por snapshot/URL pública; hiring por postings/HTML/URL pública; anúncios públicos por itens/HTML/URL pública; normalização, TTL, confiança, classificação, sanitização, hash, custo e deduplicação.
- **PARTIALLY IMPLEMENTED**: coleta de URLs públicas depende de rede e de input válido; não existe histórico de snapshots ou worker de ingestão agendado.
- **REQUIRES CREDENTIALS**: provider de funding API é somente uma fronteira explícita, sem integração paga conectada.
- **NOT IMPLEMENTED**: dezenas de integrações externas, LinkedIn autenticado, APIs pagas, ranking semântico offline e pipeline de filas para sinais.
- **Compatibilidade**: inputs legados das duas tools MCP continuam aceitos; campos novos são aditivos.
- **Verificação**: 39 testes unitários passam; typecheck, build e Prisma validate passam. PostgreSQL/Redis impediram migration, integração, persistência e ranking real.

### S3: Decision & Reasoning Engine `[STATUS: ✅ IMPLEMENTADO / TESTADO]`

- **IMPLEMENTED**: `DecisionEngine` determinístico no `src/core/decision/`, sem LLM.
  - `OpportunityScore` com lead, company, score, urgency, top factors, whyNow, recommended actions e signal summary.
  - Pipeline de score: signal score (40%) + evidence strength (25%) + ICP fit (20%) + lead seniority match (15%).
  - Urgency (`HIGH` / `MEDIUM` / `LOW`) baseada em recência, peso e classificação do melhor sinal.
  - `DecisionFactor` com nome, contribuição, evidência de suporte e classificação.
  - `WHY_NOW` com justificativas por tipo de sinal (hiring → expansão, funding → novo orçamento, etc.).
  - `RecommendedAction` com canal, timing, template interpolado e rationale.
  - Classificação de senioridade (C-Level > VP > Director > Manager) e de função de compra (Sales > Engineering > HR).
- **MCP tool**: `gtm_evaluate_opportunity` avalia um lead, uma empresa ou todos os leads ativos.
  - Persistência: consulta `intent_signals` ativos + `company_evidence` + `companies` para ICP fit via `pgvector`.
  - Schema Zod em `src/mcp/schemas/decision.ts`.
- **Compatibilidade**: contratos S1 e S2 preservados; `scoring.ts` reutilizado para recência de sinais.
- **Verificação**: 30 testes unitários novos passam (total 69 em 13 arquivos). Typecheck, build e Prisma validate passam.
- **Limitação operacional**: ranking e persistência PostgreSQL aguardam infra local (`127.0.0.1:5433`). O teste de integração futuro deve validar `evaluateOpportunity` contra dados reais.
- **Documentação**: este arquivo, `docs/IMPLEMENTATION_STATUS.md` e `docs/ARCHITECTURE.md`.
