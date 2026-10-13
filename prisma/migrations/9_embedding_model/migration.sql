-- Which model produced each vector. ICP fit only compares vectors from the same semantic model;
-- existing rows stay NULL (unknown) and fall back to companies.icp_fit_score until re-embedded.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "embedding_model" VARCHAR(64);
ALTER TABLE "icp_profiles" ADD COLUMN IF NOT EXISTS "embedding_model" VARCHAR(64);
