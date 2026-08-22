import type { EvidenceClassification } from '../evidence/types.js';

export interface ScorableSignal {
  id?: string;
  signalType: string;
  intentWeight: number;
  confidence: number;
  sourceQuality: number;
  observedAt: Date;
  expiresAt: Date;
  isActive: boolean;
  evidenceClassification: EvidenceClassification;
  deduplicationKey?: string | null;
}

export interface SignalScoringConfig {
  typeMultipliers: Record<string, number>;
  classificationMultipliers: Record<EvidenceClassification, number>;
}

export const DEFAULT_SIGNAL_SCORING_CONFIG: SignalScoringConfig = {
  typeMultipliers: {
    HIRING: 1,
    FUNDING: 1.1,
    TECH_INSTALL: 0.9,
    LEADERSHIP_CHANGE: 1,
    CONTENT_ENGAGEMENT: 0.7,
    WEBSITE_CHANGE: 0.85,
    PUBLIC_ANNOUNCEMENT: 0.8,
  },
  classificationMultipliers: {
    FACT: 1,
    USER_PROVIDED: 0.9,
    INFERENCE: 0.8,
    LLM_INFERENCE: 0.6,
    UNVERIFIED: 0.5,
  },
};

export interface ScoredSignal {
  key: string;
  score: number;
  duplicateCount: number;
  signal: ScorableSignal;
}

export interface SignalScoreSummary {
  score: number;
  activeSignalCount: number;
  duplicateCount: number;
  contributions: ScoredSignal[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteClamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function signalRecencyFactor(signal: Pick<ScorableSignal, 'observedAt' | 'expiresAt'>, now = new Date()): number {
  const observedAt = signal.observedAt.getTime();
  const expiresAt = signal.expiresAt.getTime();
  const nowTime = now.getTime();
  if (![observedAt, expiresAt, nowTime].every(Number.isFinite) || expiresAt <= observedAt) return 0;
  const ttlMs = expiresAt - observedAt;
  return clamp(1 - (nowTime - observedAt) / ttlMs, 0, 1);
}

export function isActiveSignal(signal: Pick<ScorableSignal, 'isActive' | 'expiresAt'>, now = new Date()): boolean {
  const expiresAt = signal.expiresAt.getTime();
  const nowTime = now.getTime();
  return signal.isActive && Number.isFinite(expiresAt) && Number.isFinite(nowTime) && expiresAt > nowTime;
}

export function scoreSignal(signal: ScorableSignal, now = new Date(), config = DEFAULT_SIGNAL_SCORING_CONFIG): number {
  if (!isActiveSignal(signal, now)) return 0;
  const typeMultiplier = config.typeMultipliers[signal.signalType] ?? 1;
  const classificationMultiplier = config.classificationMultipliers[signal.evidenceClassification] ?? 0.5;
  return finiteClamp(signal.intentWeight, 0, 100, 0)
    * signalRecencyFactor(signal, now)
    * finiteClamp(signal.confidence, 0, 1, 0)
    * finiteClamp(signal.sourceQuality, 0, 1, 0)
    * Math.max(0, Number.isFinite(typeMultiplier) ? typeMultiplier : 0)
    * Math.max(0, Number.isFinite(classificationMultiplier) ? classificationMultiplier : 0);
}

export function scoreSignals(signals: ScorableSignal[], now = new Date(), config = DEFAULT_SIGNAL_SCORING_CONFIG): SignalScoreSummary {
  const grouped = new Map<string, ScoredSignal[]>();
  for (const signal of signals) {
    if (!isActiveSignal(signal, now)) continue;
    const key = signal.deduplicationKey || signal.id || `${signal.signalType}:${signal.observedAt.toISOString()}`;
    const scored = { key, score: scoreSignal(signal, now, config), duplicateCount: 1, signal };
    const group = grouped.get(key) ?? [];
    group.push(scored);
    grouped.set(key, group);
  }

  const contributions: ScoredSignal[] = [];
  let duplicateCount = 0;
  for (const [key, group] of grouped) {
    group.sort((left, right) => right.score - left.score || right.signal.observedAt.getTime() - left.signal.observedAt.getTime() || (left.signal.id ?? '').localeCompare(right.signal.id ?? ''));
    const best = group[0];
    contributions.push({ ...best, key, duplicateCount: group.length });
    duplicateCount += Math.max(0, group.length - 1);
  }

  contributions.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  return {
    score: clamp(contributions.reduce((total, contribution) => total + contribution.score, 0), 0, 100),
    activeSignalCount: contributions.length,
    duplicateCount,
    contributions,
  };
}

export interface LeadScore {
  leadId: string;
  totalPriorityScore: number;
  [key: string]: unknown;
}

export function rankLeadsDeterministically<T extends LeadScore>(leads: T[]): T[] {
  return [...leads].sort((left, right) => right.totalPriorityScore - left.totalPriorityScore || left.leadId.localeCompare(right.leadId));
}
