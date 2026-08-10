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

### Sprint 2: Ingestão de Sinais de Intenção e Hybrid Scoring Engine `[STATUS: ✅ IMPLEMENTADO / TESTADO]`
- **Objetivo**: Implementar a captura de sinais e o algoritmo de ranqueamento híbrido de leads sem custo de tokens LLM.
- **O que construir**:
  - Pipeline de ingestão e normalização de sinais de intenção (`HIRING`, `FUNDING`, `TECH_INSTALL`).
  - Motor de busca híbrida no PostgreSQL: Vetorial (`vector_cosine_ops`) + Ponderação de Intent Score.
  - Tool MCP `gtm_detect_intent_signals`.
  - Tool MCP `gtm_score_and_rank_leads`.
- **Tools MCP Ativas ao Final da Sprint**:
  - `gtm_analyze_icp`
  - `gtm_detect_intent_signals`
  - `gtm_score_and_rank_leads`
- **Critérios de Aceite (Done)**:
  - Banco é capaz de ordenar 10.000 leads em menos de 50ms com zero tokens gastos.
- **Complexidade**: Média (3 dias).
- **Riscos Técnicos**: Dispersão de pontuação $\rightarrow$ *Mitigação*: Normalização com pesos de 0 a 100 e janela TTL de expiração.

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
