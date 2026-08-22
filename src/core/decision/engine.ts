import type { EvidenceClassification } from '../evidence/types.js';
import { signalRecencyFactor, isActiveSignal } from '../intent/scoring.js';
import { channelRegistry } from '../channels/registry.js';
import type { ChannelCapability, ChannelId } from '../channels/types.js';
import type {
  DecisionContext,
  DecisionEvidence,
  DecisionFactor,
  NormalizedDecisionSignal,
  OpportunityScore,
  RecommendedAction,
  TimingWindow,
  Urgency,
} from './types.js';

export const SIGNAL_WEIGHT = 0.40;
export const EVIDENCE_WEIGHT = 0.25;
export const ICP_FIT_WEIGHT = 0.20;
export const LEAD_MATCH_WEIGHT = 0.15;

const URGENCY_HIGH_DAYS = 7;
const URGENCY_MEDIUM_DAYS = 30;

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  HIRING: 'Hiring activity',
  FUNDING: 'Recent funding',
  TECH_INSTALL: 'Technology adoption',
  LEADERSHIP_CHANGE: 'Leadership change',
  CONTENT_ENGAGEMENT: 'Content engagement',
  WEBSITE_CHANGE: 'Website changes',
  PUBLIC_ANNOUNCEMENT: 'Public announcement',
};

const SIGNAL_TYPE_RATIONALES: Record<string, string> = {
  HIRING: 'Company is expanding the team, indicating budget availability and growth phase.',
  FUNDING: 'Recent funding enables new tool purchases and vendor evaluations.',
  TECH_INSTALL: 'Recent technology adoption signals an active evaluation phase for complementary tools.',
  LEADERSHIP_CHANGE: 'Leadership change often triggers vendor reassessment and new budget allocation.',
  CONTENT_ENGAGEMENT: 'Increased content engagement suggests active research and buying intent.',
  WEBSITE_CHANGE: 'Website changes indicate rebranding or product repositioning — a natural moment to reach out.',
  PUBLIC_ANNOUNCEMENT: 'Public announcements signal momentum and openness to partnerships.',
};

const ACTION_TEMPLATES_BY_SIGNAL: Record<string, { channel: ChannelId; capability: ChannelCapability; timing: TimingWindow; template: string; rationale: string }[]> = {
  HIRING: [
    {
      channel: 'linkedin',
      capability: 'sendMessage',
      timing: 'WITHIN_24H',
      template: 'Hi {firstName}, noticed {companyName} is hiring for {signalTitle}. We help companies scale this function — worth a 15-minute chat?',
      rationale: 'New hires indicate budget and priority; personalized outreach referencing the role has high reply rates.',
    },
    {
      channel: 'email',
      capability: 'sendMessage',
      timing: 'WITHIN_WEEK',
      template: 'Subject: Scaling your {signalTitle} efforts\n\nHi {firstName},\n\nI saw {companyName} is hiring for {signalTitle}. Many teams we work with use LookaBerry to accelerate this exact function — would you be open to a brief call?',
      rationale: 'Email follow-up reinforces the LinkedIn message with more context.',
    },
  ],
  FUNDING: [
    {
      channel: 'email',
      capability: 'sendMessage',
      timing: 'IMMEDIATE',
      template: 'Subject: Congrats on the {signalTitle}!\n\nHi {firstName},\n\nCongratulations on the recent funding. Companies at this stage typically evaluate solutions like ours to scale efficiently — happy to share how we help.',
      rationale: 'Funding announcements are time-sensitive windows; congratulate first, then pivot to value.',
    },
    {
      channel: 'linkedin',
      capability: 'connect',
      timing: 'WITHIN_24H',
      template: 'Connect request with note: "Congrats on the funding round — excited to see what {companyName} builds next."',
      rationale: 'Warm LinkedIn connect establishes presence without a hard pitch immediately.',
    },
  ],
  TECH_INSTALL: [
    {
      channel: 'linkedin',
      capability: 'sendMessage',
      timing: 'WITHIN_WEEK',
      template: 'Hi {firstName}, noticed {companyName} recently adopted {signalTitle}. Our solution integrates well — would you be interested in a quick technical overview?',
      rationale: 'Recent tech adoption indicates an active evaluation window for complementary tools.',
    },
  ],
  LEADERSHIP_CHANGE: [
    {
      channel: 'linkedin',
      capability: 'sendMessage',
      timing: 'WITHIN_WEEK',
      template: 'Hi {firstName}, congratulations on the new role at {companyName}! Leaders in your position often reassess the current tech stack — I\'d love to share how we can help.',
      rationale: 'New leaders re-evaluate existing vendors within the first 90 days.',
    },
  ],
  WEBSITE_CHANGE: [
    {
      channel: 'email',
      capability: 'sendMessage',
      timing: 'WITHIN_WEEK',
      template: 'Subject: Noticed the new {companyName} website\n\nHi {firstName},\n\nLove the new site direction. The updated messaging suggests you\'re investing in {signalTitle} — we help companies at this stage do more with less. Worth a chat?',
      rationale: 'Website refresh signals renewed market focus and potential budget for supporting tools.',
    },
  ],
  PUBLIC_ANNOUNCEMENT: [
    {
      channel: 'linkedin',
      capability: 'sendMessage',
      timing: 'WITHIN_WEEK',
      template: 'Hi {firstName}, saw {companyName}\'s recent announcement about {signalTitle}. Impressive momentum — curious if there\'s a way we could support this.',
      rationale: 'Public announcements are a natural hook for initiating conversations.',
    },
  ],
};

const DEFAULT_ACTIONS: RecommendedAction[] = [
  {
    channel: 'linkedin',
    capability: 'connect',
    timing: 'WITHIN_WEEK',
    template: 'Connect with {firstName} at {companyName} to establish presence before outreach.',
    rationale: 'Building network presence before pitching improves response rates.',
  },
  {
    channel: 'manual',
    capability: 'followUp',
    timing: 'WITHIN_WEEK',
    template: 'Research {companyName} recent news and prepare a personalized value hypothesis.',
    rationale: 'Generic signals should trigger human research before automated outreach.',
  },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function hoursBetween(a: Date, b: Date): number {
  return Math.max(0, (b.getTime() - a.getTime()) / 3_600_000);
}

export function classifyUrgency(latestSignalAgeHours: number, maxSignalWeight: number, bestClassification: EvidenceClassification): Urgency {
  if (latestSignalAgeHours <= URGENCY_HIGH_DAYS * 24 && maxSignalWeight >= 70 && bestClassification === 'FACT') {
    return 'HIGH';
  }
  if (latestSignalAgeHours <= URGENCY_MEDIUM_DAYS * 24 && maxSignalWeight >= 50) {
    return 'MEDIUM';
  }
  return 'LOW';
}

export function scoreEvidenceStrength(evidence: DecisionEvidence[]): number {
  if (evidence.length === 0) return 0;
  const classificationWeights: Record<EvidenceClassification, number> = {
    FACT: 1,
    USER_PROVIDED: 0.85,
    INFERENCE: 0.7,
    LLM_INFERENCE: 0.5,
    UNVERIFIED: 0.3,
  };
  const total = evidence.reduce((sum, e) => {
    return sum + finiteOr(classificationWeights[e.classification], 0.3) * finiteOr(e.confidence, 1);
  }, 0);
  return clamp(total / evidence.length, 0, 1);
}

export function computeSignalScore(signals: NormalizedDecisionSignal[], now: Date = new Date()): number {
  const active = signals.filter(s => isActiveSignal(s, now));
  if (active.length === 0) return 0;

  const deduped = new Map<string, NormalizedDecisionSignal>();
  for (const s of active) {
    const key = s.deduplicationKey || s.signalId;
    const existing = deduped.get(key);
    if (!existing || s.intentWeight > existing.intentWeight) {
      deduped.set(key, s);
    }
  }

  let total = 0;
  for (const s of deduped.values()) {
    const recency = signalRecencyFactor(s, now);
    const typeMult = 1;
    const classificationWeights: Record<EvidenceClassification, number> = {
      FACT: 1,
      USER_PROVIDED: 0.9,
      INFERENCE: 0.8,
      LLM_INFERENCE: 0.6,
      UNVERIFIED: 0.5,
    };
    const classMult = finiteOr(classificationWeights[s.evidenceClassification], 0.5);
    total += s.intentWeight * recency * finiteOr(s.confidence, 0) * finiteOr(s.sourceQuality, 0.5) * typeMult * classMult;
  }

  return clamp(total, 0, 100);
}

export function computeLeadMatchScore(ctx: DecisionContext): number {
  if (!ctx.leadTitle && !ctx.leadSeniority) return 50;
  const titleLower = (ctx.leadTitle ?? '').toLowerCase();
  const seniorityLower = (ctx.leadSeniority ?? '').toLowerCase();

  const seniorityKeywords: Record<string, number> = {
    'c-level': 100, 'ceo': 100, 'cto': 100, 'cfo': 100, 'coo': 100, 'cmo': 100,
    'vp': 85, 'vice president': 85, 'head': 80,
    'director': 70, 'senior director': 75,
    'manager': 50, 'senior manager': 60,
    'lead': 45, 'senior': 55, 'principal': 60, 'staff': 55,
    'founder': 95, 'co-founder': 90, 'owner': 85,
  };

  const buyingKeywords: Record<string, number> = {
    'sales': 85, 'revenue': 80, 'growth': 75, 'marketing': 70, 'demand': 70,
    'engineering': 75, 'technology': 75, 'product': 70, 'operations': 65,
    'procurement': 60, 'finance': 55, 'it': 65, 'information': 60,
    'people': 50, 'hr': 45, 'human resources': 45, 'talent': 55,
  };

  let seniorityScore = 0;
  for (const [keyword, score] of Object.entries(seniorityKeywords)) {
    if (seniorityLower.includes(keyword) || titleLower.includes(keyword)) {
      seniorityScore = Math.max(seniorityScore, score);
    }
  }

  let buyingScore = 0;
  for (const [keyword, score] of Object.entries(buyingKeywords)) {
    if (titleLower.includes(keyword)) {
      buyingScore = Math.max(buyingScore, score);
    }
  }

  if (seniorityScore === 0) seniorityScore = 40;
  if (buyingScore === 0) buyingScore = 30;

  return clamp((seniorityScore * 0.6 + buyingScore * 0.4), 0, 100);
}

export function buildDecisionFactors(ctx: DecisionContext, signalScore: number, evidenceStrength: number, leadMatchScore: number, now: Date): DecisionFactor[] {
  const factors: DecisionFactor[] = [];

  const activeSignals = ctx.signals.filter(s => isActiveSignal(s, now));
  if (activeSignals.length > 0) {
    const topSignal = activeSignals.reduce((a, b) => a.intentWeight > b.intentWeight ? a : b);
    factors.push({
      name: SIGNAL_TYPE_LABELS[topSignal.signalType] ?? 'Intent signal',
      contribution: Math.round(signalScore * SIGNAL_WEIGHT),
      evidence: topSignal.summary,
      evidenceClassification: topSignal.evidenceClassification,
    });
  }

  if (ctx.evidence.length > 0 && evidenceStrength > 0) {
    const bestEvidence = ctx.evidence.reduce((a, b) => {
      const order: EvidenceClassification[] = ['FACT', 'USER_PROVIDED', 'INFERENCE', 'LLM_INFERENCE', 'UNVERIFIED'];
      return order.indexOf(a.classification) <= order.indexOf(b.classification) ? a : b;
    });
    factors.push({
      name: 'Supporting evidence',
      contribution: Math.round(evidenceStrength * 100 * EVIDENCE_WEIGHT),
      evidence: bestEvidence.evidenceType,
      evidenceClassification: bestEvidence.classification,
    });
  }

  if (ctx.icpFit > 0) {
    factors.push({
      name: 'ICP fit',
      contribution: Math.round(ctx.icpFit * 100 * ICP_FIT_WEIGHT),
      evidence: `Company ${ctx.companyName} matches ICP profile`,
      evidenceClassification: 'INFERENCE',
    });
  }

  if (ctx.leadTitle || ctx.leadSeniority) {
    factors.push({
      name: 'Lead seniority match',
      contribution: Math.round(leadMatchScore * LEAD_MATCH_WEIGHT),
      evidence: ctx.leadTitle ?? ctx.leadSeniority ?? '',
      evidenceClassification: 'USER_PROVIDED',
    });
  }

  factors.sort((a, b) => b.contribution - a.contribution);
  return factors;
}

export function buildWhyNow(signals: NormalizedDecisionSignal[], now: Date): string[] {
  const active = signals.filter(s => isActiveSignal(s, now));
  if (active.length === 0) return ['No active signals detected — monitor for future intent triggers.'];

  const reasons: string[] = [];
  const seen = new Set<string>();

  for (const s of active) {
    const label = SIGNAL_TYPE_LABELS[s.signalType];
    const rationale = SIGNAL_TYPE_RATIONALES[s.signalType];
    if (label && rationale && !seen.has(s.signalType)) {
      reasons.push(rationale);
      seen.add(s.signalType);
    }
  }

  const ages = active.map(s => hoursBetween(s.observedAt, now));
  const youngest = Math.min(...ages);
  if (youngest < 24) {
    reasons.unshift('Signal detected within the last 24 hours — timing is critical.');
  } else if (youngest < 72) {
    reasons.unshift('Recent signals detected within 72 hours — acting now maintains relevance.');
  }

  return reasons;
}

export function buildRecommendedActions(
  signals: NormalizedDecisionSignal[],
  companyName: string,
  leadTitle: string | undefined,
  now: Date,
): RecommendedAction[] {
  const active = signals.filter(s => isActiveSignal(s, now));
  if (active.length === 0) {
    const firstName = leadTitle?.split(' ')[0] ?? 'there';
    return DEFAULT_ACTIONS.map(action => ({
      ...action,
      template: action.template
        .replace(/\{firstName\}/g, firstName)
        .replace(/\{companyName\}/g, companyName),
    }));
  }

  const actions: RecommendedAction[] = [];
  const seenKeys = new Set<string>();

  const topByWeight = [...active].sort((a, b) => b.intentWeight - a.intentWeight);

  for (const signal of topByWeight) {
    const templates = ACTION_TEMPLATES_BY_SIGNAL[signal.signalType];
    if (!templates) continue;

    for (const tpl of templates) {
      const key = `${tpl.channel}:${tpl.capability}`;
      if (seenKeys.has(key)) continue;

      // Filter: only recommend actions whose channel supports the required capability
      if (!channelRegistry.can(tpl.channel, tpl.capability)) continue;

      seenKeys.add(key);

      const firstName = leadTitle?.split(' ')[0] ?? 'there';
      const template = tpl.template
        .replace(/\{firstName\}/g, firstName)
        .replace(/\{companyName\}/g, companyName)
        .replace(/\{signalTitle\}/g, signal.title);

      actions.push({
        channel: tpl.channel,
        capability: tpl.capability,
        timing: tpl.timing,
        template,
        rationale: tpl.rationale,
      });
    }
  }

  if (actions.length === 0) return DEFAULT_ACTIONS;

  actions.sort((a, b) => {
    const order: Record<TimingWindow, number> = { IMMEDIATE: 0, WITHIN_24H: 1, WITHIN_WEEK: 2 };
    return order[a.timing] - order[b.timing];
  });

  return actions.slice(0, 4);
}

export function evaluate(ctx: DecisionContext, now: Date = new Date()): OpportunityScore {
  const signalScore = computeSignalScore(ctx.signals, now);
  const evidenceStrength = scoreEvidenceStrength(ctx.evidence);
  const leadMatchScore = computeLeadMatchScore(ctx);

  const totalScore = clamp(
    signalScore * SIGNAL_WEIGHT
    + evidenceStrength * 100 * EVIDENCE_WEIGHT
    + ctx.icpFit * 100 * ICP_FIT_WEIGHT
    + leadMatchScore * LEAD_MATCH_WEIGHT,
    0,
    100,
  );

  const activeSignals = ctx.signals.filter(s => isActiveSignal(s, now));
  const duplicateCount = ctx.signals.length - activeSignals.length;

  const ages = activeSignals.map(s => hoursBetween(s.observedAt, now));
  const latestAge = ages.length > 0 ? Math.min(...ages) : Infinity;

  const bestClassification = activeSignals.reduce<EvidenceClassification>(
    (best, s) => {
      const order: EvidenceClassification[] = ['FACT', 'USER_PROVIDED', 'INFERENCE', 'LLM_INFERENCE', 'UNVERIFIED'];
      return order.indexOf(s.evidenceClassification) < order.indexOf(best) ? s.evidenceClassification : best;
    },
    'UNVERIFIED',
  );

  const maxWeight = activeSignals.reduce((m, s) => Math.max(m, s.intentWeight), 0);

  const urgency = classifyUrgency(latestAge, maxWeight, bestClassification);
  const factors = buildDecisionFactors(ctx, signalScore, evidenceStrength, leadMatchScore, now);
  const whyNow = buildWhyNow(ctx.signals, now);
  const recommendedActions = buildRecommendedActions(ctx.signals, ctx.companyName, ctx.leadTitle, now);

  const topSignalTypes = [...new Set(activeSignals.map(s => s.signalType))];

  return {
    leadId: ctx.leadId,
    companyId: ctx.companyId,
    companyName: ctx.companyName,
    score: Math.round(totalScore),
    urgency,
    topFactors: factors,
    whyNow,
    recommendedActions,
    signalSummary: {
      activeSignalCount: activeSignals.length,
      duplicateSignalCount: duplicateCount,
      topSignalTypes,
      latestSignalAgeHours: latestAge,
      evidenceStrength,
    },
    icpFit: ctx.icpFit,
  };
}

export { isActiveSignal } from '../intent/scoring.js';