import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../db/client.js';
import {
  RecordLeadInteractionFeedbackInputSchema,
  type RecordLeadInteractionFeedbackInput,
  type TrackCampaignMetricsInput,
} from '../../mcp/schemas/analytics.js';

export const HUMAN_REVIEW_CONFIDENCE = 85;

export interface SentimentResult {
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS';
  confidence: number;
}

export function applySignalFeedback(currentWeight: number, sentiment: SentimentResult['sentiment']) {
  const delta = sentiment === 'POSITIVE' ? 5 : sentiment === 'NEGATIVE' ? -5 : 0;
  return Math.max(0, Math.min(100, currentWeight + delta));
}

export function requiresHumanReview(result: SentimentResult) {
  return result.sentiment === 'AMBIGUOUS' || result.confidence < HUMAN_REVIEW_CONFIDENCE;
}

export interface AnalyticsRepository {
  recordFeedback(input: RecordLeadInteractionFeedbackInput, sentiment?: SentimentResult): Promise<{
    feedbackId: string;
    requiresHumanReview: boolean;
  }>;
  getMetrics(input: TrackCampaignMetricsInput): Promise<Record<string, unknown>>;
}

async function classifyWithHaiku(content: string): Promise<SentimentResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { sentiment: 'AMBIGUOUS', confidence: 0 };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
      max_tokens: 100,
      temperature: 0,
      system: 'Classifique a resposta B2B em JSON estrito: {"sentiment":"POSITIVE|NEGATIVE|NEUTRAL|AMBIGUOUS","confidence":0-100}. Seja conservador.',
      messages: [{ role: 'user', content }],
    });
    const text = response.content.find(block => block.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text) as SentimentResult;
    if (!['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'AMBIGUOUS'].includes(parsed.sentiment)) throw new Error('Invalid sentiment');
    return { sentiment: parsed.sentiment, confidence: Math.max(0, Math.min(100, Number(parsed.confidence))) };
  } catch {
    return { sentiment: 'AMBIGUOUS', confidence: 0 };
  }
}

const prismaRepository: AnalyticsRepository = {
  async recordFeedback(input, classified) {
    const sentiment = classified ?? { sentiment: input.sentiment ?? 'AMBIGUOUS', confidence: input.confidence ?? 0 };
    const review = requiresHumanReview(sentiment);
    const feedback = await prisma.$transaction(async tx => {
      const feedback = await tx.leadInteractionFeedback.create({
        data: {
          campaignId: input.campaign_id,
          leadId: input.lead_id,
          messageId: input.message_id,
          interactionType: input.interaction_type,
          sentiment: sentiment.sentiment,
          confidence: sentiment.confidence,
          requiresHumanReview: review,
          content: input.content,
          provider: input.provider,
        },
      });

      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      const increments = {
        openCount: input.interaction_type === 'OPEN' ? 1 : 0,
        clickCount: input.interaction_type === 'CLICK' ? 1 : 0,
        replyCount: input.interaction_type === 'REPLY' ? 1 : 0,
        bounceCount: input.interaction_type === 'BOUNCE' ? 1 : 0,
        positiveReplies: input.interaction_type === 'REPLY' && sentiment.sentiment === 'POSITIVE' ? 1 : 0,
        negativeReplies: input.interaction_type === 'REPLY' && sentiment.sentiment === 'NEGATIVE' ? 1 : 0,
      };
      await tx.campaignMetric.upsert({
        where: { campaignId_metricDate: { campaignId: input.campaign_id, metricDate: date } },
        create: { campaignId: input.campaign_id, metricDate: date, ...increments },
        update: {
          openCount: { increment: increments.openCount }, clickCount: { increment: increments.clickCount },
          replyCount: { increment: increments.replyCount }, bounceCount: { increment: increments.bounceCount },
          positiveReplies: { increment: increments.positiveReplies }, negativeReplies: { increment: increments.negativeReplies },
        },
      });

      if (input.message_id) {
        const status = input.interaction_type === 'OPEN' ? 'OPENED' : input.interaction_type === 'CLICK' ? 'CLICKED' : input.interaction_type === 'REPLY' ? 'REPLIED' : 'BOUNCED';
        const message = await tx.outreachMessage.update({ where: { id: input.message_id }, data: { status, ...(input.interaction_type === 'REPLY' ? { repliedAt: new Date(), replySentiment: sentiment.sentiment } : {}) }, select: { signalId: true } });
        if (input.interaction_type === 'REPLY' && message.signalId) {
          const signal = await tx.intentSignal.findUnique({ where: { id: message.signalId }, select: { intentWeight: true } });
          if (signal) await tx.intentSignal.update({ where: { id: message.signalId }, data: { intentWeight: applySignalFeedback(Number(signal.intentWeight), sentiment.sentiment) } });
        }
      }

      if (input.interaction_type === 'REPLY') {
        const sequences = await tx.outreachSequence.findMany({ where: { campaignId: input.campaign_id, status: 'ACTIVE', leads: { some: { id: input.lead_id } } }, select: { id: true } });
        for (const sequence of sequences) await tx.outreachSequence.update({ where: { id: sequence.id }, data: { status: 'PAUSED', pausedUntil: null } });
        await tx.lead.update({ where: { id: input.lead_id }, data: { status: sentiment.sentiment === 'POSITIVE' ? 'REPLIED_POSITIVE' : sentiment.sentiment === 'NEGATIVE' ? 'REPLIED_NEGATIVE' : 'ENGAGED' } });
      }
      if (input.interaction_type === 'BOUNCE') await tx.lead.update({ where: { id: input.lead_id }, data: { status: 'BOUNCED' } });
      return feedback;
    });
    return { feedbackId: feedback.id, requiresHumanReview: review };
  },

  async getMetrics(input) {
    const rows = await prisma.campaignMetric.findMany({ where: { campaignId: input.campaign_id, ...(input.period_start || input.period_end ? { metricDate: { gte: input.period_start, lte: input.period_end } } : {}) }, orderBy: { metricDate: 'asc' } });
    const sentCount = await prisma.outreachMessage.count({ where: { campaignId: input.campaign_id, sentAt: { not: null, gte: input.period_start, lte: input.period_end } } });
    const totals = rows.reduce((result, row) => ({ sent: result.sent + row.sentCount, opens: result.opens + row.openCount, clicks: result.clicks + row.clickCount, replies: result.replies + row.replyCount, bounces: result.bounces + row.bounceCount, positive_replies: result.positive_replies + row.positiveReplies, negative_replies: result.negative_replies + row.negativeReplies }), { sent: sentCount, opens: 0, clicks: 0, replies: 0, bounces: 0, positive_replies: 0, negative_replies: 0 });
    totals.sent = Math.max(totals.sent, sentCount);
    return { campaign_id: input.campaign_id, period_start: input.period_start?.toISOString() ?? null, period_end: input.period_end?.toISOString() ?? null, ...totals, open_rate: totals.sent ? totals.opens / totals.sent : 0, click_rate: totals.sent ? totals.clicks / totals.sent : 0, reply_rate: totals.sent ? totals.replies / totals.sent : 0, bounce_rate: totals.sent ? totals.bounces / totals.sent : 0 };
  },
};

export class AnalyticsService {
  constructor(private readonly repository: AnalyticsRepository = prismaRepository) {}

  async recordFeedback(rawInput: RecordLeadInteractionFeedbackInput) {
    const input = RecordLeadInteractionFeedbackInputSchema.parse(rawInput);
    const sentiment = input.interaction_type === 'REPLY' && !input.sentiment
      ? await classifyWithHaiku(input.content ?? '')
      : input.sentiment ? { sentiment: input.sentiment, confidence: input.confidence ?? 100 } : undefined;
    return this.repository.recordFeedback(input, sentiment);
  }

  async trackMetrics(input: TrackCampaignMetricsInput) {
    return this.repository.getMetrics(input);
  }
}

export const analyticsService = new AnalyticsService();
