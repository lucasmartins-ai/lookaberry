import { z } from 'zod';

export const GenerateHyperPersonalizedMessageInputSchema = z.object({
  lead_id: z.string().uuid(),
  signal_id: z.string().uuid().optional(),
  channel: z.enum(['LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE', 'EMAIL']),
  tone: z.enum(['DIRECT_PEER', 'CONSULTATIVE', 'CONCISE_CHALLENGER']).optional().default('DIRECT_PEER'),
  /** Message written by the calling agent from the brief; LookaBerry validates it (guardrails, repetition). */
  draft: z.object({
    subject: z.string().nullable().optional(),
    body: z.string(),
    hook_used: z.string(),
  }).optional(),
});

export const GenerateHyperPersonalizedMessageOutputSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
  hook_used: z.string(),
  estimated_tokens_used: z.number().int().nonnegative(),
});

export type GenerateHyperPersonalizedMessageInput = z.input<typeof GenerateHyperPersonalizedMessageInputSchema>;
export type GenerateHyperPersonalizedMessageOutput = z.infer<typeof GenerateHyperPersonalizedMessageOutputSchema>;
