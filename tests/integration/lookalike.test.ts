import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../src/db/client.js';
import { setCompanyEmbedding, setIcpProfileEmbedding } from '../../src/db/pgvector.js';
import { SEMANTIC_EMBEDDING_MODEL } from '../../src/core/icp/embeddings.js';
import { refreshPositiveCentroids, findLookalikes } from '../../src/core/learning/lookalike.js';

/** Unit vector mixing two axes: closeness between vectors is fully controlled. */
function vec(axisA: number, weightA: number, axisB = 1535, weightB = 0): number[] {
  const v = new Array(1536).fill(0);
  v[axisA] = weightA;
  v[axisB] += weightB;
  const norm = Math.hypot(...v);
  return v.map(x => x / norm);
}

const tag = `lk${Date.now().toString().slice(-6)}`;
const created: { icp?: string; companies: string[] } = { companies: [] };

describe('lookalike ICP (real DB)', () => {
  afterAll(async () => {
    if (created.icp) await prisma.icpProfile.delete({ where: { id: created.icp } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
  });

  it('builds a centroid from converted companies and ranks the closest untouched company first', async () => {
    const icp = await prisma.icpProfile.create({
      data: { name: `ICP ${tag}`, websiteUrl: `https://${tag}.test`, description: 'test', targetIndustries: [], targetGeos: [], techStackKeywords: [], valuePropositions: [] as any },
    });
    created.icp = icp.id;
    await setIcpProfileEmbedding(icp.id, vec(5, 1), SEMANTIC_EMBEDDING_MODEL); // ICP itself points elsewhere

    const makeCompany = async (name: string, embedding: number[]) => {
      const c = await prisma.company.create({ data: { domain: `${name}.${tag}.test`, name } });
      created.companies.push(c.id);
      await setCompanyEmbedding(c.id, embedding, SEMANTIC_EMBEDDING_MODEL);
      return c;
    };

    const campaign = await prisma.campaign.create({ data: { icpId: icp.id, name: `Campaign ${tag}`, isActive: true } });
    // Three converted companies clustered around axis 0
    for (const [i, w] of [[0, 0.1], [1, 0.2], [2, 0.15]] as const) {
      const company = await makeCompany(`won${i}`, vec(0, 1, 10 + i, w));
      const lead = await prisma.lead.create({
        data: { companyId: company.id, firstName: `Won${i}`, fullName: `Won ${i}`, title: 'Owner', status: 'REPLIED_POSITIVE' },
      });
      await prisma.leadInteractionFeedback.create({
        data: { campaignId: campaign.id, leadId: lead.id, interactionType: 'REPLY', sentiment: 'POSITIVE', content: 'yes' },
      });
    }
    const near = await makeCompany('near', vec(0, 1, 20, 0.3));
    const far = await makeCompany('far', vec(7, 1));

    await refreshPositiveCentroids();
    const refreshed = await prisma.icpProfile.findUnique({ where: { id: icp.id }, select: { positiveCount: true } });
    expect(refreshed?.positiveCount).toBe(3);

    const lookalikes = await findLookalikes(icp.id, 10);
    const ids = lookalikes.map(l => l.companyId);
    expect(lookalikes[0]).toMatchObject({ companyId: near.id, basis: 'positives' });
    expect(ids.indexOf(near.id)).toBeLessThan(ids.indexOf(far.id));
    // already-converted companies are not suggested again
    expect(lookalikes.some(l => l.name.startsWith('won'))).toBe(false);
  });
});
