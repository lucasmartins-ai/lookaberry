-- S4: Channel Abstraction Protocol — additive channel_id columns.

-- outreach_accounts: add channel_id alongside legacy channel enum
ALTER TABLE "outreach_accounts"
  ADD COLUMN IF NOT EXISTS "channel_id" VARCHAR(50);

-- outreach_messages: add channel_id alongside legacy channel enum
ALTER TABLE "outreach_messages"
  ADD COLUMN IF NOT EXISTS "channel_id" VARCHAR(50);

-- Backfill channel_id from legacy channel enum values
UPDATE "outreach_accounts"
SET "channel_id" = CASE
  WHEN "channel" = 'LINKEDIN_CONNECT' OR "channel" = 'LINKEDIN_MESSAGE' THEN 'linkedin'
  WHEN "channel" = 'EMAIL' THEN 'email'
  WHEN "channel" = 'MANUAL_TASK' THEN 'manual'
  ELSE LOWER("channel"::text)
END
WHERE "channel_id" IS NULL;

UPDATE "outreach_messages"
SET "channel_id" = CASE
  WHEN "channel" = 'LINKEDIN_CONNECT' OR "channel" = 'LINKEDIN_MESSAGE' THEN 'linkedin'
  WHEN "channel" = 'EMAIL' THEN 'email'
  WHEN "channel" = 'MANUAL_TASK' THEN 'manual'
  ELSE LOWER("channel"::text)
END
WHERE "channel_id" IS NULL;