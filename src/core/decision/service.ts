import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { evaluate } from './engine.js';
import type { DecisionContext, EvaluateOpportunityInput, EvaluateOpportunityOutput, NormalizedDecisionSignal, DecisionEvidence } from './types.js';

function signalRowToDecisionSignal(row: {
  id: string;
  signal_type: string;
  source: string;
  title: string;
  summary: string;
  observed_at: Date;
  expires_at: Date;
  is_active: boolean;
  intent_weight: number;
  confidence: number;
  source_quality: number;
  evidence_classification: string;
  deduplication_key: string | null;
}): NormalizedDecisionSignal {
  return {
    signalId: row.id,
    signalType: row.signal_type,
    source: row.source,
    title: row.title,
    summary: row.summary,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    isActive: row.is_active,
    intentWeight: Number(row.intent_weight),
    confidence: Number(row.confidence),
    sourceQuality: Number(row.source_quality),
    evidenceClassification: row.evidence_classification as NormalizedDecisionSignal['evidenceClassification'],
    deduplicationKey: row.deduplication_key,
  };
}

function evidenceRowToDecisionEvidence(row: {
  id: string;
  evidence_type: string;
  classification: string;
  source_url: string | null;
  observed_at: Date;
  confidence: number;
}): DecisionEvidence {
  return {
    evidenceId: row.id,
    evidenceType: row.evidence_type,
    classification: row.classification as DecisionEvidence['classification'],
    sourceUrl: row.source_url,
    observedAt: row.observed_at,
    confidence: Number(row.confidence),
  };
}

export class DecisionService {
  async evaluateOpportunity(input: EvaluateOpportunityInput): Promise<EvaluateOpportunityOutput> {
    const profile = await prisma.icpProfile.findUnique({
      where: { id: input.icp_id },
      select: { id: true },
    });
    if (!profile) throw new Error(`ICP profile not found: ${input.icp_id}`);

    const minWeight = input.min_weight ?? 50;
    const now = new Date();
    const evaluated: DecisionContext[] = [];

    if (input.lead_id) {
      const ctx = await this.buildLeadContext(input.lead_id, profile.id, now, minWeight);
      if (ctx) evaluated.push(ctx);
    } else if (input.company_id) {
      const ctx = await this.buildCompanyContext(input.company_id, profile.id, now, minWeight);
      if (ctx) evaluated.push(ctx);
    } else {
      const contexts = await this.buildAllLeadsContext(profile.id, now, minWeight);
      evaluated.push(...contexts);
    }

    return {
      evaluated: evaluated.map(ctx => evaluate(ctx, now)),
      evaluated_at: now.toISOString(),
      total_candidates: evaluated.length,
    };
  }

  private async fetchSignals(companyId: string, minWeight: number): Promise<NormalizedDecisionSignal[]> {
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      signal_type: string;
      source: string;
      title: string;
      summary: string;
      observed_at: Date;
      expires_at: Date;
      is_active: boolean;
      intent_weight: number;
      confidence: number;
      source_quality: number;
      evidence_classification: string;
      deduplication_key: string | null;
    }>>(Prisma.sql`
      SELECT s.id, s.signal_type, s.source, s.title, s.summary,
             s.observed_at, s.expires_at, s.is_active,
             s.intent_weight::float, s.confidence::float, s.source_quality::float,
             s.evidence_classification::text, s.deduplication_key
      FROM intent_signals s
      WHERE s.company_id = ${companyId}::uuid
        AND s.is_active = TRUE
        AND s.expires_at > NOW()
        AND s.intent_weight >= ${minWeight}
      ORDER BY s.intent_weight DESC, s.observed_at DESC
    `);

    return rows.map(signalRowToDecisionSignal);
  }

  private async fetchEvidence(companyId: string): Promise<DecisionEvidence[]> {
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      evidence_type: string;
      classification: string;
      source_url: string | null;
      observed_at: Date;
      confidence: number;
    }>>(Prisma.sql`
      SELECT e.id, e.evidence_type, e.classification::text,
             e.source_url, e.observed_at, e.confidence::float
      FROM company_evidence e
      WHERE e.company_id = ${companyId}::uuid
        AND (e.expires_at IS NULL OR e.expires_at > NOW())
      ORDER BY e.observed_at DESC
      LIMIT 20
    `);

    return rows.map(evidenceRowToDecisionEvidence);
  }

  private async fetchIcpFit(companyId: string, icpId: string): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ icp_fit: number }>>(Prisma.sql`
      SELECT
        ROUND((CASE
          WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
          ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100))
        END)::numeric, 2)::float / 100.0 AS icp_fit
      FROM companies c
      CROSS JOIN icp_profiles p
      WHERE c.id = ${companyId}::uuid AND p.id = ${icpId}::uuid
    `);

    return Number(rows[0]?.icp_fit ?? 0);
  }

  private async buildLeadContext(
    leadId: string,
    icpId: string,
    now: Date,
    minWeight: number,
  ): Promise<DecisionContext | null> {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, companyId: true, title: true, seniority: true, company: { select: { name: true } } },
    });

    if (!lead) throw new Error(`Lead not found: ${leadId}`);

    const [signals, evidence, icpFit] = await Promise.all([
      this.fetchSignals(lead.companyId, minWeight ?? 50),
      this.fetchEvidence(lead.companyId),
      this.fetchIcpFit(lead.companyId, icpId),
    ]);

    return {
      leadId: lead.id,
      companyId: lead.companyId,
      companyName: lead.company.name,
      icpFit,
      leadTitle: lead.title,
      leadSeniority: lead.seniority ?? undefined,
      signals,
      evidence,
    };
  }

  private async buildCompanyContext(
    companyId: string,
    icpId: string,
    now: Date,
    minWeight: number,
  ): Promise<DecisionContext | null> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    if (!company) throw new Error(`Company not found: ${companyId}`);

    const [signals, evidence, icpFit] = await Promise.all([
      this.fetchSignals(companyId, minWeight ?? 50),
      this.fetchEvidence(companyId),
      this.fetchIcpFit(companyId, icpId),
    ]);

    return {
      companyId,
      companyName: company.name,
      icpFit,
      signals,
      evidence,
    };
  }

  private async buildAllLeadsContext(
    icpId: string,
    now: Date,
    minWeight: number,
  ): Promise<DecisionContext[]> {
    const leads = await prisma.lead.findMany({
      where: { status: { in: ['DISCOVERED', 'ENRICHED', 'READY'] } },
      select: { id: true, companyId: true, title: true, seniority: true, company: { select: { name: true, id: true } } },
      take: 50,
    });

    const contexts: DecisionContext[] = [];
    for (const lead of leads) {
      try {
        const [signals, evidence, icpFit] = await Promise.all([
          this.fetchSignals(lead.companyId, minWeight ?? 50),
          this.fetchEvidence(lead.companyId),
          this.fetchIcpFit(lead.companyId, icpId),
        ]);

        contexts.push({
          leadId: lead.id,
          companyId: lead.companyId,
          companyName: lead.company.name,
          icpFit,
          leadTitle: lead.title,
          leadSeniority: lead.seniority ?? undefined,
          signals,
          evidence,
        });
      } catch {
        continue;
      }
    }

    return contexts;
  }
}

export const decisionService = new DecisionService();