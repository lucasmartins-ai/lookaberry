/**
 * Outcome events from external executors (LOOKAORCHESTRATOR today). They feed the learning
 * loop (outreach_events) and enforce opt-outs here, so a "stop" received by any executor
 * blocks every channel LookaBerry dispatches on.
 *
 * Privacy: people are stored only as person_hash; reply text is classified and discarded.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { classifyReply, REPLY_INTENTS, type ReplyIntent } from '../analytics/replyClassifier.js';
import { addToSuppressionList, normalizePhone, type SuppressionStore } from '../security/suppression.js';

export const EVENT_TYPES = ['SENT', 'REPLIED', 'BOUNCED', 'OPT_OUT', 'MEETING', 'PAID'] as const;

const EventSchema = z.object({
  external_id: z.string().min(1).max(200),
  type: z.enum(EVENT_TYPES),
  channel: z.string().min(1).max(50),
  occurred_at: z.coerce.date(),
  lead: z.object({
    external_id: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    linkedin_url: z.string().max(500).optional(),
    phone: z.string().max(50).optional(),
    company_domain: z.string().max(255).optional(),
    segment: z.string().max(120).optional(),
    region: z.string().max(120).optional(),
  }).default({}),
  campaign: z.string().max(120).optional(),
  variant: z.string().max(60).optional(),
  intent: z.enum(REPLY_INTENTS).optional(),
  /** Reply text: used to classify when `intent` is missing, never stored. */
  content: z.string().max(10_000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const IngestEventsSchema = z.object({
  source: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/),
  events: z.array(EventSchema).min(1).max(500),
});
export type IngestEventsInput = z.infer<typeof IngestEventsSchema>;
type EventInput = z.infer<typeof EventSchema>;

/** Stable pseudonymous id for a person across executors and channels. */
export function personHash(lead: EventInput['lead']): string | null {
  const key = lead.email?.trim().toLowerCase()
    || lead.linkedin_url?.trim().toLowerCase().replace(/\/+$/, '')
    || normalizePhone(lead.phone);
  return key ? crypto.createHash('sha256').update(key).digest('hex') : null;
}

const SENTIMENT: Record<ReplyIntent, string> = {
  INTERESTED: 'POSITIVE', MEETING: 'POSITIVE', QUESTION: 'NEUTRAL', OBJECTION_PRICE: 'NEUTRAL',
  NOT_NOW: 'NEUTRAL', WRONG_PERSON: 'NEUTRAL', NOT_INTERESTED: 'NEGATIVE', UNSUBSCRIBE: 'NEGATIVE',
  AUTO_REPLY: 'NEUTRAL', OTHER: 'AMBIGUOUS',
};

/** True when the event means "never contact this person again". */
export function isOptOut(type: EventInput['type'], intent?: ReplyIntent): boolean {
  return type === 'OPT_OUT' || (type === 'REPLIED' && (intent === 'UNSUBSCRIBE' || intent === 'NOT_INTERESTED'));
}

export interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  optOuts: number;
}

export async function ingestEvents(input: IngestEventsInput, db: typeof prisma = prisma): Promise<IngestResult> {
  // Resolve intents first (LLM/heuristic for replies without one). Sequential on purpose:
  // a 500-event batch must not fan out into 500 concurrent LLM calls.
  const resolved: Array<{ event: EventInput; intent: ReplyIntent | undefined }> = [];
  for (const event of input.events) {
    let intent = event.intent;
    if (!intent && event.type === 'REPLIED' && event.content?.trim()) {
      intent = (await classifyReply(event.content)).intent;
    }
    if (!intent && event.type === 'OPT_OUT') intent = 'UNSUBSCRIBE';
    if (!intent && event.type === 'MEETING') intent = 'MEETING';
    resolved.push({ event, intent });
  }

  // Link to LookaBerry leads when the same person exists here.
  const emails = [...new Set(resolved.map(r => r.event.lead.email?.trim().toLowerCase()).filter(Boolean) as string[])];
  const leads = emails.length
    ? await db.lead.findMany({ where: { email: { in: emails, mode: 'insensitive' } }, select: { id: true, email: true } })
    : [];
  const leadByEmail = new Map(leads.map(l => [l.email!.toLowerCase(), l.id]));

  const rows = resolved.map(({ event, intent }) => {
    const email = event.lead.email?.trim().toLowerCase();
    return {
      source: input.source,
      externalId: event.external_id,
      eventType: event.type,
      channel: event.channel.toLowerCase(),
      occurredAt: event.occurred_at,
      externalLeadId: event.lead.external_id ?? null,
      leadId: email ? leadByEmail.get(email) ?? null : null,
      personHash: personHash(event.lead),
      companyDomain: (event.lead.company_domain ?? email?.split('@')[1] ?? null)?.toLowerCase() ?? null,
      segment: event.lead.segment ?? null,
      region: event.lead.region ?? null,
      campaign: event.campaign ?? null,
      variant: event.variant ?? null,
      intent: intent ?? null,
      sentiment: intent ? SENTIMENT[intent] : null,
      metadata: (event.metadata ?? undefined) as any,
    };
  });

  const { count } = await db.outreachEvent.createMany({ data: rows, skipDuplicates: true });

  // Opt-outs: person-level suppression (email, LinkedIn, phone) — idempotent, applied on every delivery.
  let optOuts = 0;
  for (const { event, intent } of resolved) {
    if (!isOptOut(event.type, intent)) continue;
    optOuts++;
    const reason = `Opt-out reported by ${input.source} (${event.channel})`;
    const store = db as unknown as SuppressionStore;
    if (event.lead.email?.trim()) await addToSuppressionList(store, { suppressionType: 'EMAIL', value: event.lead.email, reason, addedBy: input.source, isAutomatic: true });
    if (event.lead.linkedin_url?.trim()) await addToSuppressionList(store, { suppressionType: 'LINKEDIN_URL', value: event.lead.linkedin_url, reason, addedBy: input.source, isAutomatic: true });
    if (normalizePhone(event.lead.phone)) await addToSuppressionList(store, { suppressionType: 'PHONE', value: event.lead.phone!, reason, addedBy: input.source, isAutomatic: true });
  }

  return { received: input.events.length, inserted: count, duplicates: input.events.length - count, optOuts };
}
