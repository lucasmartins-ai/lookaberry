import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { hashApiKey, type ApiKeyRecord } from '../../core/security/apiKeys.js';
import { validateRequestTotp } from '../../core/security/totp.js';
import { routePath } from './routePath.js';

const EXEMPT_PREFIXES = ['/health', '/docs', '/api/v1/email/track'];
const WEBHOOK_ROUTE = '/api/v1/webhooks/outreach';
const EMAIL_WEBHOOK_ROUTE = '/api/v1/email/webhooks/resend';
const WHATSAPP_WEBHOOK_ROUTE = '/api/v1/webhooks/whatsapp';
const ADMIN_PREFIX = '/api/v1/admin';
/**
 * Routes that can change keys or suppression: keys with requireTotp must send X-TOTP here.
 * (/sse + /messages: MCP tools such as record_feedback can trigger an opt-out cascade.)
 */
const TOTP_PREFIXES = [ADMIN_PREFIX, '/api/v1/events', '/sse', '/messages'];

function isTotpProtected(path: string): boolean {
  return TOTP_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
}

interface ApiKeyCacheEntry {
  record: ApiKeyRecord;
  expiresAt: number;
}

const keyCache = new Map<string, ApiKeyCacheEntry>();

/** Drop cached key records; call after any key mutation (revoke, rotate, TOTP change). */
function clearKeyCache(): void {
  keyCache.clear();
}

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
      requireTotp: false,
      version: 0,
      createdAt: new Date(0),
    };
  }

  // Check cache — return the real DB record, never a synthesized one
  const cached = keyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const { record } = cached;
    if (!record.expiresAt || new Date(record.expiresAt) >= new Date()) return record;
  }
  keyCache.delete(key);

  // Check DB (S15: ApiKey model)
  try {
    const client = prisma as any;
    const dbKey = await client.apiKey?.findUnique({ where: { key: hashApiKey(key) } });
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
      keyCache.set(key, { record: dbKey as ApiKeyRecord, expiresAt: Date.now() + 60_000 });

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
  if (isExempt(routePath(request))) {
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
      const path = routePath(request);
      if (isExempt(path)) return;

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

        // ── S15: TOTP check for key/suppression-changing routes ──
        if (isTotpProtected(path) && (keyRecord as any).requireTotp) {
          const totpCode = request.headers['x-totp'];
          if (typeof totpCode !== 'string' || totpCode.length === 0) {
            request.log.warn({
              msg: 'totp_required',
              keyFingerprint: fingerprint(apiKey),
              ip: request.ip,
              route: url,
            });
            return reply.status(401).send({
              error: 'TOTP Required',
              message: 'Esta chave requer autenticação de dois fatores. Envie o código no header X-TOTP.',
            });
          }

          const totpValid = await validateRequestTotp(
            prisma as any,
            keyRecord.id,
            totpCode,
          );

          if (!totpValid) {
            request.log.warn({
              msg: 'totp_invalid',
              keyFingerprint: fingerprint(apiKey),
              ip: request.ip,
              route: url,
            });
            return reply.status(401).send({
              error: 'Invalid TOTP',
              message: 'Código TOTP inválido ou expirado.',
            });
          }
        }

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

export { authenticateApiKey, extractApiKey, getEnvKeys, fingerprint, isExempt, isTotpProtected, routePath, validateKey, clearKeyCache };