import type { FastifyInstance } from 'fastify';
import { analyticsService } from '../../core/analytics/service.js';
import type { RecordLeadInteractionFeedbackInput } from '../../mcp/schemas/analytics.js';
import { findMessageContext, type MessageContext } from './emailTracking.js';

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
}

export async function emailWebhookRoutes(app: FastifyInstance, opts: EmailWebhookDependencies = {}) {
  const analytics = opts.analytics ?? analyticsService;
  const findMessage = opts.findMessage ?? findMessageContext;

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
      await analytics.recordFeedback(feedback);
      return reply.status(202).send({ received: true });
    } catch (err) {
      // Always acknowledge — a failed webhook would otherwise be retried by the
      // provider; the event is logged for manual inspection.
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(202).send({ received: true, error: 'processing-failed' });
    }
  });

  // NOTE: relay providers (SendGrid/Mailgun) that expose SMTP also send webhooks;
  // they can be handled by this same pipeline (map their payload into the Resend
  // event shape) with the provider identified via an `X-Provider` header.
}
