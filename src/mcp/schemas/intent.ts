import { z } from 'zod';

export const IntentSignalTypeSchema = z.enum([
  'HIRING',
  'FUNDING',
  'TECH_INSTALL',
  'LEADERSHIP_CHANGE',
  'CONTENT_ENGAGEMENT',
]);

export const IntentSignalInputSchema = z.object({
  company_domain: z.string().min(1),
  company_name: z.string().min(1),
  company_industry: z.string().optional(),
  company_description: z.string().optional(),
  company_tech_stack: z.array(z.string()).optional(),
  signal_type: IntentSignalTypeSchema,
  source: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  raw_payload: z.record(z.unknown()).optional(),
  weight: z.number().min(0).max(100).optional(),
  ttl_days: z.number().int().positive().max(365).optional(),
});

export const DetectIntentSignalsInputSchema = z.object({
  icp_id: z.string().uuid(),
  signal_types: z.array(IntentSignalTypeSchema).optional(),
  min_weight: z.number().min(0).max(100).default(50),
  limit: z.number().int().positive().max(100).default(20),
  signals: z.array(IntentSignalInputSchema).optional(),
});

export const ScoreAndRankLeadsInputSchema = z.object({
  icp_id: z.string().uuid(),
  min_score: z.number().min(0).max(100).default(60),
  limit: z.number().int().positive().max(100).default(25),
  status_filter: z.enum(['DISCOVERED', 'ENRICHED', 'READY']).default('READY'),
});

export type IntentSignalInput = z.infer<typeof IntentSignalInputSchema>;
export type DetectIntentSignalsInput = z.infer<typeof DetectIntentSignalsInputSchema>;
export type ScoreAndRankLeadsInput = z.infer<typeof ScoreAndRankLeadsInputSchema>;
