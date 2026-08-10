import { prisma } from '../../db/client.js';
import { setIcpProfileEmbedding } from '../../db/pgvector.js';
import { scrapeWebsite } from './scraper.js';
import { analyzeIcpContent, IcpAnalysisResult } from './analyzer.js';
import { generateEmbedding } from './embeddings.js';

export interface AnalyzeIcpParams {
  website_url: string;
  description?: string;
  target_geos?: string[];
}

export interface AnalyzeIcpResponse {
  icp_id: string;
  company_summary: string;
  target_personas: Array<{
    title: string;
    seniority: string;
    core_pain: string;
  }>;
  value_propositions: string[];
}

export class IcpService {
  /**
   * Complete ICP analysis pipeline: Scraping -> Analysis -> Embedding -> DB Storage
   */
  async analyzeIcp(params: AnalyzeIcpParams): Promise<AnalyzeIcpResponse> {
    const { website_url, description, target_geos } = params;

    // 1. Scrape Website with LookaCrawler pipeline
    const scraped = await scrapeWebsite(website_url);

    // 2. Analyze content and extract ICP & Personas
    const analysis: IcpAnalysisResult = await analyzeIcpContent(
      scraped.markdown,
      website_url,
      description,
      target_geos
    );

    // 3. Generate 1536-dim embedding for vector search
    const embeddingText = `Company: ${analysis.company_name}
Summary: ${analysis.company_summary}
Industries: ${analysis.target_industries.join(', ')}
Value Props: ${analysis.value_propositions.join('; ')}
Personas: ${analysis.target_personas.map(p => `${p.title} (${p.seniority}): ${p.core_pain}`).join('; ')}`;

    const embedding = await generateEmbedding(embeddingText);

    // 4. Persist ICP Profile in PostgreSQL
    const createdProfile = await prisma.icpProfile.create({
      data: {
        name: analysis.company_name,
        websiteUrl: website_url,
        description: analysis.company_summary,
        targetIndustries: analysis.target_industries,
        companySizeMin: analysis.company_size_min,
        companySizeMax: analysis.company_size_max,
        targetGeos: target_geos || [],
        techStackKeywords: analysis.tech_stack_keywords,
        valuePropositions: analysis.value_propositions_detailed as any,
      },
    });

    const icpId = createdProfile.id;

    // 5. Store 1536-dim vector embedding in pgvector column
    await setIcpProfileEmbedding(icpId, embedding);

    // 6. Persist ICP Personas
    if (analysis.target_personas.length > 0) {
      await prisma.icpPersona.createMany({
        data: analysis.target_personas.map(p => ({
          icpId,
          jobTitles: [p.title],
          seniorityLevels: [p.seniority],
          responsibilities: p.responsibilities || p.core_pain,
          priorityScore: p.priority_score ?? 10,
        })),
      });
    }

    // 7. Format output matching Tool 1 specification in MCP_TOOLS.md
    return {
      icp_id: icpId,
      company_summary: analysis.company_summary,
      target_personas: analysis.target_personas.map(p => ({
        title: p.title,
        seniority: p.seniority,
        core_pain: p.core_pain,
      })),
      value_propositions: analysis.value_propositions,
    };
  }

  /**
   * Retrieve existing ICP profile with personas
   */
  async getIcpProfile(icpId: string) {
    return prisma.icpProfile.findUnique({
      where: { id: icpId },
      include: {
        personas: true,
      },
    });
  }
}

export const icpService = new IcpService();
