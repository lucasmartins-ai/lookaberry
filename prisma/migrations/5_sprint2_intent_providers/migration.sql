-- S2: Intent Intelligence 2.0 provider provenance and deterministic scoring inputs.

ALTER TABLE "intent_signals"
  ADD COLUMN IF NOT EXISTS "provider_id" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "source_id" UUID,
  ADD COLUMN IF NOT EXISTS "company_evidence_id" UUID,
  ADD COLUMN IF NOT EXISTS "source_url" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "normalized_data" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
  ADD COLUMN IF NOT EXISTS "source_quality" DECIMAL(5,4) NOT NULL DEFAULT 0.5000,
  ADD COLUMN IF NOT EXISTS "cost" DECIMAL(8,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS "evidence_classification" "evidence_classification_enum" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS "content_hash" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "deduplication_key" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "observed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "ttl_days" INTEGER NOT NULL DEFAULT 30;

UPDATE "intent_signals"
SET "provider_id" = 'legacy-input'
WHERE "provider_id" IS NULL;

UPDATE "intent_signals"
SET "observed_at" = COALESCE("detected_at", "created_at", CURRENT_TIMESTAMP)
WHERE "observed_at" IS NULL;

UPDATE "intent_signals"
SET "ttl_days" = GREATEST(
  1,
  CEIL(EXTRACT(EPOCH FROM ("expires_at" - "observed_at")) / 86400)::INTEGER
)
WHERE "expires_at" IS NOT NULL
  AND "observed_at" IS NOT NULL;

UPDATE "intent_signals"
SET "deduplication_key" = md5(concat_ws('|',
  "company_id"::text,
  "signal_type",
  "source",
  "title",
  COALESCE("source_url", '')
))
WHERE "deduplication_key" IS NULL;

ALTER TABLE "intent_signals"
  ALTER COLUMN "observed_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "observed_at" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'intent_signals'::regclass AND conname = 'intent_signals_source_id_fkey'
  ) THEN
    ALTER TABLE "intent_signals"
      ADD CONSTRAINT "intent_signals_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'intent_signals'::regclass AND conname = 'intent_signals_company_evidence_id_fkey'
  ) THEN
    ALTER TABLE "intent_signals"
      ADD CONSTRAINT "intent_signals_company_evidence_id_fkey"
      FOREIGN KEY ("company_evidence_id") REFERENCES "company_evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'intent_signals'::regclass AND conname = 'intent_signals_confidence_check'
  ) THEN
    ALTER TABLE "intent_signals"
      ADD CONSTRAINT "intent_signals_confidence_check"
      CHECK ("confidence" BETWEEN 0 AND 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'intent_signals'::regclass AND conname = 'intent_signals_source_quality_check'
  ) THEN
    ALTER TABLE "intent_signals"
      ADD CONSTRAINT "intent_signals_source_quality_check"
      CHECK ("source_quality" BETWEEN 0 AND 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'intent_signals'::regclass AND conname = 'intent_signals_cost_check'
  ) THEN
    ALTER TABLE "intent_signals"
      ADD CONSTRAINT "intent_signals_cost_check"
      CHECK ("cost" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'intent_signals'::regclass AND conname = 'intent_signals_ttl_days_check'
  ) THEN
    ALTER TABLE "intent_signals"
      ADD CONSTRAINT "intent_signals_ttl_days_check"
      CHECK ("ttl_days" > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_intent_signals_company_type_dedup"
  ON "intent_signals"("company_id", "signal_type", "deduplication_key");
CREATE INDEX IF NOT EXISTS "idx_intent_signals_provider_id"
  ON "intent_signals"("provider_id");
CREATE INDEX IF NOT EXISTS "idx_intent_signals_source_id"
  ON "intent_signals"("source_id");
CREATE INDEX IF NOT EXISTS "idx_intent_signals_observed_at"
  ON "intent_signals"("observed_at");
