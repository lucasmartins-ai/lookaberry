import type { FastifyInstance } from 'fastify';
import { analyticsService } from '../../core/analytics/service.js';
import { prisma } from '../../db/client.js';
import { markMessageEngagement, type MessageEngagementType } from '../../core/execution/feedbackLoop.js';
import type { RecordLeadInteractionFeedbackInput } from '../../mcp/schemas/analytics.js';

const NO_CACHE_HEADERS = 'no-store, no-cache, must-revalidate, max-age=0';
const MAX_REDIRECT_URL_LENGTH = 2048;
/** 1x1 transparent GIF */
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export interface MessageContext {
  campaignId: string;
  leadId: string;
}

/** Resolve the campaign/lead for a message id from the DB */
export async function findMessageContext(messageId: string): Promise<MessageContext | null> {
  const message = await prisma.outreachMessage.findUnique({
    where: { id: messageId },
    select: { campaignId: true, leadId: true },
  });
  return message ? { campaignId: message.campaignId, leadId: message.leadId } : null;
}

export interface EmailTrackingDependencies {
  /** Injectable analytics (tests) */
  analytics?: { recordFeedback(input: RecordLeadInteractionFeedbackInput): Promise<unknown> };
  /** Injectable message lookup (tests) */
  findMessage?: (messageId: string) => Promise<MessageContext | null>;
  /** Injectable S10 engagement timestamp writer (tests) */
  markEngagement?: (messageId: string, interactionType: MessageEngagementType) => Promise<void>;
}

export async function emailTrackingRoutes(app: FastifyInstance, opts: EmailTrackingDependencies = {}) {
  const analytics = opts.analytics ?? analyticsService;
  const findMessage = opts.findMessage ?? findMessageContext;
  const markEngagement = opts.markEngagement ?? ((messageId: string, interactionType: MessageEngagementType) => markMessageEngagement(messageId, interactionType));

  /** Record an OPEN/CLICK event. Never throws — tracking must not break the pixel/redirect. */
  async function record(messageId: string, interactionType: 'OPEN' | 'CLICK', correlationId?: string): Promise<void> {
    try {
      const msg = await findMessage(messageId);
      if (!msg) return;
      const feedback = analytics.recordFeedback({
        campaign_id: msg.campaignId,
        lead_id: msg.leadId,
        message_id: messageId,
        interaction_type: interactionType,
        provider: 'email',
      });
      const engagement = markEngagement(messageId, interactionType);
      const results = await Promise.allSettled([feedback, engagement]);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      app.log.info({
        msg: 'email_tracking_recorded',
        interactionType,
        messageId,
        correlationId,
      });
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err), correlationId },
        `email_tracking_${interactionType.toLowerCase()}_failed`,
      );
    }
  }

  // 1x1 tracking pixel — mail clients pre-fetch, so this route is exempt from
  // auth and rate limiting (see plugins/auth.ts and plugins/rateLimit.ts).
  app.get('/api/v1/email/track/open/:messageId', async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    reply.header('Cache-Control', NO_CACHE_HEADERS);
    reply.header('Content-Type', 'image/gif');
    await record(messageId, 'OPEN', request.correlationId ?? request.id);
    return reply.status(200).send(TRANSPARENT_GIF);
  });

  // Click redirect — logs the click then 302s to the original URL.
  app.get('/api/v1/email/track/click/:messageId', async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    const url = (request.query as Record<string, unknown>).url;

    reply.header('Cache-Control', NO_CACHE_HEADERS);
    if (
      typeof url !== 'string' ||
      url.length === 0 ||
      url.length > MAX_REDIRECT_URL_LENGTH ||
      !/^https?:\/\//i.test(url)
    ) {
      return reply.status(400).send({ error: 'Invalid URL' });
    }

    await record(messageId, 'CLICK', request.correlationId ?? request.id);
    return reply.status(302).redirect(url);
  });
}
