import { z } from 'zod';

export const IntentSignalTypeSchema = z.enum([
  'HIRING',
  'FUNDING',
  'TECH_INSTALL',
  'LEADERSHIP_CHANGE',
  'CONTENT_ENGAGEMENT',
  'WEBSITE_CHANGE',
  'PUBLIC_ANNOUNCEMENT',
]);

export const EvidenceClassificationSchema = z.enum([
  'FACT',
  'INFERENCE',
  'LLM_INFERENCE',
  'USER_PROVIDED',
  'UNVERIFIED',
]);

export const JobPostingInputSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1).optional(),
  description: z.string().optional(),
  department: z.string().optional(),
  published_at: z.coerce.date().optional(),
  metadata: z.unknown().optional(),
});

export const AnnouncementInputSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1).optional(),
  summary: z.string().optional(),
  kind: z.string().optional(),
  published_at: z.coerce.date().optional(),
  metadata: z.unknown().optional(),
});

export const SignalCollectionInputSchema = z.object({
  company_domain: z.string().min(1),
  company_name: z.string().min(1),
  company_industry: z.string().optional(),
  company_description: z.string().optional(),
  company_tech_stack: z.array(z.string()).optional(),
  company_website_url: z.string().url().optional(),
  website_url: z.string().url().optional(),
  website_content: z.string().optional(),
  website_html: z.string().optional(),
  previous_website_content: z.string().optional(),
  previous_website_html: z.string().optional(),
  website_changed: z.boolean().optional(),
  hiring_url: z.string().url().optional(),
  hiring_html: z.string().optional(),
  job_postings: z.array(JobPostingInputSchema).optional(),
  announcements_url: z.string().url().optional(),
  announcements_html: z.string().optional(),
  announcement_items: z.array(AnnouncementInputSchema).optional(),
  metadata: z.unknown().optional(),
});

export const IntentSignalInputSchema = z.object({
  company_domain: z.string().min(1),
  company_name: z.string().min(1),
  company_industry: z.string().optional(),
  company_description: z.string().optional(),
  company_tech_stack: z.array(z.string()).optional(),
  signal_type: IntentSignalTypeSchema,
  provider_id: z.string().min(1).optional(),
  source: z.string().min(1),
  source_url: z.string().url().optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  raw_payload: z.record(z.unknown()).optional(),
  normalized_data: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  weight: z.number().min(0).max(100).optional(),
  ttl_days: z.number().int().positive().max(3650).optional(),
  observed_at: z.coerce.date().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source_quality: z.number().min(0).max(1).optional(),
  evidence_classification: EvidenceClassificationSchema.optional(),
  cost: z.number().min(0).optional(),
  deduplication_key: z.string().min(1).optional(),
});

export const DetectIntentSignalsInputSchema = z.object({
  icp_id: z.string().uuid(),
  signal_types: z.array(IntentSignalTypeSchema).optional(),
  provider_ids: z.array(z.string().min(1)).optional(),
  provider_timeout_ms: z.number().int().positive().max(60_000).default(10_000),
  collection_inputs: z.array(SignalCollectionInputSchema).optional(),
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
