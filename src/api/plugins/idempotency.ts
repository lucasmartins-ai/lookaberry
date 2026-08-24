import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { registerRedisRecovery } from '../../core/queues/helpers.js';

let _redisConnection: Redis | null = null;

async function getRedis(): Promise<Redis> {
  if (!_redisConnection) {
    const { redisConnection } = await import('../../core/queues/queue.js');
    _redisConnection = redisConnection;
  }
  return _redisConnection;
}

const WEBHOOK_ROUTE = '/api/v1/webhooks/outreach';
const TTL_SECONDS = 86400; // 24 hours

interface CachedResult {
  status: number;
  body: unknown;
  createdAt: number;
}

const memoryCache = new Map<string, CachedResult>();
let redisDownLogged = false;
let redisAvailable = true;

// Periodically clean expired entries from memory cache
const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - TTL_SECONDS * 1000;
  for (const [key, entry] of memoryCache) {
    if (entry.createdAt < cutoff) {
      memoryCache.delete(key);
    }
  }
}, 300_000).unref(); // Every 5 minutes

async function checkIdempotency(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.url !== WEBHOOK_ROUTE || request.method !== 'POST') return;

  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    // No idempotency key — process normally (backward compat)
    return;
  }

  const redisKey = `idem:webhook:${idempotencyKey}`;

  // Try Redis first (skip if previously unavailable)
  try {
    if (!redisAvailable) throw new Error('Redis unavailable');
    const redis = await Promise.race([
      getRedis(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 500)),
    ]);
    if (redis.status !== 'ready') throw new Error('Redis not ready');
    const cached = await redis.get(redisKey);
    if (cached) {
      const result: CachedResult = JSON.parse(cached);
      reply.header('Idempotency-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    }
    // Store placeholder to prevent concurrent duplicate processing
    if (redis.status !== 'ready') throw new Error('Redis not ready');
    await redis.set(
      redisKey,
      JSON.stringify({ status: 202, body: { status: 'processing' }, createdAt: Date.now() }),
      'EX',
      TTL_SECONDS,
      'NX',
    );
    // Note: actual result will be stored by the response hook below
    return;
  } catch {
    redisAvailable = false;
    if (!redisDownLogged) {
      console.warn('[idempotency] Redis unavailable — falling back to in-memory idempotency cache');
      redisDownLogged = true;
    }
  }

  // Memory fallback
  const cached = memoryCache.get(idempotencyKey);
  if (cached && cached.createdAt > Date.now() - TTL_SECONDS * 1000) {
    reply.header('Idempotency-Replayed', 'true');
    return reply.status(cached.status).send(cached.body);
  }

  // Store placeholder
  memoryCache.set(idempotencyKey, {
    status: 202,
    body: { status: 'processing' },
    createdAt: Date.now(),
  });
}

async function storeResult(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.url !== WEBHOOK_ROUTE || request.method !== 'POST') return;

  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return;

  const redisKey = `idem:webhook:${idempotencyKey}`;
  const result: CachedResult = {
    status: reply.statusCode,
    body: reply.getHeader('content-type')?.toString().includes('json')
      ? (reply as any).serialized ?? { status: 'ok' }
      : { status: 'ok' },
    createdAt: Date.now(),
  };

  try {
    if (!redisAvailable) throw new Error('Redis unavailable');
    const payload = (reply as any)._sentBody;
    if (payload) {
      result.body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    }

    const redis = await Promise.race([
      getRedis(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 500)),
    ]);
    if (redis.status !== 'ready') throw new Error('Redis not ready');
    await redis.set(
      redisKey,
      JSON.stringify(result),
      'EX',
      TTL_SECONDS,
    );
  } catch {
    memoryCache.set(idempotencyKey, result);
  }
}

// Register Redis recovery: once Redis is back, resume distributed idempotency
// instead of the per-process in-memory fallback.
registerRedisRecovery(
  'idempotency',
  10_000,
  () => !redisAvailable,
  () => {
    redisAvailable = true;
    redisDownLogged = false;
    console.warn('[idempotency] Redis recovered — resuming distributed idempotency');
  },
);

export default fp(
  async function idempotency(app: FastifyInstance) {
    // Check for replay BEFORE processing
    app.addHook('preHandler', async (request, reply) => {
      await checkIdempotency(request, reply);
    });

    // Store result AFTER processing (success or error)
    app.addHook('onSend', async (request, reply, payload) => {
      await storeResult(request, reply);
      return payload;
    });
  },
  { name: 'idempotency' },
);

export { checkIdempotency, storeResult, memoryCache, TTL_SECONDS };