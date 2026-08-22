import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { setCompanyEmbeddingIfMissing } from '../../db/pgvector.js';
import { generateDeterministicEmbedding } from '../icp/embeddings.js';
import {
  normalizeConfidence,
  sanitizeEvidenceData,
} from '../evidence/service.js';
import type { SanitizedJson } from '../evidence/types.js';
import type {
  DetectIntentSignalsInput,
  IntentSignalInput,
  ScoreAndRankLeadsInput,
} from '../../mcp/schemas/intent.js';
import {
  collectAndNormalizeProviders,
  resolveSignalProviders,
} from './providers/index.js';
import {
  normalizeProviderSignal,
  sanitizeSignalUrl,
} from './providers/common.js';
import type {
  NormalizedSignal,
  ProviderRunResult,
  SignalCollectionInput,
} from './providers/types.js';
import type { SignalScoringConfig } from './scoring.js';

export const DEFAULT_SIGNAL_WEIGHTS: Record<string, number> = {
  HIRING: 75,
  FUNDING: 85,
  TECH_INSTALL: 65,
  LEADERSHIP_CHANGE: 70,
  CONTENT_ENGAGEMENT: 50,
  WEBSITE_CHANGE: 65,
  PUBLIC_ANNOUNCEMENT: 60,
};

export const SIGNAL_TYPE_MULTIPLIERS: Record<string, number> = {
  HIRING: 1,
  FUNDING: 1.1,
  TECH_INSTALL: 0.9,
  LEADERSHIP_CHANGE: 1,
  CONTENT_ENGAGEMENT: 0.7,
  WEBSITE_CHANGE: 0.85,
  PUBLIC_ANNOUNCEMENT: 0.8,
};

export interface NormalizedIntentSignal extends NormalizedSignal {
  rawPayload: SanitizedJson;
}

type LegacyIntentSignalPayload = {
  signal_type: IntentSignalInput['signal_type'];
  source: string;
  title: string;
  summary: string;
  company_domain?: string;
  company_name?: string;
  company_industry?: string;
  company_description?: string;
  company_tech_stack?: string[];
  source_url?: string;
  raw_payload?: Record<string, unknown>;
  normalized_data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  weight?: number;
  ttl_days?: number;
  observed_at?: Date;
  confidence?: number;
  source_quality?: number;
  evidence_classification?: import('../evidence/types.js').EvidenceClassification;
  cost?: number;
  provider_id?: string;
  deduplication_key?: string;
};

export function normalizeIntentSignal(input: LegacyIntentSignalPayload): NormalizedIntentSignal {
  const normalized = normalizeProviderSignal({
    providerId: input.provider_id ?? 'legacy-input',
    companyDomain: input.company_domain ?? 'unknown.local',
    companyName: input.company_name ?? 'Unknown company',
    companyIndustry: input.company_industry,
    companyDescription: input.company_description,
    companyTechStack: input.company_tech_stack,
    signalType: input.signal_type,
    source: input.source,
    sourceUrl: input.source_url,
    title: input.title,
    summary: input.summary,
    rawData: input.raw_payload ?? {},
    normalizedData: input.normalized_data ?? {},
    metadata: input.metadata ?? {},
    intentWeight: input.weight ?? DEFAULT_SIGNAL_WEIGHTS[input.signal_type] ?? 50,
    ttlDays: input.ttl_days ?? 30,
    observedAt: input.observed_at,
    confidence: input.confidence ?? 1,
    sourceQuality: input.source_quality ?? 1,
    evidenceClassification: input.evidence_classification ?? 'USER_PROVIDED',
    cost: input.cost ?? 0,
    deduplicationKey: input.deduplication_key,
  });

  return {
    ...normalized,
    rawPayload: normalized.rawData,
  };
}

function normalizeDomain(value: string): string {
  const candidate = value.includes('://') ? value : `https://${value}`;
  return new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
}

function sourceExternalId(signal: NormalizedSignal): string {
  const identity = `${signal.providerId}:${signal.sourceUrl ?? signal.source}`;
  return createHash('sha256').update(identity).digest('hex');
}

function asInputJson(value: SanitizedJson): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function providerRunOutput(run: ProviderRunResult) {
  return {
    provider_id: run.providerId,
    provider_type: run.providerType,
    status: run.status,
    raw_signal_count: run.rawSignalCount,
    signal_count: run.signals.length,
    cost: run.cost,
    errors: run.errors,
  };
}

function safeMultiplier(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : fallback;
}

function buildSignalTypeMultiplierSql(typeMultipliers: Record<string, number>) {
  const entries = Object.entries(typeMultipliers).filter(([, multiplier]) => Number.isFinite(multiplier));
  if (!entries.length) return Prisma.sql`1`;
  return Prisma.sql`CASE s.signal_type ${Prisma.join(
    entries.map(([signalType, multiplier]) => Prisma.sql`WHEN ${signalType} THEN ${safeMultiplier(multiplier, 1)}`),
    ' '
  )} ELSE 1 END`;
}

function buildClassificationMultiplierSql(classificationMultipliers: SignalScoringConfig['classificationMultipliers']) {
  return Prisma.sql`CASE s.evidence_classification
    WHEN 'FACT' THEN ${safeMultiplier(classificationMultipliers.FACT, 1)}
    WHEN 'USER_PROVIDED' THEN ${safeMultiplier(classificationMultipliers.USER_PROVIDED, 0.9)}
    WHEN 'INFERENCE' THEN ${safeMultiplier(classificationMultipliers.INFERENCE, 0.8)}
    WHEN 'LLM_INFERENCE' THEN ${safeMultiplier(classificationMultipliers.LLM_INFERENCE, 0.6)}
    WHEN 'UNVERIFIED' THEN ${safeMultiplier(classificationMultipliers.UNVERIFIED, 0.5)}
    ELSE ${safeMultiplier(classificationMultipliers.UNVERIFIED, 0.5)}
  END`;
}

export class IntentService {
  constructor(
    private readonly scoringConfig: SignalScoringConfig = {
      typeMultipliers: SIGNAL_TYPE_MULTIPLIERS,
      classificationMultipliers: {
        FACT: 1,
        USER_PROVIDED: 0.9,
        INFERENCE: 0.8,
        LLM_INFERENCE: 0.6,
        UNVERIFIED: 0.5,
      },
    },
  ) {}

  private async upsertSource(signal: NormalizedSignal) {
    const externalId = sourceExternalId(signal);
    const metadata = sanitizeEvidenceData({
      provider_id: signal.providerId,
      signal_type: signal.signalType,
      source_quality: signal.sourceQuality,
    });
    const existing = await prisma.source.findFirst({
      where: { sourceType: signal.source, externalId },
    });

    if (existing) {
      return prisma.source.update({
        where: { id: existing.id },
        data: {
          name: signal.source,
          sourceUrl: signal.sourceUrl,
          metadata: asInputJson(metadata),
        },
      });
    }

    return prisma.source.create({
      data: {
        name: signal.source,
        sourceType: signal.source,
        sourceUrl: signal.sourceUrl,
        externalId,
        metadata: asInputJson(metadata),
      },
    });
  }

  private async upsertCompanyEvidence(companyId: string, sourceId: string, signal: NormalizedSignal) {
    const existing = await prisma.companyEvidence.findFirst({
      where: {
        companyId,
        sourceId,
        evidenceType: signal.signalType,
        contentHash: signal.contentHash,
      },
    });
    const data = {
      companyId,
      sourceId,
      evidenceType: signal.signalType,
      classification: signal.evidenceClassification,
      sourceUrl: signal.sourceUrl,
      observedAt: signal.observedAt,
      expiresAt: signal.expiresAt,
      confidence: normalizeConfidence(signal.confidence),
      normalizedData: asInputJson(signal.normalizedData),
      rawData: asInputJson(signal.rawData),
      contentHash: signal.contentHash,
    };

    return existing
      ? prisma.companyEvidence.update({ where: { id: existing.id }, data })
      : prisma.companyEvidence.create({ data });
  }

  private async persistNormalizedSignal(signal: NormalizedSignal) {
    const domain = normalizeDomain(signal.companyDomain);
    const company = await prisma.company.upsert({
      where: { domain },
      create: {
        domain,
        name: signal.companyName,
        industry: signal.companyIndustry,
        description: signal.companyDescription,
        techStack: signal.companyTechStack ?? [],
      },
      update: {
        name: signal.companyName,
        industry: signal.companyIndustry,
        description: signal.companyDescription,
        ...(signal.companyTechStack ? { techStack: signal.companyTechStack } : {}),
      },
    });

    // Company embeddings remain token-free. Without OpenAI, the deterministic fallback is explicitly non-semantic.
    const companyText = [company.name, company.industry, company.description, company.techStack.join(', ')].filter(Boolean).join(' ');
    await setCompanyEmbeddingIfMissing(company.id, generateDeterministicEmbedding(companyText));

    const source = await this.upsertSource(signal);
    const evidence = await this.upsertCompanyEvidence(company.id, source.id, signal);
    const existing = await prisma.intentSignal.findFirst({
      where: {
        companyId: company.id,
        OR: [
          { deduplicationKey: signal.deduplicationKey },
          { providerId: signal.providerId, source: signal.source, title: signal.title },
        ],
      },
      orderBy: { observedAt: 'desc' },
    });
    const data = {
      companyId: company.id,
      providerId: signal.providerId,
      sourceId: source.id,
      companyEvidenceId: evidence.id,
      signalType: signal.signalType,
      source: signal.source,
      sourceUrl: sanitizeSignalUrl(signal.sourceUrl),
      title: signal.title,
      rawPayload: asInputJson(signal.rawData),
      normalizedData: asInputJson(signal.normalizedData),
      metadata: asInputJson(signal.metadata),
      summary: signal.summary,
      intentWeight: signal.intentWeight,
      confidence: normalizeConfidence(signal.confidence),
      sourceQuality: normalizeConfidence(signal.sourceQuality),
      cost: signal.cost,
      evidenceClassification: signal.evidenceClassification,
      contentHash: signal.contentHash,
      deduplicationKey: signal.deduplicationKey,
      observedAt: signal.observedAt,
      ttlDays: signal.ttlDays,
      detectedAt: signal.observedAt,
      expiresAt: signal.expiresAt,
      isActive: signal.expiresAt.getTime() > Date.now(),
    };

    return existing
      ? prisma.intentSignal.update({ where: { id: existing.id }, data })
      : prisma.intentSignal.create({ data });
  }

  private async persistNormalizedSignals(signals: NormalizedSignal[]) {
    const persisted = [];
    for (const signal of signals) persisted.push(await this.persistNormalizedSignal(signal));
    return persisted;
  }

  async ingestSignals(signals: IntentSignalInput[]) {
    const normalized = signals.map(signal => normalizeIntentSignal(signal));
    return this.persistNormalizedSignals(normalized);
  }

  async detectSignals(input: DetectIntentSignalsInput) {
    const profile = await prisma.icpProfile.findUnique({ where: { id: input.icp_id }, select: { id: true } });
    if (!profile) throw new Error(`ICP profile not found: ${input.icp_id}`);

    const providerRuns = input.collection_inputs?.length
      ? await collectAndNormalizeProviders(
        resolveSignalProviders(input.provider_ids),
        input.collection_inputs as SignalCollectionInput[],
        input.provider_timeout_ms,
      )
      : [];
    const providerSignals = providerRuns.flatMap(run => run.signals);
    const legacySignals = input.signals?.map(signal => normalizeIntentSignal(signal)) ?? [];
    const allSignals = [...providerSignals, ...legacySignals];
    if (allSignals.length) await this.persistNormalizedSignals(allSignals);

    const typeFilter = input.signal_types?.length
      ? Prisma.sql`AND s.signal_type IN (${Prisma.join(input.signal_types)})`
      : Prisma.empty;
    const signals = await prisma.$queryRaw<Array<{
      signal_id: string;
      provider_id: string | null;
      company_id: string;
      company_name: string;
      domain: string;
      signal_type: string;
      source: string;
      source_url: string | null;
      summary: string;
      detected_at: Date;
      observed_at: Date;
      expires_at: Date;
      weight: number;
      confidence: number;
      evidence_classification: string;
      cost: number;
    }>>(Prisma.sql`
      SELECT s.id AS signal_id, s.provider_id, c.id AS company_id, c.name AS company_name,
             c.domain, s.signal_type, s.source, s.source_url, s.summary,
             s.detected_at, s.observed_at, s.expires_at,
             s.intent_weight::float AS weight, s.confidence::float,
             s.evidence_classification::text, s.cost::float
      FROM intent_signals s
      JOIN companies c ON c.id = s.company_id
      WHERE s.is_active = TRUE
        AND s.expires_at > NOW()
        AND s.intent_weight >= ${input.min_weight}
        ${typeFilter}
      ORDER BY s.intent_weight DESC, s.observed_at DESC, s.id ASC
      LIMIT ${input.limit}
    `);

    return {
      total_detected: signals.length,
      provider_runs: providerRuns.map(providerRunOutput),
      signals: signals.map(signal => ({
        signal_id: signal.signal_id,
        provider_id: signal.provider_id,
        company_id: signal.company_id,
        company_name: signal.company_name,
        domain: signal.domain,
        signal_type: signal.signal_type,
        source: signal.source,
        source_url: signal.source_url,
        summary: signal.summary,
        detected_at: signal.detected_at.toISOString(),
        observed_at: signal.observed_at.toISOString(),
        expires_at: signal.expires_at.toISOString(),
        weight: Number(signal.weight),
        confidence: Number(signal.confidence),
        evidence_classification: signal.evidence_classification,
        cost: Number(signal.cost),
      })),
    };
  }

  async scoreAndRankLeads(input: ScoreAndRankLeadsInput) {
    const signalTypeMultiplier = buildSignalTypeMultiplierSql(this.scoringConfig.typeMultipliers);
    const classificationMultiplier = buildClassificationMultiplierSql(this.scoringConfig.classificationMultipliers);
    const rows = await prisma.$queryRaw<Array<{
      lead_id: string;
      full_name: string;
      title: string;
      company_name: string;
      icp_score: number;
      intent_score: number;
      total_priority_score: number;
      top_signal: string | null;
      active_signal_count: number;
      duplicate_signal_count: number;
    }>>(Prisma.sql`
      WITH active_signal_rows AS (
        SELECT s.*,
          COALESCE(GREATEST(0, LEAST(1,
            EXTRACT(EPOCH FROM (s.expires_at - NOW())) /
            NULLIF(EXTRACT(EPOCH FROM (s.expires_at - s.observed_at)), 0)
          )), 0) AS recency_factor
        FROM intent_signals s
        WHERE s.is_active = TRUE
          AND s.expires_at > NOW()
      ),
      scored_signal_rows AS (
        SELECT s.*,
          GREATEST(0, LEAST(100,
            s.intent_weight::float
            * s.recency_factor
            * s.confidence::float
            * s.source_quality::float
            * ${signalTypeMultiplier}
            * ${classificationMultiplier}
          )) AS contribution
        FROM active_signal_rows s
      ),
      ranked_signal_rows AS (
        SELECT s.*,
          ROW_NUMBER() OVER (
            PARTITION BY s.company_id, COALESCE(s.deduplication_key, s.id::text)
            ORDER BY s.contribution DESC, s.confidence DESC, s.source_quality DESC, s.observed_at DESC, s.id ASC
          ) AS duplicate_rank
        FROM scored_signal_rows s
      )
      SELECT l.id AS lead_id, l.full_name, l.title, c.name AS company_name,
        ROUND((CASE WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
          ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100)) END)::numeric, 2)::float AS icp_score,
        ROUND((LEAST(100, COALESCE(SUM(CASE WHEN s.duplicate_rank = 1 THEN s.contribution ELSE 0 END), 0)))::numeric, 2)::float AS intent_score,
        ROUND((
          (CASE WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
            ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100)) END) * 0.4
          + LEAST(100, COALESCE(SUM(CASE WHEN s.duplicate_rank = 1 THEN s.contribution ELSE 0 END), 0)) * 0.6
        )::numeric, 2)::float AS total_priority_score,
        (array_agg(s.summary ORDER BY s.contribution DESC, s.observed_at DESC, s.id ASC) FILTER (WHERE s.id IS NOT NULL AND s.duplicate_rank = 1))[1] AS top_signal,
        COUNT(s.id) FILTER (WHERE s.id IS NOT NULL AND s.duplicate_rank = 1)::int AS active_signal_count,
        COUNT(s.id) FILTER (WHERE s.id IS NOT NULL AND s.duplicate_rank > 1)::int AS duplicate_signal_count
      FROM leads l
      JOIN companies c ON c.id = l.company_id
      CROSS JOIN icp_profiles p
      LEFT JOIN ranked_signal_rows s ON s.company_id = c.id
      WHERE p.id = ${input.icp_id}::uuid
        AND l.status = ${input.status_filter}::lead_status_enum
      GROUP BY l.id, l.full_name, l.title, c.name, c.embedding, p.embedding
      HAVING (
        (CASE WHEN c.embedding IS NULL OR p.embedding IS NULL THEN 0
          ELSE GREATEST(0, LEAST(100, (1 - (c.embedding <=> p.embedding)) * 100)) END) * 0.4
        + LEAST(100, COALESCE(SUM(CASE WHEN s.duplicate_rank = 1 THEN s.contribution ELSE 0 END), 0)) * 0.6
      ) >= ${input.min_score}
      ORDER BY total_priority_score DESC, l.id ASC
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
        active_signal_count: Number(row.active_signal_count),
        duplicate_signal_count: Number(row.duplicate_signal_count),
      })),
    };
  }
}

export const intentService = new IntentService();
