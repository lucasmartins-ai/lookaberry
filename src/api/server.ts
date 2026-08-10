import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { setupSwagger } from './plugins/swagger.js';
import { healthRoutes } from './routes/health.js';
import { icpRoutes } from './routes/icp.js';
import { mcpSseRoutes } from './routes/mcpSse.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'error' : 'info',
    },
  });

  await app.register(cors, {
    origin: '*',
  });

  await setupSwagger(app);
  await app.register(healthRoutes);
  await app.register(icpRoutes);
  await app.register(mcpSseRoutes);

  return app;
}
