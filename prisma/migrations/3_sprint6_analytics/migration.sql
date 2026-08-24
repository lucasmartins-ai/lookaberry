DO $$ BEGIN
  CREATE TYPE "interaction_type_enum" AS ENUM ('OPEN', 'CLICK', 'REPLY', 'BOUNCE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "feedback_sentiment_enum" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'AMBIGUOUS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "campaign_metrics" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "campaign_id" UUID NOT NULL,
  "metric_date" DATE NOT NULL,
  "sent_count" INTEGER NOT NULL DEFAULT 0,
  "open_count" INTEGER NOT NULL DEFAULT 0,
  "click_count" INTEGER NOT NULL DEFAULT 0,
  "reply_count" INTEGER NOT NULL DEFAULT 0,
  "bounce_count" INTEGER NOT NULL DEFAULT 0,
  "positive_replies" INTEGER NOT NULL DEFAULT 0,
  "negative_replies" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "campaign_metrics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_campaign_metrics_campaign_date" UNIQUE ("campaign_id", "metric_date"),
  CONSTRAINT "campaign_metrics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_campaign_metrics_campaign_date" ON "campaign_metrics"("campaign_id", "metric_date");

CREATE TABLE IF NOT EXISTS "lead_interaction_feedback" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "campaign_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "message_id" UUID,
  "interaction_type" "interaction_type_enum" NOT NULL,
  "sentiment" "feedback_sentiment_enum",
  "confidence" DECIMAL(5,2),
  "requires_human_review" BOOLEAN NOT NULL DEFAULT false,
  "content" TEXT,
  "provider" VARCHAR(100),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_interaction_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_interaction_feedback_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "lead_interaction_feedback_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "lead_interaction_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "outreach_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_feedback_campaign_created" ON "lead_interaction_feedback"("campaign_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_feedback_lead_created" ON "lead_interaction_feedback"("lead_id", "created_at");
