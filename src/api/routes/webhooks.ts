import { FastifyInstance } from 'fastify';
import { analyticsService } from '../../core/analytics/service.js';
import { OutreachWebhookInputSchema } from '../../mcp/schemas/webhooks.js';

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/api/v1/webhooks/outreach', async (request, reply) => {
    const parsed = OutreachWebhookInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      const result = await analyticsService.recordFeedback({
        campaign_id: parsed.data.campaign_id,
        lead_id: parsed.data.lead_id,
        message_id: parsed.data.message_id,
        interaction_type: parsed.data.event,
        content: parsed.data.content,
        provider: parsed.data.provider,
      });
      return reply.status(202).send(result);
    } catch (error: any) {
      app.log.error(error);
      return reply.status(500).send({ error: 'Webhook processing failed', message: error.message });
    }
  });
}
