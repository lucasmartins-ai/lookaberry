import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../../config/env.js';
import { jevEvaluate, isJevEnabled } from '../intelligence/typesafe.js';

export interface PersonaAnalysis {
  title: string;
  seniority: string;
  core_pain: string;
  responsibilities?: string;
  priority_score?: number;
}

export interface ValuePropAnalysis {
  pain: string;
  pitch: string;
  proof: string;
}

export interface IcpAnalysisResult {
  company_name: string;
  company_summary: string;
  target_personas: PersonaAnalysis[];
  value_propositions: string[];
  value_propositions_detailed: ValuePropAnalysis[];
  target_industries: string[];
  company_size_min: number;
  company_size_max: number;
  tech_stack_keywords: string[];
  /** Jev pre-analysis metadata (TypeSafe integration). */
  jev_meta?: {
    provider: 'typesafe-jev' | 'unavailable';
    sufficient_prob: number;
    industry_family: string;
    b2b_prob: number;
    reduced_chars: number;
    llm_skipped: boolean;
  };
}

const SYSTEM_PROMPT = `You are an elite B2B Go-To-Market (GTM) Strategist. 
Analyze the provided company website content and extract an Ideal Customer Profile (ICP).

Return ONLY valid JSON matching this exact structure:
{
  "company_name": "Company name",
  "company_summary": "Crisp 2-sentence summary of what the company does and its core value proposition",
  "target_personas": [
    {
      "title": "Head of Sales / VP Engineering / CMO",
      "seniority": "C-Level / VP / Director / Head / Manager",
      "core_pain": "The specific acute business or technical pain this buyer feels that this product solves",
      "responsibilities": "Key job responsibilities",
      "priority_score": 10
    }
  ],
  "value_propositions": [
    "Value proposition statement 1",
    "Value proposition statement 2"
  ],
  "value_propositions_detailed": [
    {
      "pain": "Pain point being addressed",
      "pitch": "How the solution solves it",
      "proof": "Evidence, metric or mechanism"
    }
  ],
  "target_industries": ["B2B SaaS", "Fintech", "E-commerce"],
  "company_size_min": 10,
  "company_size_max": 1000,
  "tech_stack_keywords": ["PostgreSQL", "Node.js", "AWS"]
}`;

/**
 * Fallback heuristic extractor when no LLM API key is present
 */
function heuristicAnalysis(markdown: string, url: string, description?: string): IcpAnalysisResult {
  const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  const cleanName = hostname.split('.')[0];
  const companyName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);

  const firstParagraphs = markdown
    .split('\n\n')
    .filter(p => p.trim().length > 30 && !p.startsWith('#') && !p.startsWith('-'))
    .slice(0, 3)
    .join(' ');

  const summary = description || firstParagraphs.slice(0, 300) || `${companyName} provides high-performance B2B solutions.`;

  return {
    company_name: companyName,
    company_summary: summary,
    target_personas: [
      {
        title: 'VP of Sales / Head of Revenue',
        seniority: 'VP',
        core_pain: 'Inefficient prospecting workflows and low conversion rates on outbound campaigns.',
        responsibilities: 'Scaling pipeline generation and closing enterprise deals',
        priority_score: 10,
      },
      {
        title: 'Chief Technology Officer (CTO)',
        seniority: 'C-Level',
        core_pain: 'High infrastructure costs and complex integration overhead with legacy systems.',
        responsibilities: 'Architecture decisions and technology vendor selection',
        priority_score: 9,
      },
      {
        title: 'Head of Growth / Marketing',
        seniority: 'Head',
        core_pain: 'Difficulty detecting buying signals and identifying high-intent accounts early.',
        responsibilities: 'Demand generation and pipeline velocity',
        priority_score: 8,
      },
    ],
    value_propositions: [
      'Automates high-intent outbound prospecting with zero token waste',
      'Accelerates pipeline velocity with real-time intent signal detection',
      'Provides high-precision verified data with waterfall enrichment',
    ],
    value_propositions_detailed: [
      {
        pain: 'Wasting budget on spray-and-pray outbound',
        pitch: 'Target accounts exhibiting active buying signals with deterministic hybrid scoring',
        proof: '3x higher reply rate with verified deliverability',
      },
      {
        pain: 'Expensive LLM tokens for basic filtering',
        pitch: 'Execute vector search and intent scoring directly in PostgreSQL pgvector',
        proof: 'Zero LLM tokens consumed for lead ranking',
      },
    ],
    target_industries: ['B2B SaaS', 'Technology', 'Financial Services', 'Enterprise Software'],
    company_size_min: 20,
    company_size_max: 5000,
    tech_stack_keywords: ['PostgreSQL', 'TypeScript', 'Redis', 'MCP', 'Docker'],
  };
}

/** Deterministic reducer: strip boilerplate blocks and cap size before any LLM sees the page. */
export function reduceContent(markdown: string, maxChars = 2600): string {
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 2 && !/^(cookie|accept|privacy|terms|subscribe|menu|home|blog|login|sign in)$/i.test(l))
    .join('\n')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return cleaned.slice(0, maxChars);
}

interface JevIcpAssessment {
  provider: 'typesafe-jev' | 'unavailable';
  sufficient: boolean;
  sufficientProb: number;
  industryFamily: string;
  b2bFocus: number;
  reduced: string;
}

/** One Jev call: is the page worth an LLM pass, and what family of business is this? */
async function jevAssessIcp(markdown: string, websiteUrl: string, description?: string): Promise<JevIcpAssessment> {
  const reduced = reduceContent(markdown);
  if (!isJevEnabled()) {
    return { provider: 'unavailable', sufficient: true, sufficientProb: -1, industryFamily: 'unknown', b2bFocus: -1, reduced };
  }
  const out = await jevEvaluate({
    feature: 'lookaberry_icp',
    state: { website: websiteUrl, description: description ?? 'none', content: reduced },
    questions: {
      content_sufficient: {
        type: 'noul',
        instructions:
          'Is there enough substantive (non-boilerplate) website content here to extract an ICP: clearly what the company does and who it serves?',
        criteria: {
          true: 'Clear offer and audience present',
          false: 'Mostly boilerplate, cookie/login walls, or near-empty',
        },
      },
      industry_family: {
        type: 'choice',
        instructions: 'Which industry family fits this company best?',
        criteria: {
          'B2B SaaS': 'Software sold as a subscription to businesses',
          'Enterprise Software': 'On-prem or enterprise software vendors',
          Technology: 'IT services, dev shops, agencies',
          'Financial Services': 'Fintech, banking, insurance, accounting',
          Healthcare: 'Clinics, healthtech, medical services',
          'E-commerce': 'Online retail or marketplaces',
          'Professional Services': 'Consulting, legal, marketing agencies',
          Other: 'Anything else',
        },
      },
      b2b_focus: {
        type: 'noul',
        instructions: 'Does this company sell primarily to businesses (B2B) rather than consumers?',
        criteria: { true: 'B2B', false: 'B2C or mixed' },
      },
    },
  });
  if (!out) {
    return { provider: 'unavailable', sufficient: true, sufficientProb: -1, industryFamily: 'unknown', b2bFocus: -1, reduced };
  }
  const a = out.answers as Record<string, any>;
  return {
    provider: 'typesafe-jev',
    sufficient: (a.content_sufficient?.noul ?? 1) > 0.35,
    sufficientProb: a.content_sufficient?.noul ?? -1,
    industryFamily: a.industry_family?.choice ?? 'unknown',
    b2bFocus: a.b2b_focus?.noul ?? -1,
    reduced,
  };
}

export async function analyzeIcpContent(
  markdown: string,
  websiteUrl: string,
  description?: string,
  targetGeos?: string[]
): Promise<IcpAnalysisResult> {
  // 0. Jev pre-analysis: reduce state + decide whether the LLM call is worth it.
  const assessment = await jevAssessIcp(markdown, websiteUrl, description);
  const meta = {
    provider: assessment.provider,
    sufficient_prob: assessment.sufficientProb,
    industry_family: assessment.industryFamily,
    b2b_prob: assessment.b2bFocus,
    reduced_chars: assessment.reduced.length,
    llm_skipped: false,
  };
  if (assessment.provider === 'typesafe-jev' && !assessment.sufficient) {
    return { ...heuristicAnalysis(markdown, websiteUrl, description), jev_meta: { ...meta, llm_skipped: true } };
  }

  const contentSnippet = assessment.reduced || markdown.slice(0, 8000);
  const jevHint =
    assessment.provider === 'typesafe-jev'
      ? `\nJev pre-analysis: industry family "${assessment.industryFamily}", B2B probability ${assessment.b2bFocus.toFixed(2)}. Use this to inform target_personas and target_industries.`
      : '';
  const userPrompt = `Analyze this company website content and extract the ICP:
URL: ${websiteUrl}
Additional Context/Description: ${description || 'None provided'}
Target Geos: ${targetGeos ? targetGeos.join(', ') : 'Global / Any'}${jevHint}

WEBSITE CONTENT:
${contentSnippet}`;

  // 1. Try Anthropic Claude 3.5 Haiku
  if (config.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 2000,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textBlock = response.content.find(c => c.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as IcpAnalysisResult;
          return { ...normalizeAnalysisResult(parsed, websiteUrl, description), jev_meta: meta };
        }
      }
    } catch (err: any) {
      console.warn(`Anthropic ICP analysis failed: ${err.message}. Trying OpenAI/fallback...`);
    }
  }

  // 2. Try OpenAI
  if (config.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const content = completion.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content) as IcpAnalysisResult;
        return { ...normalizeAnalysisResult(parsed, websiteUrl, description), jev_meta: meta };
      }
    } catch (err: any) {
      console.warn(`OpenAI ICP analysis failed: ${err.message}. Using heuristic fallback...`);
    }
  }

  // 3. Fallback Heuristic
  return { ...heuristicAnalysis(markdown, websiteUrl, description), jev_meta: meta };
}

function normalizeAnalysisResult(raw: Partial<IcpAnalysisResult>, url: string, description?: string): IcpAnalysisResult {
  const fallback = heuristicAnalysis('', url, description);
  
  return {
    company_name: raw.company_name || fallback.company_name,
    company_summary: raw.company_summary || description || fallback.company_summary,
    target_personas: Array.isArray(raw.target_personas) && raw.target_personas.length > 0 
      ? raw.target_personas.map(p => ({
          title: p.title || 'Decision Maker',
          seniority: p.seniority || 'Director',
          core_pain: p.core_pain || 'Operational friction',
          responsibilities: p.responsibilities || '',
          priority_score: p.priority_score || 10,
        }))
      : fallback.target_personas,
    value_propositions: Array.isArray(raw.value_propositions) && raw.value_propositions.length > 0
      ? raw.value_propositions
      : fallback.value_propositions,
    value_propositions_detailed: Array.isArray(raw.value_propositions_detailed) && raw.value_propositions_detailed.length > 0
      ? raw.value_propositions_detailed
      : fallback.value_propositions_detailed,
    target_industries: Array.isArray(raw.target_industries) && raw.target_industries.length > 0
      ? raw.target_industries
      : fallback.target_industries,
    company_size_min: raw.company_size_min ?? fallback.company_size_min,
    company_size_max: raw.company_size_max ?? fallback.company_size_max,
    tech_stack_keywords: Array.isArray(raw.tech_stack_keywords) && raw.tech_stack_keywords.length > 0
      ? raw.tech_stack_keywords
      : fallback.tech_stack_keywords,
  };
}
