import { FastifyInstance } from 'fastify';
import { icpService } from '../../core/icp/service.js';
import { AnalyzeIcpInputSchema } from '../../mcp/schemas/icp.js';
import { findLookalikes } from '../../core/learning/lookalike.js';

export async function icpRoutes(app: FastifyInstance) {
  app.post(
    '/api/v1/icp/analyze',
    {
      schema: {
        description: 'Analyze company website, extract personas, value props and generate 1536-dim pgvector embedding',
        tags: ['ICP'],
        body: {
          type: 'object',
          required: ['website_url'],
          properties: {
            website_url: { type: 'string', description: 'URL of the target company website' },
            description: { type: 'string', description: 'Optional briefing or context' },
            target_geos: { type: 'array', items: { type: 'string' }, description: 'Target geographic regions' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              icp_id: { type: 'string', format: 'uuid' },
              company_summary: { type: 'string' },
              target_personas: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    seniority: { type: 'string' },
                    core_pain: { type: 'string' },
                  },
                },
              },
              value_propositions: { type: 'array', items: { type: 'string' } },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
            },
          },
          500: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsedBody = AnalyzeIcpInputSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parsedBody.error.flatten(),
        });
      }

      try {
        const result = await icpService.analyzeIcp(parsedBody.data);
        return reply.status(200).send(result);
      } catch (error: any) {
        app.log.error(error);
        return reply.status(500).send({
          error: 'ICP analysis failed',
          message: error.message,
        });
      }
    }
  );

  app.get(
    '/api/v1/icp/:id',
    {
      schema: {
        description: 'Get ICP profile details and personas by ID',
        tags: ['ICP'],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const profile = await icpService.getIcpProfile(id);

      if (!profile) {
        return reply.status(404).send({ error: 'ICP Profile not found' });
      }

      return reply.send(profile);
    }
  );

  app.get(
    '/api/v1/icp/:id/lookalikes',
    {
      schema: {
        description: 'Companies most similar to the ones that converted for this ICP (or to the ICP itself while there are fewer than 3 positives). Skips companies already replied/unsubscribed/bounced.',
        tags: ['ICP', 'Learning'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: number };
      try {
        return { icp_id: id, lookalikes: await findLookalikes(id, limit ?? 20) };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: 'Failed to compute lookalikes' });
      }
    }
  );
}
