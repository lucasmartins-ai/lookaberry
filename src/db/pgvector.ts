import { prisma } from './client.js';
import { HASH_EMBEDDING_MODEL, LEXICAL_EMBEDDING_MODEL } from '../core/icp/embeddings.js';

export function vectorToString(embedding: number[]): string {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding must be a non-empty array of numbers');
  }
  return `[${embedding.join(',')}]`;
}

export async function initVectorExtension(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS "vector";`);

    // Ensure HNSW indexes for cosine distance
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_icp_profiles_embedding 
      ON icp_profiles USING hnsw (embedding vector_cosine_ops);
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_companies_embedding 
      ON companies USING hnsw (embedding vector_cosine_ops);
    `);
  } catch (error) {
    console.error('Failed to initialize pgvector extensions and HNSW indexes:', error);
    throw error;
  }
}

export async function setIcpProfileEmbedding(icpId: string, embedding: number[], model = HASH_EMBEDDING_MODEL): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE icp_profiles SET embedding = $1::vector, embedding_model = $3, updated_at = NOW() WHERE id = $2::uuid`,
    vectorToString(embedding),
    icpId,
    model,
  );
}

export async function setCompanyEmbedding(companyId: string, embedding: number[], model = HASH_EMBEDDING_MODEL): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE companies SET embedding = $1::vector, embedding_model = $3, updated_at = NOW() WHERE id = $2::uuid`,
    vectorToString(embedding),
    companyId,
    model,
  );
}

/**
 * Set when missing; replace legacy/unknown/older-lexical vectors; upgrade to a different
 * semantic model. Never downgrade: hash never replaces anything, lexical never replaces a
 * semantic vector.
 */
export async function setCompanyEmbeddingIfMissing(companyId: string, embedding: number[], model = HASH_EMBEDDING_MODEL): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE companies SET embedding = $1::vector, embedding_model = $3, updated_at = NOW()
      WHERE id = $2::uuid
        AND (
          embedding IS NULL
          OR (embedding_model IS NULL OR embedding_model = $4 OR embedding_model LIKE 'lexical-%') AND $3 <> $4
          OR embedding_model IS DISTINCT FROM $3 AND $3 NOT IN ($4, $5)
        )`,
    vectorToString(embedding),
    companyId,
    model,
    HASH_EMBEDDING_MODEL,
    LEXICAL_EMBEDDING_MODEL,
  );
}
