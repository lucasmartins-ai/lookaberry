-- S1: Entity + Evidence Graph
-- Reconcile the legacy generated score column with the Prisma model/seed contract.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'leads'::regclass
      AND attname = 'total_priority_score'
      AND attgenerated <> ''
  ) THEN
    ALTER TABLE "leads" ALTER COLUMN "total_priority_score" DROP EXPRESSION;
  END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE "evidence_classification_enum" AS ENUM (
    'FACT',
    'INFERENCE',
    'LLM_INFERENCE',
    'USER_PROVIDED',
    'UNVERIFIED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "person_id" UUID;

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
  "classification" "evidence_classification_enum" NOT NULL,
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
  "classification" "evidence_classification_enum" NOT NULL,
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

CREATE INDEX IF NOT EXISTS "idx_sources_type_external_id" ON "sources"("source_type", "external_id");
CREATE INDEX IF NOT EXISTS "idx_sources_type" ON "sources"("source_type");
CREATE INDEX IF NOT EXISTS "idx_people_company_id" ON "people"("company_id");
CREATE INDEX IF NOT EXISTS "idx_people_full_name" ON "people"("full_name");
CREATE INDEX IF NOT EXISTS "idx_identities_person_id" ON "identities"("person_id");
CREATE INDEX IF NOT EXISTS "idx_identities_company_id" ON "identities"("company_id");
CREATE INDEX IF NOT EXISTS "idx_identities_source_id" ON "identities"("source_id");
CREATE INDEX IF NOT EXISTS "idx_company_evidence_lookup" ON "company_evidence"("company_id", "evidence_type", "observed_at");
CREATE INDEX IF NOT EXISTS "idx_company_evidence_source_id" ON "company_evidence"("source_id");
CREATE INDEX IF NOT EXISTS "idx_company_evidence_expires_at" ON "company_evidence"("expires_at");
CREATE INDEX IF NOT EXISTS "idx_person_evidence_lookup" ON "person_evidence"("person_id", "evidence_type", "observed_at");
CREATE INDEX IF NOT EXISTS "idx_person_evidence_source_id" ON "person_evidence"("source_id");
CREATE INDEX IF NOT EXISTS "idx_person_evidence_expires_at" ON "person_evidence"("expires_at");
CREATE INDEX IF NOT EXISTS "idx_observations_company_observed" ON "observations"("company_id", "observed_at");
CREATE INDEX IF NOT EXISTS "idx_observations_person_observed" ON "observations"("person_id", "observed_at");
CREATE INDEX IF NOT EXISTS "idx_observations_source_observed" ON "observations"("source_id", "observed_at");
CREATE INDEX IF NOT EXISTS "idx_relationships_company_id" ON "relationships"("company_id");
CREATE INDEX IF NOT EXISTS "idx_relationships_person_id" ON "relationships"("person_id");
CREATE INDEX IF NOT EXISTS "idx_relationships_source_id" ON "relationships"("source_id");
CREATE INDEX IF NOT EXISTS "idx_interactions_source_external_id" ON "interactions"("source_id", "external_id");
CREATE INDEX IF NOT EXISTS "idx_interactions_lead_occurred" ON "interactions"("lead_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_interactions_company_occurred" ON "interactions"("company_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_interactions_person_occurred" ON "interactions"("person_id", "occurred_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'leads'::regclass AND conname = 'leads_person_id_fkey') THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_person_id_fkey"
      FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'people'::regclass AND conname = 'people_company_id_fkey') THEN
    ALTER TABLE "people" ADD CONSTRAINT "people_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'identities'::regclass AND conname = 'identities_person_id_fkey') THEN
    ALTER TABLE "identities" ADD CONSTRAINT "identities_person_id_fkey"
      FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'identities'::regclass AND conname = 'identities_company_id_fkey') THEN
    ALTER TABLE "identities" ADD CONSTRAINT "identities_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'identities'::regclass AND conname = 'identities_source_id_fkey') THEN
    ALTER TABLE "identities" ADD CONSTRAINT "identities_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'company_evidence'::regclass AND conname = 'company_evidence_company_id_fkey') THEN
    ALTER TABLE "company_evidence" ADD CONSTRAINT "company_evidence_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'company_evidence'::regclass AND conname = 'company_evidence_source_id_fkey') THEN
    ALTER TABLE "company_evidence" ADD CONSTRAINT "company_evidence_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'person_evidence'::regclass AND conname = 'person_evidence_person_id_fkey') THEN
    ALTER TABLE "person_evidence" ADD CONSTRAINT "person_evidence_person_id_fkey"
      FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'person_evidence'::regclass AND conname = 'person_evidence_source_id_fkey') THEN
    ALTER TABLE "person_evidence" ADD CONSTRAINT "person_evidence_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'observations'::regclass AND conname = 'observations_source_id_fkey') THEN
    ALTER TABLE "observations" ADD CONSTRAINT "observations_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'observations'::regclass AND conname = 'observations_company_id_fkey') THEN
    ALTER TABLE "observations" ADD CONSTRAINT "observations_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'observations'::regclass AND conname = 'observations_person_id_fkey') THEN
    ALTER TABLE "observations" ADD CONSTRAINT "observations_person_id_fkey"
      FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'relationships'::regclass AND conname = 'relationships_company_id_fkey') THEN
    ALTER TABLE "relationships" ADD CONSTRAINT "relationships_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'relationships'::regclass AND conname = 'relationships_person_id_fkey') THEN
    ALTER TABLE "relationships" ADD CONSTRAINT "relationships_person_id_fkey"
      FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'relationships'::regclass AND conname = 'relationships_source_id_fkey') THEN
    ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'interactions'::regclass AND conname = 'interactions_lead_id_fkey') THEN
    ALTER TABLE "interactions" ADD CONSTRAINT "interactions_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'interactions'::regclass AND conname = 'interactions_company_id_fkey') THEN
    ALTER TABLE "interactions" ADD CONSTRAINT "interactions_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'interactions'::regclass AND conname = 'interactions_person_id_fkey') THEN
    ALTER TABLE "interactions" ADD CONSTRAINT "interactions_person_id_fkey"
      FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'interactions'::regclass AND conname = 'interactions_source_id_fkey') THEN
    ALTER TABLE "interactions" ADD CONSTRAINT "interactions_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
