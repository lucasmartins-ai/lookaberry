import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { FastifyInstance } from 'fastify';
import { prisma } from '../../src/db/client.js';

describe('Fastify REST API Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('GET /health should return 200 with database and redis status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
    expect(body.database).toBe('ok');
    expect(body.redis).toBe('ok');
    expect(body.version).toBe('0.1.0');
  });

  it('POST /api/v1/icp/analyze should create an ICP record and return structured personas', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/icp/analyze',
      payload: {
        website_url: 'https://github.com',
        description: 'Developer collaboration and code hosting platform',
        target_geos: ['US', 'LATAM', 'EU'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.icp_id).toBeDefined();
    expect(body.company_summary).toBeDefined();
    expect(Array.isArray(body.target_personas)).toBe(true);
    expect(body.target_personas.length).toBeGreaterThan(0);
    expect(Array.isArray(body.value_propositions)).toBe(true);

    // Verify it can be retrieved via GET /api/v1/icp/:id
    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/icp/${body.icp_id}`,
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.id).toBe(body.icp_id);
    expect(getBody.personas.length).toBeGreaterThan(0);

    // Cleanup
    await prisma.icpProfile.delete({ where: { id: body.icp_id } });
  });
});
