import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import type { ApiKeyRecord } from '../../core/security/apiKeys.js';

const EXEMPT_PREFIXES = ['/health', '/docs', '/api/v1/email/track'];
const WEBHOOK_ROUTE = '/api/v1/webhooks/outreach';
const EMAIL_WEBHOOK_ROUTE = '/api/v1/email/webhooks/resend';
const WHATSAPP_WEBHOOK_ROUTE = '/api/v1/webhooks/whatsapp';

interface ApiKeyCacheEntry {
  key: string;
  expiresAt: number;
}

const keyCache = new Map<string, ApiKeyCacheEntry>();

function fingerprint(key: string): string {
  if (key.length <= 8) return key.slice(0, 4);
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function extractApiKey(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const apiKeyHeader = request.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  return null;
}

function isExempt(url: string): boolean {
  // /health, /docs, tracking pixels (mail clients pre-fetch) and webhook routes
  // are exempt from API-key auth.
  // Strip query string for matching (GET handshakes may include ?hub.mode=... etc.)
  const path = url.split('?')[0];
  return (
    EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/')) ||
    path === WEBHOOK_ROUTE ||
    path.startsWith(WEBHOOK_ROUTE + '/') ||
    path === EMAIL_WEBHOOK_ROUTE ||
    path.startsWith(EMAIL_WEBHOOK_ROUTE + '/') ||
    path === WHATSAPP_WEBHOOK_ROUTE ||
    path.startsWith(WHATSAPP_WEBHOOK_ROUTE + '/')
  );
}

function getEnvKeys(): Set<string> {
  const raw = process.env.API_KEYS ?? config.API_KEYS;
  return new Set(
    raw.split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

async function validateKey(key: string): Promise<ApiKeyRecord | null> {
  // Check env var first (fast path) — these are legacy keys without DB records
  const envKeys = getEnvKeys();
  if (envKeys.has(key)) {
    // Synthesize a minimal record for env-var-only keys (ADMIN level)
    return {
      id: 'env-key',
      key,
      name: 'env-var-key',
      permission: 'ADMIN' as any,
      userId: null,
      teamId: null,
      campaignIds: [],
      active: true,
      expiresAt: null,
      lastUsedAt: null,
      version: 0,
      createdAt: new Date(0),
    };
  }

  // Check cache
  const cached = keyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Return a minimal record from cache (we cache only valid keys)
    return {
      id: 'cached-key',
      key,
      name: 'cached',
      permission: 'ADMIN' as any,
      userId: null,
      teamId: null,
      campaignIds: [],
      active: true,
      expiresAt: null,
      lastUsedAt: null,
      version: 0,
      createdAt: new Date(0),
    };
  }

  // Check DB (S15: ApiKey model)
  try {
    const client = prisma as any;
    const dbKey = await client.apiKey?.findUnique({ where: { key } });
    if (dbKey && dbKey.active) {
      // Check expiry
      if (dbKey.expiresAt && new Date(dbKey.expiresAt) < new Date()) {
        // Auto-deactivate expired keys
        await client.apiKey.update({
          where: { id: dbKey.id },
          data: { active: false },
        }).catch(() => {});
        return null;
      }
      // Update lastUsedAt (fire-and-forget)
      client.apiKey.update({
        where: { id: dbKey.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});

      // Cache the hit
      keyCache.set(key, { key, expiresAt: Date.now() + 60_000 });

      return dbKey as ApiKeyRecord;
    }
  } catch {
    // DB unreachable or model missing — fall through to deny
  }

  return null;
}

async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const url = request.url;
  if (isExempt(url)) {
    return;
  }

  // No-op in test mode
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const apiKey = extractApiKey(request);

  if (!apiKey) {
    reply.header('WWW-Authenticate', 'Bearer');
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing API key',
    });
    return;
  }

  const keyRecord = await validateKey(apiKey);

  if (keyRecord) {
    // Attach the API key record to the request for downstream permission checks
    (request as any).__apiKey = keyRecord;
    request.log.info({
      msg: 'auth_success',
      keyFingerprint: fingerprint(apiKey),
      keyId: keyRecord.id,
      permission: keyRecord.permission,
      ip: request.ip,
      route: url,
    });
  } else {
    request.log.info({
      msg: 'auth_failure',
      reason: 'invalid_key',
      keyFingerprint: fingerprint(apiKey),
      ip: request.ip,
      route: url,
    });

    reply.header('WWW-Authenticate', 'Bearer');
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing API key',
    });
  }
}

export default fp(
  async function auth(app: FastifyInstance) {
    app.decorate('authenticateApiKey', authenticateApiKey);
    // Register onRequest hook but skip internally in test mode
    app.addHook('onRequest', async (request, reply) => {
      // In test mode, the hook is a no-op
      if (process.env.NODE_ENV === 'test') return;

      const url = request.url;
      if (isExempt(url)) return;

      const apiKey = extractApiKey(request);
      if (!apiKey) {
        reply.header('WWW-Authenticate', 'Bearer');
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or missing API key',
        });
      }

      const keyRecord = await validateKey(apiKey);

      if (keyRecord) {
        // Attach API key record to request
        (request as any).__apiKey = keyRecord;
        request.log.info({
          msg: 'auth_success',
          keyFingerprint: fingerprint(apiKey),
          keyId: keyRecord.id,
          permission: keyRecord.permission,
          ip: request.ip,
          route: url,
        });
      } else {
        request.log.info({
          msg: 'auth_failure',
          reason: 'invalid_key',
          keyFingerprint: fingerprint(apiKey),
          ip: request.ip,
          route: url,
        });
        reply.header('WWW-Authenticate', 'Bearer');
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid or missing API key',
        });
      }
    });
  },
  {
    name: 'auth',
    fastify: '5.x',
  },
);

export { authenticateApiKey, extractApiKey, getEnvKeys, fingerprint, isExempt, validateKey };