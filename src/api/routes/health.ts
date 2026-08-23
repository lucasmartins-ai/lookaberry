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
      const HEALTH_TIMEOUT_MS = 2000;

      const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${HEALTH_TIMEOUT_MS}ms`)), HEALTH_TIMEOUT_MS),
          ),
        ]);

      const [dbResult, redisResult] = await Promise.allSettled([
        withTimeout(prisma.$queryRaw`SELECT 1`, 'database'),
        withTimeout(redisConnection.ping(), 'redis'),
      ]);

      const dbStatus = dbResult.status === 'fulfilled' ? 'ok' : `unreachable: ${(dbResult as PromiseRejectedResult).reason?.message ?? 'unknown error'}`;
      const redisStatus = redisResult.status === 'fulfilled' ? 'ok' : `unreachable: ${(redisResult as PromiseRejectedResult).reason?.message ?? 'unknown error'}`;

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
