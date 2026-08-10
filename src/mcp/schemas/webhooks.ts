import { z } from 'zod';
import { InteractionTypeSchema } from './analytics.js';

export const OutreachWebhookInputSchema = z.object({
  campaign_id: z.string().uuid(),
  lead_id: z.string().uuid(),
  message_id: z.string().uuid().optional(),
  event: InteractionTypeSchema,
  content: z.string().trim().max(50000).optional(),
  provider: z.string().trim().max(100).optional(),
});

export type OutreachWebhookInput = z.infer<typeof OutreachWebhookInputSchema>;
