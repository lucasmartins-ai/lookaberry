import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../../src/api/server.js';

/**
 * S12: Health check route regression tests.
 *
 * Verifies that each separated health endpoint exists, returns structured
 * JSON, and responds within a bounded time even when DB/Redis are down.
 */

const ORIGINAL_ENV = { ...process.env };

async function inject(app: Awaited<ReturnType<typeof buildServer>>, path: string) {
  return app.inject({ method: 'GET', url: `http://127.0.0.1:3000${path}` });
}

describe('Health check routes (S12)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('GET /health returns aggregate status with component breakdown', async () => {
    const start = Date.now();
    const res = await inject(app, '/health');
    const elapsed = Date.now() - start;

    expect([200, 503]).toContain(res.statusCode);
    expect(elapsed).toBeLessThan(8000); // 4 checks × 2s timeout each

    const body = JSON.parse(res.body);
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(body.version).toBe('0.1.0');
    expect(body.timestamp).toBeDefined();
    expect(body.components).toBeDefined();
    expect(body.components.database).toBeDefined();
    expect(body.components.pgvector).toBeDefined();
    expect(body.components.redis).toBeDefined();
    expect(body.components.queues).toBeDefined();

    // Each component reports a status
    for (const key of ['database', 'pgvector', 'redis', 'queues']) {
      expect(['ok', 'degraded', 'unreachable']).toContain(body.components[key].status);
    }
  });

  it('GET /health/db returns PostgreSQL status', async () => {
    const res = await inject(app, '/health/db');
    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(['ok', 'degraded', 'unreachable']).toContain(body.status);
  });

  it('GET /health/pgvector returns extension status', async () => {
    const res = await inject(app, '/health/pgvector');
    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(['ok', 'degraded', 'unreachable']).toContain(body.status);
  });

  it('GET /health/redis returns Redis status', async () => {
    const res = await inject(app, '/health/redis');
    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(['ok', 'degraded', 'unreachable']).toContain(body.status);
  });

  it('GET /health/queues returns queue inspection', async () => {
    const res = await inject(app, '/health/queues');
    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(['ok', 'degraded', 'unreachable']).toContain(body.status);
    if (body.status === 'ok') {
      expect(Array.isArray(body.queues)).toBe(true);
      for (const q of body.queues) {
        expect(q.name).toBeDefined();
        expect(typeof q.waiting).toBe('number');
        expect(typeof q.active).toBe('number');
      }
    }
  });

  it('GET /api/v1/health/cadence returns governor state', async () => {
    const res = await inject(app, '/api/v1/health/cadence');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.channelSlots).toBeDefined();
    expect(body.globalSlots).toBeDefined();
    expect(typeof body.nextAvailableMs).toBe('number');
  });

  it('health routes include X-Request-Id header (structured logging)', async () => {
    const res = await inject(app, '/health');
    const requestId = res.headers['x-request-id'];
    expect(requestId).toBeDefined();
    expect(typeof requestId === 'string' && requestId.length > 0).toBe(true);
  });
});
