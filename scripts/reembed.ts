/**
 * Re-embed ICP profiles and companies whose vectors came from another model (legacy hash,
 * unknown, or a provider you no longer use) with the active provider (lexical by default).
 *
 *   npx tsx scripts/reembed.ts           # only rows not on the current model
 *   npx tsx scripts/reembed.ts --all     # every row
 */

import { prisma } from '../src/db/client.js';
import { currentEmbeddingModel, generateEmbeddingWithModel } from '../src/core/icp/embeddings.js';
import { setCompanyEmbedding, setIcpProfileEmbedding } from '../src/db/pgvector.js';

async function main() {
  const all = process.argv.includes('--all');
  const model = currentEmbeddingModel();
  const stale = all ? {} : { OR: [{ embeddingModel: null }, { embeddingModel: { not: model } }] };

  const icps = await prisma.icpProfile.findMany({ where: stale, include: { personas: true } });
  for (const icp of icps) {
    const pitches = Array.isArray(icp.valuePropositions) ? (icp.valuePropositions as Array<{ pitch?: string; pain?: string }>) : [];
    const text = [
      `Company: ${icp.name}`,
      `Summary: ${icp.description ?? ''}`,
      `Industries: ${icp.targetIndustries.join(', ')}`,
      `Value Props: ${pitches.map(v => [v.pain, v.pitch].filter(Boolean).join(' ')).join('; ')}`,
      `Personas: ${icp.personas.map(p => `${p.jobTitles.join('/')}: ${p.responsibilities ?? ''}`).join('; ')}`,
    ].join('\n');
    const { embedding, model: used } = await generateEmbeddingWithModel(text);
    await setIcpProfileEmbedding(icp.id, embedding, used);
  }

  const companies = await prisma.company.findMany({ where: stale, select: { id: true, name: true, industry: true, description: true, techStack: true } });
  for (const c of companies) {
    const text = [c.name, c.industry, c.description, c.techStack.join(', ')].filter(Boolean).join(' ');
    const { embedding, model: used } = await generateEmbeddingWithModel(text);
    await setCompanyEmbedding(c.id, embedding, used);
  }

  console.log(`Re-embedded ${icps.length} ICP profile(s) and ${companies.length} compan(y/ies) with ${model}.`);
}

main()
  .catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
