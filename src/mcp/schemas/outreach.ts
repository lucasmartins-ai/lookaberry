import { z } from 'zod';

export const OutreachChannelSchema = z.enum([
  'LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE', 'EMAIL',   // legacy
  'linkedin', 'email', 'whatsapp', 'manual',           // S4 ChannelId
]);

export const ScheduleOutreachSequenceInputSchema = z.object({
  campaign_id: z.string().uuid(),
  lead_ids: z.array(z.string().uuid()).min(1).max(1000),
  steps: z.array(z.object({
    channel: OutreachChannelSchema,
    delay_hours: z.number().int().min(0).max(720),
    prompt_template: z.string().trim().min(1).max(10000),
  })).min(2).max(12),
  start_at: z.coerce.date().optional(),
});

export const ScheduleOutreachSequenceOutputSchema = z.object({
  sequence_id: z.string(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']),
  next_step: z.number().int().nonnegative(),
  lead_count: z.number().int().positive(),
  next_run_at: z.string().datetime(),
});

export type ScheduleOutreachSequenceInput = z.input<typeof ScheduleOutreachSequenceInputSchema>;
export type ScheduleOutreachSequenceOutput = z.infer<typeof ScheduleOutreachSequenceOutputSchema>;
