/**
 * Phase 2 learning: which segment x channel x variant x hour actually converts.
 *
 * Attribution (outbound): each outcome is credited to the last SENT to the same person
 * (person_hash or external_lead_id) within ATTRIBUTION_DAYS before it. Outcomes with no
 * such send are inbound (e.g. the website diagnostic) and are reported separately.
 * Ranking uses the Wilson lower bound, so a 1/2 arm never beats a 20/400 arm.
 */

import { prisma } from '../../db/client.js';
import { normalizeSegment } from './segments.js';
import type { OpportunityScore } from '../decision/types.js';

export const ATTRIBUTION_DAYS = 30;
export const DIMENSIONS = ['segment', 'channel', 'variant', 'campaign', 'hour', 'weekday', 'segment_channel'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const POSITIVE_INTENTS = new Set(['INTERESTED', 'MEETING', 'QUESTION']);
const NEGATIVE_INTENTS = new Set(['NOT_INTERESTED', 'UNSUBSCRIBE']);
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface LearningEvent {
  eventType: string;
  channel: string;
  occurredAt: Date;
  personHash: string | null;
  externalLeadId: string | null;
  segment: string | null;
  campaign: string | null;
  variant: string | null;
  intent: string | null;
}

export interface ArmStats {
  key: string;
  sent: number;
  replied: number;
  positive: number;
  negative: number;
  bounced: number;
  meetings: number;
  positiveRate: number;
  /** 90% Wilson lower bound of the positive rate (ranking key). */
  positiveRateLow: number;
  enoughData: boolean;
}

export interface Insights {
  by: Dimension;
  minSent: number;
  attributionDays: number;
  totals: Omit<ArmStats, 'key' | 'enoughData'>;
  arms: ArmStats[];
  /** Outcomes with no outbound send before them, per channel (inbound demand). */
  inbound: Array<{ channel: string; replies: number; positive: number; meetings: number; paid: number }>;
}

/** Wilson score lower bound (z=1.645 → 90%). */
export function wilsonLowerBound(successes: number, trials: number, z = 1.645): number {
  if (trials === 0) return 0;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return Math.max(0, (centre - margin) / denom);
}

function isPositive(e: LearningEvent): boolean {
  return e.eventType === 'MEETING' || e.eventType === 'PAID' || (e.eventType === 'REPLIED' && POSITIVE_INTENTS.has(e.intent ?? ''));
}
function isHumanReply(e: LearningEvent): boolean {
  return e.eventType === 'MEETING' || e.eventType === 'PAID' || (e.eventType === 'REPLIED' && e.intent !== 'AUTO_REPLY');
}

function armKey(send: LearningEvent, by: Dimension): string {
  const segment = normalizeSegment(send.segment);
  switch (by) {
    case 'segment': return segment;
    case 'channel': return send.channel;
    case 'variant': return send.variant ?? 'none';
    case 'campaign': return send.campaign ?? 'none';
    case 'hour': return String(send.occurredAt.getUTCHours()).padStart(2, '0') + 'h UTC';
    case 'weekday': return WEEKDAYS[send.occurredAt.getUTCDay()]!;
    case 'segment_channel': return `${segment}|${send.channel}`;
  }
}

/** Wilson score upper bound (z=1.645 → 90%). */
export function wilsonUpperBound(successes: number, trials: number, z = 1.645): number {
  if (trials === 0) return 1;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return Math.min(1, (centre + margin) / denom);
}

/**
 * Pure: events in, insights out. `channel` limits which sends are aggregated; attribution
 * still sees every send, so a WhatsApp follow-up keeps the credit over an earlier email.
 */
export function computeInsights(events: LearningEvent[], by: Dimension = 'segment', minSent = 30, channel?: string): Insights {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const sends = sorted.filter(e => e.eventType === 'SENT');
  const outcomes: Record<string, { replied: boolean; positive: boolean; negative: boolean; bounced: boolean; meeting: boolean }> = {};
  const inbound = new Map<string, { channel: string; replies: number; positive: number; meetings: number; paid: number }>();
  const windowMs = ATTRIBUTION_DAYS * 86_400_000;

  // Last-touch lookup per person (hash and lead id both identify a person).
  const sendsByPerson = new Map<string, number[]>();
  sends.forEach((s, i) => {
    for (const id of [s.personHash && `h:${s.personHash}`, s.externalLeadId && `l:${s.externalLeadId}`]) {
      if (id) sendsByPerson.set(id, [...(sendsByPerson.get(id) ?? []), i]);
    }
  });

  for (const o of sorted) {
    if (o.eventType === 'SENT' || (o.eventType === 'OPT_OUT' && !o.personHash && !o.externalLeadId)) continue;
    const candidates = [o.personHash && `h:${o.personHash}`, o.externalLeadId && `l:${o.externalLeadId}`]
      .flatMap(id => (id ? sendsByPerson.get(id) ?? [] : []))
      .filter(i => {
        const t = sends[i]!.occurredAt.getTime();
        return t < o.occurredAt.getTime() && t >= o.occurredAt.getTime() - windowMs;
      });
    if (candidates.length === 0) {
      if (o.eventType === 'OPT_OUT' || o.eventType === 'BOUNCED') continue;
      const row = inbound.get(o.channel) ?? { channel: o.channel, replies: 0, positive: 0, meetings: 0, paid: 0 };
      if (isHumanReply(o)) row.replies++;
      if (isPositive(o)) row.positive++;
      if (o.eventType === 'MEETING' || o.intent === 'MEETING') row.meetings++;
      if (o.eventType === 'PAID') row.paid++;
      inbound.set(o.channel, row);
      continue;
    }
    const last = Math.max(...candidates);
    const flags = (outcomes[last] ??= { replied: false, positive: false, negative: false, bounced: false, meeting: false });
    if (isHumanReply(o)) flags.replied = true;
    if (isPositive(o)) flags.positive = true;
    if (o.eventType === 'OPT_OUT' || NEGATIVE_INTENTS.has(o.intent ?? '')) flags.negative = true;
    if (o.eventType === 'BOUNCED') flags.bounced = true;
    if (o.eventType === 'MEETING' || o.intent === 'MEETING') flags.meeting = true;
  }

  const arms = new Map<string, ArmStats>();
  const totals = { sent: 0, replied: 0, positive: 0, negative: 0, bounced: 0, meetings: 0, positiveRate: 0, positiveRateLow: 0 };
  sends.forEach((s, i) => {
    if (channel && s.channel !== channel) return;
    const key = armKey(s, by);
    const arm = arms.get(key) ?? { key, sent: 0, replied: 0, positive: 0, negative: 0, bounced: 0, meetings: 0, positiveRate: 0, positiveRateLow: 0, enoughData: false };
    const f = outcomes[i];
    for (const target of [arm, totals]) {
      target.sent++;
      if (f?.replied) target.replied++;
      if (f?.positive) target.positive++;
      if (f?.negative) target.negative++;
      if (f?.bounced) target.bounced++;
      if (f?.meeting) target.meetings++;
    }
    arms.set(key, arm);
  });

  const finish = <T extends { sent: number; positive: number; positiveRate: number; positiveRateLow: number }>(a: T): T => {
    a.positiveRate = a.sent ? a.positive / a.sent : 0;
    a.positiveRateLow = wilsonLowerBound(a.positive, a.sent);
    return a;
  };
  finish(totals);
  const ranked = [...arms.values()]
    .map(a => ({ ...finish(a), enoughData: a.sent >= minSent }))
    .sort((a, b) => Number(b.enoughData) - Number(a.enoughData) || b.positiveRateLow - a.positiveRateLow || b.sent - a.sent);

  return {
    by,
    minSent,
    attributionDays: ATTRIBUTION_DAYS,
    totals,
    arms: ranked,
    inbound: [...inbound.values()].sort((a, b) => b.positive - a.positive),
  };
}

export async function loadLearningEvents(db: typeof prisma = prisma, since?: Date): Promise<LearningEvent[]> {
  // ponytail: loads all events into memory; move attribution into SQL when outreach_events passes ~100k rows.
  return db.outreachEvent.findMany({
    where: since ? { occurredAt: { gte: since } } : undefined,
    select: {
      eventType: true, channel: true, occurredAt: true, personHash: true, externalLeadId: true,
      segment: true, campaign: true, variant: true, intent: true,
    },
  });
}

export async function getInsights(by: Dimension, minSent = 30, since?: Date, db: typeof prisma = prisma): Promise<Insights> {
  return computeInsights(await loadLearningEvents(db, since), by, minSent);
}

// ── Channel priors used by the decision engine ──

let priorsCache: { at: number; arms: ArmStats[] } | null = null;
const PRIORS_TTL_MS = 3_600_000;

/** Learned channel ranking for a segment (only arms with enough data), best first. Cached 1h. */
export async function getChannelPriors(segment: string | null | undefined, minSent = 30): Promise<ArmStats[]> {
  if (!priorsCache || Date.now() - priorsCache.at > PRIORS_TTL_MS) {
    priorsCache = { at: Date.now(), arms: (await getInsights('segment_channel', minSent)).arms };
  }
  const prefix = `${normalizeSegment(segment)}|`;
  return priorsCache.arms.filter(a => a.enoughData && a.key.startsWith(prefix));
}

export function _resetPriorsCache(): void {
  priorsCache = null;
}

/**
 * Reorder recommended actions by the learned channel ranking for the lead's segment and say
 * why. Channels with no learned data keep their relative order after the ranked ones.
 */
export function applyChannelPriors(score: OpportunityScore, priors: ArmStats[], segment: string): OpportunityScore {
  if (priors.length === 0) return score;
  const rank = new Map(priors.map((a, i) => [a.key.split('|')[1]!, i]));
  const recommendedActions = score.recommendedActions
    .map((action, i) => ({ action, i }))
    .sort((a, b) => (rank.get(a.action.channel) ?? 1e6 + a.i) - (rank.get(b.action.channel) ?? 1e6 + b.i))
    .map(({ action }) => action);
  const best = priors[0]!;
  const line = `Learned: ${best.key.split('|')[1]} gets ${(best.positiveRate * 100).toFixed(1)}% positive replies in ${normalizeSegment(segment)} (n=${best.sent})`;
  return { ...score, recommendedActions, whyNow: [...score.whyNow, line] };
}

// ── Learned send days (conservative) ──

export const BLOCK_MIN_SENT = 100;
export const BLOCK_MIN_CHANNEL_POSITIVES = 5;
const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Weekdays to stop sending on for a channel. A day is blocked only when the evidence is strong:
 * at least BLOCK_MIN_SENT sends that day, the channel has BLOCK_MIN_CHANNEL_POSITIVES positives,
 * and even the optimistic (90% upper) rate for that day is under half the channel's rate.
 * At most 2 days, and never leaving fewer than 3 allowed days.
 */
export function blockedWeekdays(events: LearningEvent[], channel: string, allowedDays: number[]): number[] {
  const insights = computeInsights(events, 'weekday', BLOCK_MIN_SENT, channel);
  if (insights.totals.positive < BLOCK_MIN_CHANNEL_POSITIVES) return [];
  const threshold = insights.totals.positiveRate * 0.5;
  const blocked = insights.arms
    .filter(a => a.sent >= BLOCK_MIN_SENT && wilsonUpperBound(a.positive, a.sent) < threshold)
    .sort((a, b) => a.positiveRate - b.positiveRate)
    .map(a => DAY_INDEX[a.key]!)
    .filter(d => allowedDays.includes(d))
    .slice(0, 2);
  return allowedDays.length - blocked.length >= 3 ? blocked : [];
}

let scheduleCache: { at: number; events: LearningEvent[] } | null = null;

/** blockedWeekdays over live events, cached 1h. */
export async function getBlockedWeekdays(channel: string, allowedDays: number[]): Promise<number[]> {
  if (!scheduleCache || Date.now() - scheduleCache.at > PRIORS_TTL_MS) {
    scheduleCache = { at: Date.now(), events: await loadLearningEvents() };
  }
  return blockedWeekdays(scheduleCache.events, channel, allowedDays);
}
