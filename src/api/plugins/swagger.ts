import { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function setupSwagger(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'LookaBerry GTM Outbound Engine API',
        description: 'Headless AI Go-To-Market & Outbound Engine with PostgreSQL pgvector and MCP Server',
        version: '0.1.0',
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Local development server',
        },
      ],
      tags: [
        { name: 'Health', description: 'System health & diagnostic endpoints' },
        { name: 'ICP', description: 'Ideal Customer Profile analysis and vectors' },
        { name: 'MCP', description: 'Model Context Protocol SSE endpoints' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}
