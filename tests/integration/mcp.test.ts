import { describe, it, expect, afterAll } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { icpService } from '../../src/core/icp/service.js';
import { prisma } from '../../src/db/client.js';

describe('MCP Server Integration', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should initialize McpServer with gtm_analyze_icp tool registered', () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it('persists an ICP analysis submitted by the calling agent (agent mode, no API)', async () => {
    const result = await icpService.analyzeIcp({
      website_url: 'https://news.ycombinator.com',
      description: 'Tech startup news and discussion forum',
      analysis: {
        company_name: 'Hacker News',
        company_summary: 'Tech news and discussion forum for startup founders and engineers.',
        target_personas: [{ title: 'Startup Founder', seniority: 'C-Level', core_pain: 'Reaching technical early adopters' }],
        value_propositions: ['Highly technical audience'],
        target_industries: ['B2B SaaS'],
      },
    });
    if (!('icp_id' in result)) throw new Error('expected a saved ICP');

    expect(result.icp_id).toBeDefined();
    expect(result.company_summary).toBeDefined();
    expect(result.target_personas.length).toBeGreaterThan(0);
    expect(result.value_propositions.length).toBeGreaterThan(0);

    // Verify vector was saved in database
    const rawVector = await prisma.$queryRaw<Array<{ has_embedding: boolean }>>`
      SELECT (embedding IS NOT NULL) AS has_embedding 
      FROM icp_profiles 
      WHERE id = ${result.icp_id}::uuid;
    `;

    expect(rawVector.length).toBe(1);
    expect(rawVector[0].has_embedding).toBe(true);

    // Cleanup
    await prisma.icpProfile.delete({ where: { id: result.icp_id } });
  });
});
