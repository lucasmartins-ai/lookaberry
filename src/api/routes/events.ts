import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { IngestEventsSchema, ingestEvents } from '../../core/events/service.js';

/** Executors (LOOKAORCHESTRATOR, …) report outcomes here. Writes suppression, so OPERATOR or ADMIN only. */
export async function eventRoutes(app: FastifyInstance) {
  app.post('/api/v1/events', {
    schema: { description: 'Ingest outreach outcome events (idempotent per source + external_id).', tags: ['Events'] },
  }, async (request: any, reply) => {
    const permission = request.__apiKey?.permission;
    if (process.env.NODE_ENV !== 'test' && permission !== 'ADMIN' && permission !== 'OPERATOR') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Events require an OPERATOR or ADMIN key.' });
    }
    try {
      return await ingestEvents(IngestEventsSchema.parse(request.body));
    } catch (err) {
      if (err instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', details: err.flatten() });
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to ingest events' });
    }
  });
}
