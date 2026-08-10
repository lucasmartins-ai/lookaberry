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

### Sprint 4: Motor de Hiper-Personalização com Prompt Caching
- **Objetivo**: Gerar mensagens de alta conversão sem clichês usando Prompt Caching da Anthropic.
- **O que construir**:
  - Template engine de sintetização de dor (Sinal Ativo + Cargo do Lead + ICP Value Matrix).
  - Integração com Anthropic Prompt Caching no SDK para leitura de prompts estáticos com 90% de desconto.
  - Guardrails sintáticos para evitar palavras de spam e termos genéricos de IA.
  - Tool MCP `gtm_generate_hyper_personalized_message`.
- **Tools MCP Ativas ao Final da Sprint**:
  - `gtm_analyze_icp`
  - `gtm_detect_intent_signals`
  - `gtm_score_and_rank_leads`
  - `gtm_waterfall_enrich_lead`
  - `gtm_generate_hyper_personalized_message`
- **Critérios de Aceite (Done)**:
  - Mensagens contextuais geradas consumindo menos de 150 tokens de input dinâmico com cache hit $> 80\%$.
- **Complexidade**: Baixa-Média (2 dias).
- **Riscos Técnicos**: Alucinações sobre a empresa $\rightarrow$ *Mitigação*: Restrição estrita no prompt para usar apenas fatos contidos no payload do sinal.

---

### Sprint 5: Dispatcher Multicanal, Sequências e Anti-Ban Engine
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

---

### Sprint 6: Analytics, Loop de Feedback e Aprendizado Contínuo
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
