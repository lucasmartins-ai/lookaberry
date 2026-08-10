import { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client.js';
import { redisConnection } from '../../core/queues/queue.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    '/health',
    {
      schema: {
        description: 'Check service health, database and redis connectivity',
        tags: ['Health'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              database: { type: 'string' },
              redis: { type: 'string' },
              version: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              database: { type: 'string' },
              redis: { type: 'string' },
              version: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      let dbStatus = 'ok';
      let redisStatus = 'ok';

      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (err: any) {
        dbStatus = `unreachable: ${err.message}`;
      }

      try {
        await redisConnection.ping();
      } catch (err: any) {
        redisStatus = `unreachable: ${err.message}`;
      }

      const isHealthy = dbStatus === 'ok' && redisStatus === 'ok';

      return reply.status(isHealthy ? 200 : 503).send({
        status: isHealthy ? 'healthy' : 'degraded',
        database: dbStatus,
        redis: redisStatus,
        version: '0.1.0',
        timestamp: new Date().toISOString(),
      });
    }
  );
}
