import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { setCompanyEmbedding } from '../../db/pgvector.js';
import { generateDeterministicEmbedding } from '../icp/embeddings.js';
import type { DetectIntentSignalsInput, IntentSignalInput, ScoreAndRankLeadsInput } from '../../mcp/schemas/intent.js';

const DEFAULT_WEIGHTS: Record<string, number> = {
  HIRING: 75,
  FUNDING: 85,
  TECH_INSTALL: 65,
  LEADERSHIP_CHANGE: 70,
  CONTENT_ENGAGEMENT: 50,
};

export interface NormalizedIntentSignal {
  signalType: string;
  source: string;
  title: string;
  summary: string;
  rawPayload: Prisma.InputJsonValue;
  intentWeight: number;
  expiresAt: Date;
}

type IntentSignalPayload = Pick<IntentSignalInput, 'signal_type' | 'source' | 'title' | 'summary' | 'raw_payload' | 'weight' | 'ttl_days'>;

export function normalizeIntentSignal(input: IntentSignalPayload): NormalizedIntentSignal {
  const ttlDays = input.ttl_days ?? 30;
  const intentWeight = Math.max(0, Math.min(100, input.weight ?? DEFAULT_WEIGHTS[input.signal_type] ?? 50));

  return {
    signalType: input.signal_type,
    source: input.source.trim(),
    title: input.title.trim(),
    summary: input.summary.trim(),
    rawPayload: (input.raw_payload ?? {}) as Prisma.InputJsonValue,
    intentWeight,
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  };
}

function normalizeDomain(value: string): string {
  const candidate = value.includes('://') ? value : `https://${value}`;
  return new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
}

export class IntentService {
  async ingestSignals(signals: IntentSignalInput[]) {
    const created = [];

    for (const input of signals) {
      const normalized = normalizeIntentSignal(input);
      const domain = normalizeDomain(input.company_domain);
      const company = await prisma.company.upsert({
        where: { domain },
        create: {
          domain,
          name: input.company_name.trim(),
          industry: input.company_industry,
          description: input.company_description,
          techStack: input.company_tech_stack ?? [],
        },
        update: {
          name: input.company_name.trim(),
          industry: input.company_industry,
          description: input.company_description,
          ...(input.company_tech_stack ? { techStack: input.company_tech_stack } : {}),
        },
      });

      // Keep signal ingestion token-free while making new accounts searchable.
      const companyText = [company.name, company.industry, company.description, company.techStack.join(', ')].filter(Boolean).join(' ');
      await setCompanyEmbedding(company.id, generateDeterministicEmbedding(companyText));

      const existing = await prisma.intentSignal.findFirst({
        where: {
          companyId: company.id,
          source: normalized.source,
          title: normalized.title,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
      });

      const signal = existing
        ? await prisma.intentSignal.update({ where: { id: existing.id }, data: normalized })
        : await prisma.intentSignal.create({ data: { companyId: company.id, ...normalized } });
      created.push(signal);
    }

    return created;
  }

  async detectSignals(input: DetectIntentSignalsInput) {
    const profile = await prisma.icpProfile.findUnique({ where: { id: input.icp_id }, select: { id: true } });
    if (!profile) throw new Error(`ICP profile not found: ${input.icp_id}`);

    if (input.signals?.length) await this.ingestSignals(input.signals);

    const typeFilter = input.signal_types?.length
      ? Prisma.sql`AND s.signal_type IN (${Prisma.join(input.signal_types)})`
      : Prisma.empty;
    const signals = await prisma.$queryRaw<Array<{
      signal_id: string;
      company_id: string;
      company_name: string;
      domain: string;
      signal_type: string;
      summary: string;
      detected_at: Date;
      weight: number;
    }>>(Prisma.sql`
      SELECT s.id AS signal_id, c.id AS company_id, c.name AS company_name,
             c.domain, s.signal_type, s.summary, s.detected_at,
             s.intent_weight::float AS weight
      FROM intent_signals s
      JOIN companies c ON c.id = s.company_id
      WHERE s.is_active = TRUE
        AND s.expires_at > NOW()
        AND s.intent_weight >= ${input.min_weight}
        ${typeFilter}
      ORDER BY s.intent_weight DESC, s.detected_at DESC
      LIMIT ${input.limit}
    `);

    return {
      total_detected: signals.length,
      signals: signals.map(signal => ({
        signal_id: signal.signal_id,
        company_id: signal.company_id,
        company_name: signal.company_name,
        domain: signal.domain,
        signal_type: signal.signal_type,
        summary: signal.summary,
        detected_at: signal.detected_at.toISOString(),
        weight: Number(signal.weight),
      })),
    };
  }

  async scoreAndRankLeads(input: ScoreAndRankLeadsInput) {
    const rows = await prisma.$queryRaw<Array<{
      lead_id: string;
      full_name: string;
      title: string;
      company_name: string;
      icp_score: number;
      intent_score: number;
      total_priority_score: number;
      top_signal: string | null;
    }>>(Prisma.sql`
      SELECT l.id AS lead_id, l.full_name, l.title, c.name AS company_name,
        ROUND((CASE WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
          ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100)) END)::numeric, 2)::float AS icp_score,
        ROUND((LEAST(100, COALESCE(SUM(s.intent_weight), 0)))::numeric, 2)::float AS intent_score,
        ROUND((
          (CASE WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
            ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100)) END) * 0.4
          + LEAST(100, COALESCE(SUM(s.intent_weight), 0)) * 0.6
        )::numeric, 2)::float AS total_priority_score,
        (array_agg(s.summary ORDER BY s.intent_weight DESC) FILTER (WHERE s.id IS NOT NULL))[1] AS top_signal
      FROM leads l
      JOIN companies c ON c.id = l.company_id
      CROSS JOIN icp_profiles p
      LEFT JOIN intent_signals s ON s.company_id = c.id AND s.is_active = TRUE AND s.expires_at > NOW()
      WHERE p.id = ${input.icp_id}::uuid
        AND l.status = ${input.status_filter}::lead_status_enum
      GROUP BY l.id, l.full_name, l.title, c.name, c.embedding, p.embedding
      HAVING (
        (CASE WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
          ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100)) END) * 0.4
        + LEAST(100, COALESCE(SUM(s.intent_weight), 0)) * 0.6
      ) >= ${input.min_score}
      ORDER BY total_priority_score DESC
      LIMIT ${input.limit}
    `);

    return {
      ranked_leads: rows.map(row => ({
        lead_id: row.lead_id,
        full_name: row.full_name,
        title: row.title,
        company_name: row.company_name,
        icp_score: Number(row.icp_score),
        intent_score: Number(row.intent_score),
        total_priority_score: Number(row.total_priority_score),
        top_signal: row.top_signal ?? '',
      })),
    };
  }
}

export const intentService = new IntentService();
