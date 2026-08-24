-- S10: Campaign Engine & Smart Scheduling
-- Additive migration — does not break S1-S9
-- This migration is self-contained for databases created from the original schema.

-- The evidence graph migration may be absent from an existing database that was
-- provisioned before S1 was recorded in Prisma's migration history.
CREATE TABLE IF NOT EXISTS "sources" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "name" VARCHAR(255) NOT NULL,
  "source_type" VARCHAR(100) NOT NULL,
  "source_url" VARCHAR(1000),
  "external_id" VARCHAR(255),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "people" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "company_id" UUID,
  "first_name" VARCHAR(150),
  "last_name" VARCHAR(150),
  "full_name" VARCHAR(300) NOT NULL,
  "title" VARCHAR(255),
  "seniority" VARCHAR(100),
  "linkedin_url" VARCHAR(500),
  "email" VARCHAR(255),
  "phone" VARCHAR(50),
  "location" VARCHAR(255),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "identities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "person_id" UUID,
  "company_id" UUID,
  "source_id" UUID,
  "identity_type" VARCHAR(100) NOT NULL,
  "value" VARCHAR(500) NOT NULL,
  "normalized_value" VARCHAR(500) NOT NULL,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "verified_at" TIMESTAMPTZ(6),
  "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_identities_type_normalized_value" UNIQUE ("identity_type", "normalized_value")
);

CREATE TABLE IF NOT EXISTS "company_evidence" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "company_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "evidence_type" VARCHAR(100) NOT NULL,
  "classification" VARCHAR(50) NOT NULL,
  "source_url" VARCHAR(1000),
  "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
  "normalized_data" JSONB NOT NULL DEFAULT '{}',
  "raw_data" JSONB,
  "content_hash" VARCHAR(128),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "company_evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "person_evidence" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "person_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "evidence_type" VARCHAR(100) NOT NULL,
  "classification" VARCHAR(50) NOT NULL,
  "source_url" VARCHAR(1000),
  "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
  "normalized_data" JSONB NOT NULL DEFAULT '{}',
  "raw_data" JSONB,
  "content_hash" VARCHAR(128),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "person_evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "observations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "source_id" UUID NOT NULL,
  "company_id" UUID,
  "person_id" UUID,
  "observation_type" VARCHAR(100) NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
  "normalized_data" JSONB NOT NULL DEFAULT '{}',
  "raw_data" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "observations_target_check" CHECK ("company_id" IS NOT NULL OR "person_id" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "relationships" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "company_id" UUID NOT NULL,
  "person_id" UUID NOT NULL,
  "source_id" UUID,
  "relationship_type" VARCHAR(100) NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
  "started_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "relationships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_relationships_company_person_type" UNIQUE ("company_id", "person_id", "relationship_type")
);

CREATE TABLE IF NOT EXISTS "interactions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "lead_id" UUID,
  "company_id" UUID,
  "person_id" UUID,
  "source_id" UUID,
  "channel" VARCHAR(100) NOT NULL,
  "interaction_type" VARCHAR(100) NOT NULL,
  "external_id" VARCHAR(255),
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "content" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- 1. Add SCHEDULED to message_status_enum
ALTER TYPE message_status_enum ADD VALUE IF NOT EXISTS 'SCHEDULED';

-- 2. Create branch_condition_enum
DO $$ BEGIN
  CREATE TYPE branch_condition_enum AS ENUM ('NONE', 'OPENED', 'NOT_OPENED', 'REPLIED', 'NOT_REPLIED', 'CLICKED', 'BOUNCED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Add fields to sequence_steps
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS branch_on branch_condition_enum NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS branch_step_index INT,
  ADD COLUMN IF NOT EXISTS variant_group VARCHAR(100),
  ADD COLUMN IF NOT EXISTS variant_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS impressions INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opens INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replies INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks INT NOT NULL DEFAULT 0;

-- 4. Add timezone to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timezone VARCHAR(50);

-- 5. Add fields to outreach_messages
ALTER TABLE outreach_messages
  ADD COLUMN IF NOT EXISTS sequence_version_id UUID,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ(6);

-- 6. Add current_version_id to outreach_sequences
ALTER TABLE outreach_sequences ADD COLUMN IF NOT EXISTS current_version_id UUID;

-- 7. Create outreach_sequence_versions
CREATE TABLE IF NOT EXISTS outreach_sequence_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sequence_id UUID NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE,
  version INT NOT NULL,
  steps JSONB NOT NULL,
  created_by VARCHAR(255),
  change_description TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT uq_sequence_versions_sequence_version UNIQUE (sequence_id, version)
);

-- 8. Create lead_sequence_states
CREATE TABLE IF NOT EXISTS lead_sequence_states (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE,
  current_step_index INT NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  paused_until TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT uq_lead_sequence_state_lead_sequence UNIQUE (lead_id, sequence_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_sequence_state_sequence_status ON lead_sequence_states(sequence_id, status);

-- 9. Add FK from outreach_messages to outreach_sequence_versions
DO $$ BEGIN
  ALTER TABLE outreach_messages
    ADD CONSTRAINT fk_outreach_messages_sequence_version
    FOREIGN KEY (sequence_version_id) REFERENCES outreach_sequence_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 10. Add FK from outreach_sequences to outreach_sequence_versions (current_version)
DO $$ BEGIN
  ALTER TABLE outreach_sequences
    ADD CONSTRAINT fk_outreach_sequences_current_version
    FOREIGN KEY (current_version_id) REFERENCES outreach_sequence_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;