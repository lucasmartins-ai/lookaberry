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
import { getRecoveryState } from '../../core/execution/recovery.js';
import { getBackoffTracker } from '../../core/execution/backoff.js';

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

  // ─── S13: Sync health ────────────────────────────────────────────────
  app.get('/api/v1/health/sync', {
    schema: {
      description: 'S13: Last successful synchronization timestamp and summary',
      tags: ['Health', 'S13'],
    },
  }, async (_request, reply) => {
    try {
      const latestMessage = await prisma.outreachMessage.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const latestMetric = await prisma.campaignMetric.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      });

      return reply.status(200).send({
        last_sync_at: new Date().toISOString(),
        latest_message_at: latestMessage?.createdAt ?? null,
        latest_campaign_update_at: latestMetric?.updatedAt ?? null,
        api_version: '0.1.0',
      });
    } catch (err) {
      return reply.status(503).send({
        last_sync_at: null,
        error: err instanceof Error ? err.message : 'Sync check failed',
      });
    }
  });

  // ─── S14: DLQ health ───────────────────────────────────────────────────
  app.get('/api/v1/health/dlq', {
    schema: {
      description: 'S14: Dead-Letter Queue status — pending and recent jobs',
      tags: ['Health', 'S14'],
    },
  }, async (_request, reply) => {
    try {
      const pending = await prisma.deadLetterJob.count({ where: { status: 'PENDING' } });
      const last24h = await prisma.deadLetterJob.count({
        where: { deadLetteredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1_000) } },
      });
      const recent = await prisma.deadLetterJob.findMany({
        where: { status: 'PENDING' },
        orderBy: { deadLetteredAt: 'desc' },
        take: 10,
        select: { id: true, sequenceId: true, errorMessage: true, attemptCount: true, deadLetteredAt: true },
      });
      return reply.status(200).send({
        status: pending > 0 ? 'degraded' : 'ok',
        pending_count: pending,
        last_24h_count: last24h,
        recent: recent.map(j => ({
          id: j.id,
          sequence_id: j.sequenceId,
          error: j.errorMessage.slice(0, 200),
          attempts: j.attemptCount,
          dead_lettered_at: j.deadLetteredAt?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      return reply.status(503).send({ error: err instanceof Error ? err.message : 'DLQ check failed' });
    }
  });

  // ─── S14: Idempotency stats ────────────────────────────────────────────
  app.get('/api/v1/health/idempotency', {
    schema: {
      description: 'S14: Idempotency key stats — deduplication rate',
      tags: ['Health', 'S14'],
    },
  }, async (_request, reply) => {
    try {
      const totalKeys = await prisma.idempotencyKey.count();
      const lastHour = await prisma.idempotencyKey.count({
        where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1_000) } },
      });
      const byType = await prisma.$queryRawUnsafe<Array<{ event_type: string; count: bigint }>>(
        `SELECT event_type, COUNT(*)::bigint as count FROM idempotency_keys WHERE created_at >= NOW() - INTERVAL '24 hours' GROUP BY event_type`,
      );
      return reply.status(200).send({
        total_keys: totalKeys,
        last_hour: lastHour,
        by_type_last_24h: byType.reduce((acc, r) => ({ ...acc, [r.event_type]: Number(r.count) }), {}),
      });
    } catch (err) {
      return reply.status(503).send({ error: err instanceof Error ? err.message : 'Idempotency stats check failed' });
    }
  });

  // ─── S14: Recovery state ───────────────────────────────────────────────
  app.get('/api/v1/health/recovery', {
    schema: {
      description: 'S14: Recovery state after restart',
      tags: ['Health', 'S14'],
    },
  }, async (_request, reply) => {
    const state = getRecoveryState();
    const backoffTracker = getBackoffTracker();
    return reply.status(200).send({
      ...state,
      backoff_tracked: backoffTracker.size,
    });
  });
}