-- S9: WhatsApp execution & multi-account LinkedIn
-- Additive migration — does not break S1–S8.

-- 1. New enums
DO $$ BEGIN
  CREATE TYPE phone_status_enum AS ENUM ('UNVERIFIED', 'VALID', 'INVALID');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE account_status_enum AS ENUM ('ACTIVE', 'BLOCKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Lead.phoneStatus
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_status phone_status_enum NOT NULL DEFAULT 'UNVERIFIED';

-- 3. OutreachAccount.status + lastError
ALTER TABLE outreach_accounts ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE outreach_accounts ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 4. OutreachMessage.outreachAccountId (FK to OutreachAccount)
ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS outreach_account_id UUID;

-- Note: FK constraint added separately to avoid locking issues in production;
-- add it when convenient:
-- ALTER TABLE outreach_messages
--   ADD CONSTRAINT fk_outreach_messages_account
--   FOREIGN KEY (outreach_account_id) REFERENCES outreach_accounts(id)
--   ON DELETE SET NULL;