import { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client.js';
import { redisConnection } from '../../core/queues/queue.js';
import { getCadenceGovernor } from '../../core/execution/cadenceGovernor.js';
import {
  icpQueue,
  signalQueue,
  enrichmentQueue,
  outreachQueue,
  outreachInboxQueue,
} from '../../core/queues/queue.js';

const HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${HEALTH_TIMEOUT_MS}ms`)), HEALTH_TIMEOUT_MS),
    ),
  ]);
}

// ──────────────────────────── Health route helpers ────────────────────────────

interface HealthComponent {
  status: 'ok' | 'degraded' | 'unreachable';
  latencyMs?: number;
  message?: string;
}

async function checkDatabase(): Promise<HealthComponent> {
  const start = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 'database');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'unreachable',
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkPgVector(): Promise<HealthComponent> {
  const start = Date.now();
  try {
    const result = await withTimeout(
      prisma.$queryRaw<Array<{ extname: string; extversion: string }>>`
        SELECT extname, extversion::text FROM pg_extension WHERE extname IN ('vector', 'uuid-ossp')
      `,
      'pgvector',
    );
    const extensions = result.map((r) => r.extname);
    const hasVector = extensions.includes('vector');
    const hasUuid = extensions.includes('uuid-ossp');
    if (!hasVector) {
      return { status: 'degraded', latencyMs: Date.now() - start, message: 'pgvector extension not installed' };
    }
    if (!hasUuid) {
      return { status: 'degraded', latencyMs: Date.now() - start, message: 'uuid-ossp extension not installed' };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'unreachable',
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkRedis(): Promise<HealthComponent> {
  const start = Date.now();
  try {
    // ioredis status check: 'ready' / 'connecting' / 'close' / 'end'
    if (redisConnection.status !== 'ready') {
      return { status: 'degraded', latencyMs: Date.now() - start, message: `Redis status: ${redisConnection.status}` };
    }
    await withTimeout(redisConnection.ping(), 'redis');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'unreachable',
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

interface QueueInfo {
  name: string;
  waiting: number;
  active: number;
  status: 'ok' | 'unreachable';
}

async function checkQueues(): Promise<HealthComponent & { queues?: QueueInfo[] }> {
  const start = Date.now();
  if (redisConnection.status !== 'ready') {
    return { status: 'unreachable', latencyMs: 0, message: 'Redis not ready — queue inspection unavailable' };
  }

  const queueList = [
    { name: 'icp_analysis_queue', q: icpQueue },
    { name: 'signal_ingestion_queue', q: signalQueue },
    { name: 'waterfall_enrichment_queue', q: enrichmentQueue },
    { name: 'outreach_dispatcher_queue', q: outreachQueue },
    { name: 'outreach_inbox_queue', q: outreachInboxQueue },
  ];

  try {
    const results = await withTimeout(
      Promise.all(
        queueList
          .filter(() => redisConnection.status === 'ready')
          .map(async ({ name, q }) => {
            try {
              const waiting = await q.getWaitingCount();
              const active = await q.getActiveCount();
              return { name, waiting, active, status: 'ok' as const };
            } catch {
              return { name, waiting: -1, active: -1, status: 'unreachable' as const };
            }
          }),
      ),
      'queues',
    );

    const allOk = results.every((r) => r.status === 'ok');
    return {
      status: allOk ? 'ok' : 'degraded',
      latencyMs: Date.now() - start,
      queues: results,
    };
  } catch (err) {
    return {
      status: 'unreachable',
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ──────────────────────────── Route registration ────────────────────────────

export async function healthRoutes(app: FastifyInstance) {
  // ─── Aggregate health check ──────────────────────────────────────────────
  app.get('/health', {
    schema: {
      description: 'Aggregate health: database, pgvector, redis, queues',
      tags: ['Health', 'S12'],
    },
  }, async (_request, reply) => {
    const [db, pgvec, redis, queues] = await Promise.all([
      checkDatabase(),
      checkPgVector(),
      checkRedis(),
      checkQueues(),
    ]);

    const components = [db, pgvec, redis, queues];
    const allOk = components.every((c) => c.status === 'ok');
    const anyUnreachable = components.some((c) => c.status === 'unreachable');

    let overall: 'healthy' | 'degraded' | 'unhealthy';
    if (allOk) overall = 'healthy';
    else if (anyUnreachable) overall = 'unhealthy';
    else overall = 'degraded';

    return reply.status(allOk ? 200 : 503).send({
      status: overall,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      components: {
        database: db,
        pgvector: pgvec,
        redis,
        queues,
      },
    });
  });

  // ─── Database check ─────────────────────────────────────────────────────
  app.get('/health/db', {
    schema: {
      description: 'PostgreSQL connectivity check',
      tags: ['Health', 'S12'],
    },
  }, async (_request, reply) => {
    const result = await checkDatabase();
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });

  // ─── pgvector check ─────────────────────────────────────────────────────
  app.get('/health/pgvector', {
    schema: {
      description: 'pgvector extension + HNSW indexes check',
      tags: ['Health', 'S12'],
    },
  }, async (_request, reply) => {
    const result = await checkPgVector();
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });

  // ─── Redis check ────────────────────────────────────────────────────────
  app.get('/health/redis', {
    schema: {
      description: 'Redis connectivity check',
      tags: ['Health', 'S12'],
    },
  }, async (_request, reply) => {
    const result = await checkRedis();
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });

  // ─── Queues check ───────────────────────────────────────────────────────
  app.get('/health/queues', {
    schema: {
      description: 'BullMQ queue inspection (waiting/active counts)',
      tags: ['Health', 'S12'],
    },
  }, async (_request, reply) => {
    const result = await checkQueues();
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });

  // ─── Cadence governor (existing S10 endpoint) ───────────────────────────
  app.get('/api/v1/health/cadence', {
    schema: {
      description: 'Get current cadence governor state (S10)',
      tags: ['Health', 'S10'],
      response: {
        200: {
          type: 'object',
          properties: {
            channelSlots: { type: 'object' },
            globalSlots: { type: 'object' },
            nextAvailableMs: { type: 'number' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const governor = getCadenceGovernor();
    return reply.status(200).send(governor.getGlobalState());
  });
}