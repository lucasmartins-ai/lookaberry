# Modelagem de Dados — PostgreSQL + pgvector

---

## 1. Visão Geral

O LookaBerry adota o **PostgreSQL 16** com a extensão **`pgvector`** como a sua fonte única de dados relacionais e vetoriais. Essa abordagem elimina a sobrecarga de sincronização dual-write com bancos vetoriais dedicados e garante consistência transacional ACID em todas as operações de GTM.

---

## 2. Schema DDL Completo (SQL)

```sql
-- Habilita extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- 1. Tabela de Perfis de ICP
-- ============================================================================
CREATE TABLE icp_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    website_url VARCHAR(500),
    description TEXT NOT NULL,
    target_industries TEXT[] DEFAULT '{}',
    company_size_min INT DEFAULT 1,
    company_size_max INT DEFAULT 10000,
    target_geos TEXT[] DEFAULT '{}',
    tech_stack_keywords TEXT[] DEFAULT '{}',
    value_propositions JSONB NOT NULL DEFAULT '[]', -- Array de {pain: string, pitch: string, proof: string}
    embedding vector(1536), -- Embedding gerado a partir da síntese do ICP
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 2. Tabela de Personas do ICP
-- ============================================================================
CREATE TABLE icp_personas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    icp_id UUID NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
    job_titles TEXT[] NOT NULL,
    seniority_levels TEXT[] NOT NULL, -- e.g., ['C-Level', 'VP', 'Director', 'Head']
    responsibilities TEXT,
    priority_score INT DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 3. Tabela de Empresas (Accounts)
-- ============================================================================
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    domain VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    linkedin_url VARCHAR(500),
    employee_count INT,
    industry VARCHAR(255),
    country VARCHAR(100),
    tech_stack TEXT[] DEFAULT '{}',
    description TEXT,
    icp_fit_score NUMERIC(5,2) DEFAULT 0.00,
    embedding vector(1536),
    last_enriched_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 4. Tabela de Sinais de Intenção (Intent Signals)
-- ============================================================================
CREATE TABLE intent_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    signal_type VARCHAR(100) NOT NULL, -- 'HIRING', 'FUNDING', 'TECH_INSTALL', 'LEADERSHIP_CHANGE', 'CONTENT_ENGAGEMENT'
    source VARCHAR(100) NOT NULL, -- 'LINKEDIN', 'G2', 'NEWS', 'GITHUB', 'JOB_BOARD'
    title VARCHAR(500) NOT NULL,
    raw_payload JSONB DEFAULT '{}',
    summary TEXT NOT NULL,
    intent_weight NUMERIC(5,2) NOT NULL DEFAULT 50.00, -- 0 a 100
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 5. Tabela de Leads / Prospects
-- ============================================================================
CREATE TYPE email_status_enum AS ENUM ('UNVERIFIED', 'VERIFIED', 'RISKY', 'INVALID', 'NOT_FOUND');
CREATE TYPE lead_status_enum AS ENUM ('DISCOVERED', 'ENRICHED', 'READY', 'IN_SEQUENCE', 'ENGAGED', 'REPLIED_POSITIVE', 'REPLIED_NEGATIVE', 'UNSUBSCRIBED', 'BOUNCED');

CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    first_name VARCHAR(150) NOT NULL,
    last_name VARCHAR(150),
    full_name VARCHAR(300) NOT NULL,
    title VARCHAR(255) NOT NULL,
    seniority VARCHAR(100),
    linkedin_url VARCHAR(500),
    email VARCHAR(255),
    email_status email_status_enum DEFAULT 'UNVERIFIED',
    phone VARCHAR(50),
    location VARCHAR(255),
    icp_score NUMERIC(5,2) DEFAULT 0.00,
    intent_score NUMERIC(5,2) DEFAULT 0.00,
    total_priority_score NUMERIC(5,2) GENERATED ALWAYS AS (icp_score * 0.4 + intent_score * 0.6) STORED,
    status lead_status_enum DEFAULT 'DISCOVERED',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 6. Tabela de Logs de Enriquecimento (Auditoria & Custo)
-- ============================================================================
CREATE TABLE enrichment_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    provider VARCHAR(100) NOT NULL, -- 'APOLLO', 'DROPCONTACT', 'PROSPEO', 'ZEROBOUNCE'
    cost_credits NUMERIC(6,4) DEFAULT 0.0000,
    status VARCHAR(50) NOT NULL,
    response_payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cada tentativa do waterfall e cada validação de entregabilidade gera um log.

-- ============================================================================
-- 7. Tabela de Campanhas & Sequências
-- ============================================================================
CREATE TYPE channel_enum AS ENUM ('LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE', 'EMAIL', 'MANUAL_TASK');

CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    icp_id UUID NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    daily_limit_linkedin INT DEFAULT 20,
    daily_limit_email INT DEFAULT 50,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE sequence_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    channel channel_enum NOT NULL,
    delay_hours INT NOT NULL DEFAULT 24,
    prompt_template TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 8. Tabela de Mensagens & Execução de Outreach
-- ============================================================================
CREATE TYPE message_status_enum AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'FAILED', 'BOUNCED');

CREATE TABLE outreach_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
    signal_id UUID REFERENCES intent_signals(id) ON DELETE SET NULL,
    channel channel_enum NOT NULL,
    subject VARCHAR(500),
    body TEXT NOT NULL,
    status message_status_enum DEFAULT 'QUEUED',
    external_message_id VARCHAR(255),
    error_reason TEXT,
    sent_at TIMESTAMP WITH TIME ZONE,
    replied_at TIMESTAMP WITH TIME ZONE,
    reply_sentiment VARCHAR(50), -- 'POSITIVE', 'OBJECTION', 'OUT_OF_OFFICE', 'UNSUBSCRIBE'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 9. Índices Relacionais e Vetoriais (HNSW)
-- ============================================================================
CREATE INDEX idx_companies_domain ON companies(domain);
CREATE INDEX idx_leads_company_id ON leads(company_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_priority ON leads(total_priority_score DESC);
CREATE INDEX idx_intent_signals_company_active ON intent_signals(company_id, is_active);
CREATE INDEX idx_outreach_messages_lead ON outreach_messages(lead_id);

-- ============================================================================
-- 10. Analytics e Feedback Loop (Sprint 6)
-- ============================================================================
CREATE TABLE campaign_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    metric_date DATE NOT NULL,
    sent_count INT NOT NULL DEFAULT 0,
    open_count INT NOT NULL DEFAULT 0,
    click_count INT NOT NULL DEFAULT 0,
    reply_count INT NOT NULL DEFAULT 0,
    bounce_count INT NOT NULL DEFAULT 0,
    positive_replies INT NOT NULL DEFAULT 0,
    negative_replies INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE lead_interaction_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    message_id UUID REFERENCES outreach_messages(id) ON DELETE SET NULL,
    interaction_type VARCHAR(20) NOT NULL, -- OPEN, CLICK, REPLY, BOUNCE
    sentiment VARCHAR(20), -- POSITIVE, NEGATIVE, NEUTRAL, AMBIGUOUS
    confidence NUMERIC(5,2),
    requires_human_review BOOLEAN NOT NULL DEFAULT FALSE,
    content TEXT,
    provider VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Índices HNSW para busca vetorial de cosseno de alta performance
CREATE INDEX idx_icp_profiles_embedding ON icp_profiles USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_companies_embedding ON companies USING hnsw (embedding vector_cosine_ops);
```

---

## 3. Query Exemplar de Busca Híbrida (Vector + Rules)

A query abaixo executa o ranqueamento de leads sem qualquer custo de inferência em LLM:

```sql
SELECT 
    l.id AS lead_id,
    l.full_name,
    l.title,
    c.name AS company_name,
    c.domain,
    -- Similaridade de cosseno com o embedding do ICP (0 a 100)
    ROUND(((1 - (c.embedding <=> p.embedding)) * 100)::numeric, 2) AS icp_fit_score,
    -- Maior pontuação de sinal ativo da empresa nos últimos 30 dias
    COALESCE(MAX(s.intent_weight), 0.00) AS intent_score,
    -- Score combinado
    ROUND((((1 - (c.embedding <=> p.embedding)) * 100 * 0.4) + (COALESCE(MAX(s.intent_weight), 0.00) * 0.6))::numeric, 2) AS total_score
FROM leads l
JOIN companies c ON l.company_id = c.id
JOIN icp_profiles p ON p.id = $1 -- Parâmetro do ICP ID
LEFT JOIN intent_signals s ON s.company_id = c.id AND s.is_active = TRUE AND s.expires_at > NOW()
WHERE l.status IN ('DISCOVERED', 'ENRICHED', 'READY')
GROUP BY l.id, l.full_name, l.title, c.name, c.domain, c.embedding, p.embedding
ORDER BY total_score DESC
LIMIT 50;
```
