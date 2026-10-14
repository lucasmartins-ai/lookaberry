import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { DIMENSIONS, getInsights } from '../../core/learning/service.js';

const QuerySchema = z.object({
  by: z.enum(DIMENSIONS).default('segment'),
  min_sent: z.coerce.number().int().min(1).max(10_000).default(30),
  since: z.coerce.date().optional(),
});

/** What converts: positive-reply rates by segment / channel / variant / campaign / hour. Aggregates only, no PII. */
export async function insightRoutes(app: FastifyInstance) {
  app.get('/api/v1/insights', {
    schema: { description: 'Learned conversion insights from outreach_events (last-touch attribution).', tags: ['Learning'] },
  }, async (request, reply) => {
    try {
      const q = QuerySchema.parse(request.query);
      return await getInsights(q.by, q.min_sent, q.since);
    } catch (err) {
      if (err instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', details: err.flatten() });
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to compute insights' });
    }
  });
}
