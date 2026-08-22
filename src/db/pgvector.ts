import { prisma } from './client.js';

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

export async function setIcpProfileEmbedding(icpId: string, embedding: number[]): Promise<void> {
  const vectorStr = vectorToString(embedding);
  await prisma.$executeRawUnsafe(
    `UPDATE icp_profiles SET embedding = $1::vector, updated_at = NOW() WHERE id = $2::uuid`,
    vectorStr,
    icpId
  );
}

export async function setCompanyEmbedding(companyId: string, embedding: number[]): Promise<void> {
  const vectorStr = vectorToString(embedding);
  await prisma.$executeRawUnsafe(
    `UPDATE companies SET embedding = $1::vector, updated_at = NOW() WHERE id = $2::uuid`,
    vectorStr,
    companyId
  );
}

export async function setCompanyEmbeddingIfMissing(companyId: string, embedding: number[]): Promise<void> {
  const vectorStr = vectorToString(embedding);
  await prisma.$executeRawUnsafe(
    `UPDATE companies SET embedding = $1::vector, updated_at = NOW() WHERE id = $2::uuid AND embedding IS NULL`,
    vectorStr,
    companyId
  );
}
