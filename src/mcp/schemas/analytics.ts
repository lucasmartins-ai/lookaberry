import { z } from 'zod';

export const InteractionTypeSchema = z.enum(['OPEN', 'CLICK', 'REPLY', 'BOUNCE']);
export const FeedbackSentimentSchema = z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'AMBIGUOUS']);

export const TrackCampaignMetricsInputSchema = z.object({
  campaign_id: z.string().uuid(),
  period_start: z.coerce.date().optional(),
  period_end: z.coerce.date().optional(),
});

export const RecordLeadInteractionFeedbackInputSchema = z.object({
  campaign_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  message_id: z.string().uuid().optional(),
  interaction_type: InteractionTypeSchema,
  content: z.string().trim().max(50000).optional(),
  provider: z.string().trim().max(100).optional(),
  sentiment: FeedbackSentimentSchema.optional(),
  confidence: z.number().min(0).max(100).optional(),
});

export type TrackCampaignMetricsInput = z.infer<typeof TrackCampaignMetricsInputSchema>;
export type RecordLeadInteractionFeedbackInput = z.infer<typeof RecordLeadInteractionFeedbackInputSchema>;
