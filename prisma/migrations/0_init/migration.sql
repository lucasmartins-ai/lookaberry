-- Enable PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Enum Types
DO $$ BEGIN
    CREATE TYPE email_status_enum AS ENUM ('UNVERIFIED', 'VERIFIED', 'RISKY', 'INVALID', 'NOT_FOUND');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE lead_status_enum AS ENUM ('DISCOVERED', 'ENRICHED', 'READY', 'IN_SEQUENCE', 'ENGAGED', 'REPLIED_POSITIVE', 'REPLIED_NEGATIVE', 'UNSUBSCRIBED', 'BOUNCED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE channel_enum AS ENUM ('LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE', 'EMAIL', 'MANUAL_TASK');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE message_status_enum AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'FAILED', 'BOUNCED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Table: icp_profiles
CREATE TABLE IF NOT EXISTS icp_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    website_url VARCHAR(500),
    description TEXT NOT NULL,
    target_industries TEXT[] DEFAULT '{}',
    company_size_min INT DEFAULT 1,
    company_size_max INT DEFAULT 10000,
    target_geos TEXT[] DEFAULT '{}',
    tech_stack_keywords TEXT[] DEFAULT '{}',
    value_propositions JSONB NOT NULL DEFAULT '[]',
    embedding vector(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Table: icp_personas
CREATE TABLE IF NOT EXISTS icp_personas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    icp_id UUID NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
    job_titles TEXT[] NOT NULL,
    seniority_levels TEXT[] NOT NULL,
    responsibilities TEXT,
    priority_score INT DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Table: companies
CREATE TABLE IF NOT EXISTS companies (
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

-- 4. Table: intent_signals
CREATE TABLE IF NOT EXISTS intent_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    signal_type VARCHAR(100) NOT NULL,
    source VARCHAR(100) NOT NULL,
    title VARCHAR(500) NOT NULL,
    raw_payload JSONB DEFAULT '{}',
    summary TEXT NOT NULL,
    intent_weight NUMERIC(5,2) NOT NULL DEFAULT 50.00,
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Table: leads
CREATE TABLE IF NOT EXISTS leads (
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

-- 6. Table: enrichment_logs
CREATE TABLE IF NOT EXISTS enrichment_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    provider VARCHAR(100) NOT NULL,
    cost_credits NUMERIC(6,4) DEFAULT 0.0000,
    status VARCHAR(50) NOT NULL,
    response_payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Table: campaigns
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    icp_id UUID NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    daily_limit_linkedin INT DEFAULT 20,
    daily_limit_email INT DEFAULT 50,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Table: sequence_steps
CREATE TABLE IF NOT EXISTS sequence_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    channel channel_enum NOT NULL,
    delay_hours INT NOT NULL DEFAULT 24,
    prompt_template TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Table: outreach_messages
CREATE TABLE IF NOT EXISTS outreach_messages (
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
    reply_sentiment VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_leads_company_id ON leads(company_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(total_priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_intent_signals_company_active ON intent_signals(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_lead ON outreach_messages(lead_id);

-- HNSW Vector Indexes
CREATE INDEX IF NOT EXISTS idx_icp_profiles_embedding ON icp_profiles USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_companies_embedding ON companies USING hnsw (embedding vector_cosine_ops);
