-- WhatsApp/phone opt-outs need their own suppression type.
ALTER TYPE "suppression_type_enum" ADD VALUE IF NOT EXISTS 'PHONE';

-- Outcome events from external executors (LOOKAORCHESTRATOR). No raw PII: person_hash only.
CREATE TABLE IF NOT EXISTS "outreach_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "source" VARCHAR(50) NOT NULL,
  "external_id" VARCHAR(200) NOT NULL,
  "event_type" VARCHAR(30) NOT NULL,
  "channel" VARCHAR(50) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "external_lead_id" VARCHAR(200),
  "lead_id" UUID,
  "person_hash" VARCHAR(64),
  "company_domain" VARCHAR(255),
  "segment" VARCHAR(120),
  "region" VARCHAR(120),
  "campaign" VARCHAR(120),
  "variant" VARCHAR(60),
  "intent" VARCHAR(30),
  "sentiment" VARCHAR(20),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outreach_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_outreach_events_source_external" ON "outreach_events"("source", "external_id");
CREATE INDEX IF NOT EXISTS "idx_outreach_events_type_time" ON "outreach_events"("event_type", "occurred_at");
CREATE INDEX IF NOT EXISTS "idx_outreach_events_segment_channel" ON "outreach_events"("segment", "channel");
CREATE INDEX IF NOT EXISTS "idx_outreach_events_person" ON "outreach_events"("person_hash");
