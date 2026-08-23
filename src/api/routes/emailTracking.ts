import type { FastifyInstance } from 'fastify';
import { analyticsService } from '../../core/analytics/service.js';
import { prisma } from '../../db/client.js';
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
}

export async function emailTrackingRoutes(app: FastifyInstance, opts: EmailTrackingDependencies = {}) {
  const analytics = opts.analytics ?? analyticsService;
  const findMessage = opts.findMessage ?? findMessageContext;

  /** Record an OPEN/CLICK event. Never throws — tracking must not break the pixel/redirect. */
  async function record(messageId: string, interactionType: 'OPEN' | 'CLICK'): Promise<void> {
    try {
      const msg = await findMessage(messageId);
      if (!msg) return;
      await analytics.recordFeedback({
        campaign_id: msg.campaignId,
        lead_id: msg.leadId,
        message_id: messageId,
        interaction_type: interactionType,
        provider: 'email',
      });
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
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
    await record(messageId, 'OPEN');
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

    await record(messageId, 'CLICK');
    return reply.status(302).redirect(url);
  });
}
