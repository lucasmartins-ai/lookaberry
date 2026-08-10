# Catálogo de Ferramentas MCP (Tools) — LookaBerry

---

## 1. Visão Geral

O servidor MCP do LookaBerry implementa o protocolo JSON-RPC 2.0 através do `@modelcontextprotocol/sdk`. Todas as ferramentas possuem contratos rígidos em JSON Schema com tipagem forte e validação em tempo de execução via Zod.

---

## 2. Catálogo Detalhado das 8 Tools

### Tool 1: `gtm_analyze_icp` `[STATUS: ✅ OPERACIONAL]`
- **Descrição**: Extrai a proposta de valor de uma empresa a partir do seu website e gera o perfil do ICP com personas, dores e embeddings vetoriais (1536 dimensões).
- **Quando usar**: Na inicialização do setup de vendas ou ao redefinir a tese de prospecção.
- **Otimização de tokens**: O scraper (LookaCrawler) sanitiza a página web removendo scripts/SVGs e podando ruídos (>70% de economia). Apenas Markdown semântico destilado é enviado para a LLM rápida (Haiku / OpenAI).

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "website_url": { "type": "string", "format": "uri", "description": "URL principal da empresa/produto" },
    "description": { "type": "string", "description": "Resumo opcional da tese de produto ou contexto adicional" },
    "target_geos": { "type": "array", "items": { "type": "string" }, "description": "Regiões geográficas alvo (ex: ['BR', 'US', 'LATAM'])" }
  },
  "required": ["website_url"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "icp_id": { "type": "string", "format": "uuid" },
    "company_summary": { "type": "string" },
    "target_personas": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "seniority": { "type": "string" },
          "core_pain": { "type": "string" }
        }
      }
    },
    "value_propositions": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

### Tool 2: `gtm_detect_intent_signals`
- **Descrição**: Retorna sinais recentes de intenção de compra associados a empresas do ICP (vagas abertas, captações, mudanças de stack).
- **Quando usar**: Para alimentar o pipeline com contas quentes com gatilhos de tempo real.
- **Otimização de tokens**: Saída puramente estruturada em JSON normalizado. Zero tokens consumidos em scraping cru.

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "icp_id": { "type": "string", "format": "uuid" },
    "signal_types": {
      "type": "array",
      "items": { "type": "string", "enum": ["HIRING", "FUNDING", "TECH_INSTALL", "LEADERSHIP_CHANGE", "CONTENT_ENGAGEMENT"] }
    },
    "min_weight": { "type": "number", "minimum": 0, "maximum": 100, "default": 50 },
    "limit": { "type": "integer", "default": 20 }
  },
  "required": ["icp_id"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "total_detected": { "type": "integer" },
    "signals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "signal_id": { "type": "string", "format": "uuid" },
          "company_id": { "type": "string", "format": "uuid" },
          "company_name": { "type": "string" },
          "domain": { "type": "string" },
          "signal_type": { "type": "string" },
          "summary": { "type": "string" },
          "detected_at": { "type": "string", "format": "date-time" },
          "weight": { "type": "number" }
        }
      }
    }
  }
}
```

---

### Tool 3: `gtm_score_and_rank_leads`
- **Descrição**: Executa o ranqueamento híbrido no banco (distância de cosseno vetorial + peso de intenção) para ordenar os melhores leads.
- **Quando usar**: Antes de enfileirar novos contatos em campanhas de outreach.
- **Otimização de tokens**: **0 tokens consumidos**. A execução ocorre diretamente no PostgreSQL 16 com `pgvector`.

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "icp_id": { "type": "string", "format": "uuid" },
    "min_score": { "type": "number", "default": 60.0 },
    "limit": { "type": "integer", "default": 25 },
    "status_filter": { "type": "string", "enum": ["DISCOVERED", "ENRICHED", "READY"], "default": "READY" }
  },
  "required": ["icp_id"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "ranked_leads": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "lead_id": { "type": "string", "format": "uuid" },
          "full_name": { "type": "string" },
          "title": { "type": "string" },
          "company_name": { "type": "string" },
          "icp_score": { "type": "number" },
          "intent_score": { "type": "number" },
          "total_priority_score": { "type": "number" },
          "top_signal": { "type": "string" }
        }
      }
    }
  }
}
```

---

### Tool 4: `gtm_waterfall_enrich_lead`
- `[STATUS: ✅ OPERACIONAL]`
- **Descrição**: Executa o enriquecimento em cascata (Cache Local -> Provedores Tier 1/2 -> Validação SMTP ZeroBounce) para obter dados válidos.
- **Quando usar**: Quando um lead pontuado com alto score precisa de e-mail verificado antes do outreach.
- **Otimização de tokens**: Processo puramente programático e assíncrono.

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "lead_id": { "type": "string", "format": "uuid" },
    "force_refresh": { "type": "boolean", "default": false }
  },
  "required": ["lead_id"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "lead_id": { "type": "string", "format": "uuid" },
    "email": { "type": "string", "format": "email" },
    "email_status": { "type": "string", "enum": ["VERIFIED", "RISKY", "INVALID", "NOT_FOUND"] },
    "linkedin_url": { "type": "string" },
    "phone": { "type": "string" },
    "provider_used": { "type": "string" },
    "credits_consumed": { "type": "number" }
  }
}
```

---

#### Execução e auditoria
- O cache local consulta leads já verificados e evita consumo de créditos quando `force_refresh` é `false`.
- O fallback padrão é Apollo e depois Dropcontact. Sem credenciais, os adaptadores são no-op e não fazem chamadas externas.
- Cada tentativa é registrada em `enrichment_logs`, incluindo `FOUND`, `NOT_FOUND`, `FAILED` e o resultado do `SMTP_VALIDATOR`.
- O worker BullMQ `waterfall_enrichment_queue` executa até 5 jobs em concorrência, 10 jobs por segundo, com 3 tentativas e backoff exponencial de 1 segundo.
- A validação padrão faz preflight MX. A integração ZeroBounce autenticada permanece um ponto de configuração para produção.

### Tool 5: `gtm_generate_hyper_personalized_message`
- **Descrição**: Gera o hook e o corpo da mensagem combinando de forma cirúrgica o lead, seu cargo, o sinal ativo e a dor do ICP.
- **Quando usar**: Imediatamente antes de disparar uma mensagem ou conexão personalizada.
- **Otimização de tokens**: Prompt Caching no system prompt. Apenas o payload condensado do lead (~150 tokens) é enviado no input dinâmico.

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "lead_id": { "type": "string", "format": "uuid" },
    "signal_id": { "type": "string", "format": "uuid" },
    "channel": { "type": "string", "enum": ["LINKEDIN_CONNECT", "LINKEDIN_MESSAGE", "EMAIL"] },
    "tone": { "type": "string", "enum": ["DIRECT_PEER", "CONSULTATIVE", "CONCISE_CHALLENGER"], "default": "DIRECT_PEER" }
  },
  "required": ["lead_id", "channel"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "subject": { "type": "string" },
    "body": { "type": "string" },
    "hook_used": { "type": "string" },
    "estimated_tokens_used": { "type": "integer" }
  }
}
```

---

### Tool 6: `gtm_schedule_outreach_sequence`
- **Descrição**: Agenda o envio das mensagens da sequência respeitando cotas de envio diárias e delays com jitter humano.
- **Quando usar**: Para enfileirar mensagens geradas e aprovadas pelo agente.
- **Otimização de tokens**: Operação transacional de banco e fila (0 tokens de LLM).

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "campaign_id": { "type": "string", "format": "uuid" },
    "lead_id": { "type": "string", "format": "uuid" },
    "pre_generated_messages": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "step_order": { "type": "integer" },
          "channel": { "type": "string", "enum": ["LINKEDIN_CONNECT", "LINKEDIN_MESSAGE", "EMAIL"] },
          "subject": { "type": "string" },
          "body": { "type": "string" }
        },
        "required": ["step_order", "channel", "body"]
      }
    }
  },
  "required": ["campaign_id", "lead_id"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["SCHEDULED", "QUEUED", "REJECTED_DAILY_LIMIT"] },
    "first_execution_at": { "type": "string", "format": "date-time" },
    "steps_count": { "type": "integer" }
  }
}
```

---

### Tool 7: `gtm_track_campaign_metrics`
- **Descrição**: Retorna métricas consolidadas em tempo real (envios, opens, replies, taxa de resposta positiva e bounces).
- **Quando usar**: Em rotinas de auditoria e monitoramento de campanhas.
- **Otimização de tokens**: Agregações SQL pré-computadas em memória ou visualizações de banco (0 tokens de LLM).

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "campaign_id": { "type": "string", "format": "uuid" },
    "timeframe": { "type": "string", "enum": ["24H", "7D", "30D", "ALL"], "default": "7D" }
  },
  "required": ["campaign_id"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "sent_count": { "type": "integer" },
    "delivered_count": { "type": "integer" },
    "open_rate_pct": { "type": "number" },
    "reply_rate_pct": { "type": "number" },
    "positive_reply_count": { "type": "integer" },
    "bounce_rate_pct": { "type": "number" },
    "active_leads_in_pipeline": { "type": "integer" }
  }
}
```

---

### Tool 8: `gtm_record_lead_interaction_feedback`
- **Descrição**: Processa a resposta recebida de um prospect, classifica o sentimento e retroalimenta o peso do sinal de intenção associado.
- **Quando usar**: Quando o webhook de e-mail ou LinkedIn reporta uma resposta recebida.
- **Otimização de tokens**: Classificação rápida via Haiku com schema booleano estruturado.

```json
// Input Schema
{
  "type": "object",
  "properties": {
    "message_id": { "type": "string", "format": "uuid" },
    "reply_body": { "type": "string" },
    "auto_classify": { "type": "boolean", "default": true }
  },
  "required": ["message_id", "reply_body"]
}

// Output Schema
{
  "type": "object",
  "properties": {
    "sentiment": { "type": "string", "enum": ["POSITIVE", "OBJECTION", "NOT_INTERESTED", "OUT_OF_OFFICE", "UNSUBSCRIBE"] },
    "action_taken": { "type": "string" },
    "signal_weight_adjustment": { "type": "number" }
  }
}
```
