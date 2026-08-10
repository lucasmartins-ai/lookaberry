import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../src/db/client.js';
import { initVectorExtension, setIcpProfileEmbedding, setCompanyEmbedding } from '../../src/db/pgvector.js';
import { generateDeterministicEmbedding } from '../../src/core/icp/embeddings.js';

describe('Database & pgvector Integration', () => {
  beforeAll(async () => {
    await initVectorExtension();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should verify pgvector extension is active', async () => {
    const result = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector';
    `;
    expect(result.length).toBe(1);
    expect(result[0].extname).toBe('vector');
  });

  it('should store and query 1536-dim vector embeddings with cosine similarity', async () => {
    // 1. Create test ICP Profile
    const profile = await prisma.icpProfile.create({
      data: {
        name: 'Test ICP Account',
        websiteUrl: 'https://test-icp.com',
        description: 'B2B Outbound Platform for Sales Teams',
        targetIndustries: ['B2B SaaS', 'Sales Tech'],
        companySizeMin: 50,
        companySizeMax: 1000,
        valuePropositions: [{ pain: 'Low outbound response', pitch: 'Automated intent signals', proof: '3x conversion' }],
      },
    });

    const icpEmbedding = generateDeterministicEmbedding('B2B SaaS outbound intent platform');
    await setIcpProfileEmbedding(profile.id, icpEmbedding);

    // 2. Create test Target Company
    const domain = `test-company-${Date.now()}.com`;
    const company = await prisma.company.create({
      data: {
        domain,
        name: 'Target SaaS Corp',
        industry: 'B2B SaaS',
        employeeCount: 250,
        techStack: ['PostgreSQL', 'Node.js'],
      },
    });

    const companyEmbedding = generateDeterministicEmbedding('B2B SaaS outbound intent platform'); // Similar text
    await setCompanyEmbedding(company.id, companyEmbedding);

    // 3. Query cosine distance via pgvector <=> operator
    const similarityResult = await prisma.$queryRaw<Array<{ company_name: string; similarity: number }>>`
      SELECT 
        c.name AS company_name,
        ROUND(((1 - (c.embedding <=> p.embedding)) * 100)::numeric, 2)::float AS similarity
      FROM companies c, icp_profiles p
      WHERE p.id = ${profile.id}::uuid AND c.id = ${company.id}::uuid;
    `;

    expect(similarityResult.length).toBe(1);
    expect(similarityResult[0].similarity).toBeGreaterThan(95); // Same text should have ~100% similarity

    // Cleanup
    await prisma.company.delete({ where: { id: company.id } });
    await prisma.icpProfile.delete({ where: { id: profile.id } });
  });
});
