DO $$ BEGIN
  CREATE TYPE outreach_sequence_status_enum AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS outreach_sequences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  status outreach_sequence_status_enum NOT NULL DEFAULT 'ACTIVE',
  next_step INT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
  paused_until TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS sequence_id UUID;

DO $$ BEGIN
  ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_sequence_id_fkey
    FOREIGN KEY (sequence_id) REFERENCES outreach_sequences(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS outreach_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  channel channel_enum NOT NULL,
  daily_limit INT NOT NULL,
  sent_today INT NOT NULL DEFAULT 0,
  quota_date DATE NOT NULL,
  paused_until TIMESTAMP WITH TIME ZONE,
  session_key VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_outreach_account_provider_external_channel UNIQUE (provider, external_id, channel)
);

CREATE TABLE IF NOT EXISTS "_LeadToOutreachSequence" (
  "A" UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  "B" UUID NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE
);

-- Add PK constraint only if table was just created (won't have the constraint yet)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_LeadToOutreachSequence_AB_pkey') THEN
    ALTER TABLE "_LeadToOutreachSequence" ADD CONSTRAINT "_LeadToOutreachSequence_AB_pkey" PRIMARY KEY ("A", "B");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_sequences_due ON outreach_sequences(status, next_run_at);
CREATE INDEX IF NOT EXISTS "_LeadToOutreachSequence_B_index" ON "_LeadToOutreachSequence"("B");
