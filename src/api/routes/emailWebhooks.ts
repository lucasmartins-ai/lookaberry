import type { FastifyInstance } from 'fastify';
import { analyticsService } from '../../core/analytics/service.js';
import type { RecordLeadInteractionFeedbackInput } from '../../mcp/schemas/analytics.js';
import { findMessageContext, type MessageContext } from './emailTracking.js';
import { prisma } from '../../db/client.js';
import { processWebhookEvent, createWebhookStoreFromPrisma } from '../../core/execution/webhookIdempotency.js';

/**
 * Resend delivers webhooks via Svix with events like `email.delivered`,
 * `email.opened`, `email.clicked`, `email.bounced`, `email.complained`.
 *
 * The adapter injects the internal outreach message id as the `X-Message-ID`
 * header on every send, so events can be mapped back to a message.
 */
interface ResendEventMapping {
  interactionType: 'OPEN' | 'CLICK' | 'BOUNCE';
  /** Flagged for human review (complaints) */
  requiresReview: boolean;
  content?: string;
}

const RESEND_EVENT_MAP: Record<string, ResendEventMapping> = {
  'email.delivered': { interactionType: 'OPEN', requiresReview: false, content: 'delivered' },
  'email.opened': { interactionType: 'OPEN', requiresReview: false, content: 'opened' },
  'email.clicked': { interactionType: 'CLICK', requiresReview: false, content: 'clicked' },
  'email.bounced': { interactionType: 'BOUNCE', requiresReview: false, content: 'bounced' },
  'email.complained': {
    interactionType: 'OPEN',
    requiresReview: true,
    content: 'SPAM complaint — flagged for human review',
  },
};

export interface EmailWebhookDependencies {
  /** Injectable analytics (tests) */
  analytics?: { recordFeedback(input: RecordLeadInteractionFeedbackInput): Promise<unknown> };
  /** Injectable message lookup (tests) */
  findMessage?: (messageId: string) => Promise<MessageContext | null>;
  /** S14: Injectable webhook event processor (tests). Takes a single payload object. */
  processWebhookEvent?: (payload: Parameters<typeof processWebhookEvent>[1]) => Promise<{ alreadyProcessed: boolean; invalidTransition: boolean; idempotencyKey?: string }>;
}

export async function emailWebhookRoutes(app: FastifyInstance, opts: EmailWebhookDependencies = {}) {
  const analytics = opts.analytics ?? analyticsService;
  const findMessage = opts.findMessage ?? findMessageContext;
  // S14: Webhook store for idempotency (lazy init — only if processWebhookEvent not mocked)
  const processEvent = opts.processWebhookEvent
    ?? (() => {
      try {
        const store = createWebhookStoreFromPrisma(prisma);
        return (payload: Parameters<typeof processWebhookEvent>[1]) => processWebhookEvent(store, payload);
      } catch {
        // idempotencyKey model not available (e.g., test environment with mocked Prisma)
        // Return a no-op processor that passes through all events
        return (payload: Parameters<typeof processWebhookEvent>[1]) =>
          Promise.resolve({ alreadyProcessed: false, invalidTransition: false, idempotencyKey: '' });
      }
    })();

  app.post('/api/v1/email/webhooks/resend', async (request, reply) => {
    const body = (request.body ?? {}) as { type?: unknown; data?: Record<string, unknown> };
    const eventType = typeof body.type === 'string' ? body.type : '';

    const mapping = RESEND_EVENT_MAP[eventType];
    if (!mapping) {
      // Unknown / unhandled event type — acknowledge to stop provider retries
      return reply.status(202).send({ received: true, ignored: eventType || 'unknown' });
    }

    const messageId = request.headers['x-message-id'];
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return reply.status(202).send({ received: true, ignored: 'no-x-message-id' });
    }

    const feedback: RecordLeadInteractionFeedbackInput = {
      campaign_id: '',
      lead_id: '',
      message_id: messageId,
      interaction_type: mapping.interactionType,
      provider: 'resend',
      ...(mapping.content ? { content: mapping.content } : {}),
      // Complaints are bucketed as OPEN but flagged for human review
      ...(mapping.requiresReview ? { sentiment: 'AMBIGUOUS' as const, confidence: 0 } : {}),
    };

    try {
      const msg = await findMessage(messageId);
      if (!msg) {
        return reply.status(202).send({ received: true, ignored: 'message-not-found' });
      }
      feedback.campaign_id = msg.campaignId;
      feedback.lead_id = msg.leadId;
      // S14: Idempotency check
      const eventResult = await processEvent({
        messageId,
        leadId: msg.leadId,
        eventType: mapping.interactionType === 'BOUNCE' ? 'BOUNCE' : 'OPEN',
      });

      if (eventResult.alreadyProcessed) {
        return reply.status(202).send({ received: true, deduplicated: true });
      }

      await analytics.recordFeedback(feedback);
      return reply.status(202).send({ received: true });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(202).send({ received: true, error: 'processing-failed' });
    }
  });

  // NOTE: relay providers (SendGrid/Mailgun) that expose SMTP also send webhooks;
  // they can be handled by this same pipeline (map their payload into the Resend
  // event shape) with the provider identified via an `X-Provider` header.
}
