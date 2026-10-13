-- Geo + social columns written by the lookacrawler bridge (lookaberry-bridge.ts).
-- pgvector indexes are managed by raw SQL; Prisma's diff wants to drop them, so they are left out on purpose.
ALTER TYPE "channel_enum" ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE "channel_enum" ADD VALUE IF NOT EXISTS 'INSTAGRAM_DM';

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS "instagram_url" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "twitter_url" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "facebook_url" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "whatsapp_phone" VARCHAR(50);
