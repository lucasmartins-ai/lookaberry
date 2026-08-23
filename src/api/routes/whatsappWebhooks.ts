import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

/**
 * WhatsApp (Meta) webhook handler.
 *
 * GET  /api/v1/webhooks/whatsapp — verification handshake (handled by webhookAuth plugin)
 * POST /api/v1/webhooks/whatsapp — inbound messages and delivery statuses
 *
 * Meta requires a 200 response within 20 seconds.
 * Feedback recording is best-effort — failures are logged but never block the ack.
 */

interface WhatsAppInboundMessage {
  from: string;       // wa_id
  id: string;         // wamid
  timestamp: string;
  type: 'text' | string;
  text?: { body: string };
}

interface WhatsAppStatus {
  id: string;         // wamid
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string }>;
}

interface WhatsAppWebhookValue {
  messaging_product: 'whatsapp';
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  messages?: WhatsAppInboundMessage[];
  statuses?: WhatsAppStatus[];
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{ value: WhatsAppWebhookValue }>;
}

interface WhatsAppWebhookBody {
  object: 'whatsapp_business_account';
  entry: WhatsAppWebhookEntry[];
}

// ─────────────────────────── Resolve lead from phone ───────────────────────────

async function findLeadByPhone(phone: string): Promise<{
  leadId: string;
  messageId: string;
  campaignId: string;
} | null> {
  try {
    const { prisma } = await import('../../db/client.js');

    // Find the most recent OutreachMessage for this phone number
    const message = await prisma.outreachMessage.findFirst({
      where: {
        lead: { phone },
      },
      orderBy: { sentAt: 'desc' },
      select: {
        id: true,
        leadId: true,
        campaignId: true,
      },
    });

    if (!message) {
      console.warn(`[WhatsApp Webhook] No OutreachMessage found for phone: ${phone}`);
      return null;
    }

    return {
      leadId: message.leadId,
      messageId: message.id,
      campaignId: message.campaignId,
    };
  } catch (err) {
    console.warn(`[WhatsApp Webhook] DB lookup failed for phone ${phone}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─────────────────────────── Process an inbound message ───────────────────────────

async function processInboundMessage(msg: WhatsAppInboundMessage): Promise<void> {
  const waId = msg.from;
  const body = msg.text?.body ?? '';
  if (!body) {
    console.log(`[WhatsApp Webhook] Inbound message from ${waId} has no text body — ignored.`);
    return;
  }

  const leadInfo = await findLeadByPhone(waId);
  if (!leadInfo) return;

  try {
    // Record REPLY feedback
    const { analyticsService } = await import('../../core/analytics/service.js');
    const { classifySentiment } = await import('../../core/execution/inboxWorker.js');

    const sentimentResult = classifySentiment(body);

    await analyticsService.recordFeedback({
      campaign_id: leadInfo.campaignId,
      lead_id: leadInfo.leadId,
      message_id: leadInfo.messageId,
      interaction_type: 'REPLY',
      sentiment: sentimentResult.sentiment as any,
      confidence: sentimentResult.confidence,
      content: body,
      provider: 'whatsapp',
    });

    console.log(`[WhatsApp Webhook] Reply from ${waId} → ${sentimentResult.sentiment} (${sentimentResult.confidence}%)`);
  } catch (err) {
    console.warn(`[WhatsApp Webhook] Could not record reply feedback: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Update OutreachMessage.repliedAt and replySentiment
  try {
    const { prisma } = await import('../../db/client.js');
    await prisma.outreachMessage.update({
      where: { id: leadInfo.messageId },
      data: {
        repliedAt: new Date(),
        replySentiment: body.slice(0, 50),
      },
    });
  } catch (err) {
    console.warn(`[WhatsApp Webhook] Could not update message repliedAt: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────── Process a status update ───────────────────────────

async function processStatusUpdate(status: WhatsAppStatus): Promise<void> {
  const wamid = status.id;

  try {
    const { prisma } = await import('../../db/client.js');
    const { analyticsService } = await import('../../core/analytics/service.js');

    // Find the message by externalMessageId (wamid)
    const message = await prisma.outreachMessage.findFirst({
      where: { externalMessageId: wamid },
      select: {
        id: true,
        leadId: true,
        campaignId: true,
        status: true,
      },
    });

    if (!message) {
      console.warn(`[WhatsApp Webhook] No message found for wamid: ${wamid}`);
      return;
    }

    switch (status.status) {
      case 'delivered': {
        // Update message status
        await prisma.outreachMessage.update({
          where: { id: message.id },
          data: { status: 'DELIVERED' },
        });
        // Record OPEN feedback for delivery
        await analyticsService.recordFeedback({
          campaign_id: message.campaignId,
          lead_id: message.leadId,
          message_id: message.id,
          interaction_type: 'OPEN',
          provider: 'whatsapp',
        }).catch(err => console.warn(`[WhatsApp Webhook] Could not record delivery feedback: ${err}`));
        console.log(`[WhatsApp Webhook] Message ${wamid} delivered`);
        break;
      }
      case 'read': {
        await prisma.outreachMessage.update({
          where: { id: message.id },
          data: { status: 'OPENED' },
        });
        await analyticsService.recordFeedback({
          campaign_id: message.campaignId,
          lead_id: message.leadId,
          message_id: message.id,
          interaction_type: 'OPEN',
          provider: 'whatsapp',
        }).catch(err => console.warn(`[WhatsApp Webhook] Could not record read feedback: ${err}`));
        console.log(`[WhatsApp Webhook] Message ${wamid} read`);
        break;
      }
      case 'failed': {
        const errorCode = status.errors?.[0]?.code ?? 0;
        await prisma.outreachMessage.update({
          where: { id: message.id },
          data: {
            status: 'FAILED',
            errorReason: `WhatsApp delivery failed (code: ${errorCode}): ${status.errors?.[0]?.title ?? 'unknown'}`,
          },
        });
        console.warn(`[WhatsApp Webhook] Message ${wamid} failed (code: ${errorCode})`);
        break;
      }
      case 'sent':
      default:
        // No-op for sent (message already SENT at dispatch time)
        break;
    }
  } catch (err) {
    console.warn(`[WhatsApp Webhook] Could not process status update for ${wamid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────── Route registration ───────────────────────────

export async function whatsappWebhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST webhook: inbound messages + delivery statuses.
   * Signature validated by webhookAuth plugin preHandler.
   * Always responds 200 quickly (Meta requires ack within 20s).
   */
  app.post('/api/v1/webhooks/whatsapp', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const body = request.body as WhatsAppWebhookBody;

    if (!body || body.object !== 'whatsapp_business_account') {
      return reply.status(200).send('ok');
    }

    // Process all entries — best effort, never block the response
    const promises: Promise<void>[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;

        // Inbound messages
        if (value.messages) {
          for (const msg of value.messages) {
            promises.push(processInboundMessage(msg).catch(() => {}));
          }
        }

        // Status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            promises.push(processStatusUpdate(status).catch(() => {}));
          }
        }
      }
    }

    // Respond immediately — feedback processing is best-effort (fire-and-forget)
    reply.status(200).send('ok');

    // Let background work finish (don't hold the response)
    await Promise.allSettled(promises);
  });
}