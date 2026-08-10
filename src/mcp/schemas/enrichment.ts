import { z } from 'zod';

export const WaterfallEnrichLeadInputSchema = z.object({
  lead_id: z.string().uuid(),
  force_refresh: z.boolean().optional().default(false),
});

export const WaterfallEnrichLeadOutputSchema = z.object({
  lead_id: z.string().uuid(),
  email: z.string().email().optional(),
  email_status: z.enum(['VERIFIED', 'RISKY', 'INVALID', 'NOT_FOUND']),
  linkedin_url: z.string().optional(),
  phone: z.string().optional(),
  provider_used: z.string(),
  credits_consumed: z.number(),
});

export type WaterfallEnrichLeadInput = z.input<typeof WaterfallEnrichLeadInputSchema>;
export type WaterfallEnrichLeadOutput = z.infer<typeof WaterfallEnrichLeadOutputSchema>;
