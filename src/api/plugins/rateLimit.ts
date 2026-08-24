import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { config } from '../../config/env.js';
import { extractApiKey } from './auth.js';
import { registerRedisRecovery } from '../../core/queues/helpers.js';

let _redisConnection: Redis | null = null;

async function getRedis(): Promise<Redis> {
  if (!_redisConnection) {
    const { redisConnection } = await import('../../core/queues/queue.js');
    _redisConnection = redisConnection;
  }
  return _redisConnection;
}

const WINDOW_SECONDS = 60;
const EXEMPT_ROUTES = new Set(['/health']);
// Health sub-checks (/health/db, /health/redis, ...) are also exempt
const EXEMPT_PREFIXES = ['/health', '/api/v1/email/track'];

function isExemptRoute(url: string): boolean {
  const path = url.split('?')[0];
  if (EXEMPT_ROUTES.has(path)) return true;
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

let redisDownLogged = false;

interface WindowEntry {
  timestamps: number[];
}

const memoryStore = new Map<string, WindowEntry>();

// Periodic cleanup of expired entries (every 60 seconds)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const cutoff = now - WINDOW_SECONDS * 1000;
  for (const [key, entry] of memoryStore) {
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
    if (entry.timestamps.length === 0) {
      memoryStore.delete(key);
    }
  }
}, 60_000).unref();

function getElevatedKeys(): Set<string> {
  const raw = process.env.ELEVATED_API_KEYS ?? config.ELEVATED_API_KEYS;
  return new Set(
    raw.split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

function getTier(apiKey: string | null, url: string): { limit: number; keyPrefix: string } {
  // Inbound provider webhooks get their own (higher) tier: Meta/Resend/outreach
  // send legitimate bursts that must not be throttled at the default tier.
  if (
    url.startsWith('/api/v1/webhooks/outreach') ||
    url.startsWith('/api/v1/email/webhooks/resend') ||
    url.startsWith('/api/v1/webhooks/whatsapp')
  ) {
    return { limit: Number(process.env.RATE_LIMIT_WEBHOOK_RPM ?? config.RATE_LIMIT_WEBHOOK_RPM), keyPrefix: 'rl:webhook:' };
  }

  if (apiKey && getElevatedKeys().has(apiKey)) {
    return { limit: Number(process.env.RATE_LIMIT_ELEVATED_RPM ?? config.RATE_LIMIT_ELEVATED_RPM), keyPrefix: 'rl:elevated:' };
  }

  return { limit: Number(process.env.RATE_LIMIT_DEFAULT_RPM ?? config.RATE_LIMIT_DEFAULT_RPM), keyPrefix: 'rl:default:' };
}

// ──────────────────────────── Redis sliding window ────────────────────────────

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_req = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < max_req then
  redis.call('ZADD', key, now, now .. ':' .. count)
  redis.call('EXPIRE', key, window + 1)
  return {count + 1, max_req - count - 1, now + window}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]
  return {count, max_req - count, tonumber(oldest) + window}
end
`;

let redisAvailable = true;

async function redisCheck(
  redis: Redis,
  key: string,
  limit: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  // Quick check: if Redis was previously unavailable, skip immediately
  if (!redisAvailable) {
    throw new Error('Redis unavailable');
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    // Check connection status quickly — ioredis.status === 'ready' if connected
    if (redis.status !== 'ready') {
      throw new Error('Redis not ready');
    }
    const result = (await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      now.toString(),
      WINDOW_SECONDS.toString(),
      limit.toString(),
    )) as [number, number, number];

    const [count, remaining, reset] = result;
    return {
      allowed: remaining >= 0,
      remaining: Math.max(0, remaining),
      resetAt: reset,
    };
  } catch {
    redisAvailable = false;
    if (!redisDownLogged) {
      console.warn('[rateLimit] Redis unavailable — falling back to in-memory rate limiter');
      redisDownLogged = true;
    }
    throw new Error('Redis unavailable');
  }
}

// ──────────────────────────── In-memory fallback ────────────────────────────

function memoryCheck(
  key: string,
  limit: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const cutoff = now - WINDOW_SECONDS * 1000;

  let entry = memoryStore.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    memoryStore.set(key, entry);
  }

  // Remove expired timestamps
  entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

  if (entry.timestamps.length < limit) {
    entry.timestamps.push(now);
    const oldest = entry.timestamps[0] ?? now;
    return {
      allowed: true,
      remaining: limit - entry.timestamps.length,
      resetAt: Math.floor((oldest + WINDOW_SECONDS * 1000) / 1000),
    };
  }

  const oldest = entry.timestamps[0];
  return {
    allowed: false,
    remaining: 0,
    resetAt: Math.floor((oldest + WINDOW_SECONDS * 1000) / 1000),
  };
}

// ──────────────────────────── Plugin ────────────────────────────

// Exported for testing
function _resetMemoryStore() {
  memoryStore.clear();
  redisAvailable = true;
  redisDownLogged = false;
}

// Register Redis recovery: once Redis is back, stop falling back to in-memory
// and resume using the distributed sliding window.
registerRedisRecovery(
  'rate-limit',
  10_000,
  () => !redisAvailable,
  () => {
    redisAvailable = true;
    redisDownLogged = false;
    console.warn('[rateLimit] Redis recovered — resuming distributed rate limiting');
  },
);

export { _resetMemoryStore };

export default fp(
  async function rateLimit(app: FastifyInstance) {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url;

      if (isExemptRoute(url)) return;

      const apiKey = extractApiKey(request);
      const clientId = apiKey ?? request.ip;
      const { limit, keyPrefix } = getTier(apiKey, url);
      const rateKey = `${keyPrefix}${clientId}`;

      let checkResult: { allowed: boolean; remaining: number; resetAt: number };

      try {
        // Race Redis check against a short timeout — if Redis is slow/unavailable, use memory
        checkResult = await Promise.race([
          redisCheck(await getRedis(), rateKey, limit),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 500)),
        ]);
      } catch {
        checkResult = memoryCheck(rateKey, limit);
      }

      // Set standard rate-limit headers
      reply.header('X-RateLimit-Limit', limit);
      reply.header('X-RateLimit-Remaining', checkResult.remaining);
      reply.header('X-RateLimit-Reset', checkResult.resetAt);

      if (!checkResult.allowed) {
        const retryAfter = Math.max(1, checkResult.resetAt - Math.floor(Date.now() / 1000));
        reply.header('Retry-After', retryAfter);
        return reply.status(429).send({
          error: 'Too Many Requests',
          retryAfter,
        });
      }
    });
  },
  { name: 'rate-limit' },
);