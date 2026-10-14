-- Lookalike ICP: mean embedding of companies whose leads converted (same model as the ICP embedding).
ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "positive_centroid" vector(1536);
ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "positive_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "centroid_updated_at" TIMESTAMPTZ(6);
