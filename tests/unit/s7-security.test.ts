import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { buildServer } from '../../src/api/server.js';

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

function buildApiUrl(path: string): string {
  return `http://127.0.0.1:3000${path}`;
}

async function inject(app: Awaited<ReturnType<typeof buildServer>>, opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return app.inject({
    method: opts.method as any,
    url: buildApiUrl(opts.path),
    headers: {
      'content-type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ─────────────────────────────────────────────
// Auth middleware tests (use /health for exempt, /api/v1/icp/:id for protected)
// ─────────────────────────────────────────────

describe('Auth middleware', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = 'sk_test_abc123,sk_test_def456';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('accepts valid Bearer token', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
      headers: { authorization: 'Bearer sk_test_abc123' },
    });
    // 404 (no DB) or 500 — but NOT 401
    expect(res.statusCode).not.toBe(401);
  });

  it('accepts valid X-API-Key header', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
      headers: { 'x-api-key': 'sk_test_def456' },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('rejects invalid API key with 401', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
      headers: { authorization: 'Bearer invalid_key_xxx' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects missing auth header with 401', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
    });
    expect(res.statusCode).toBe(401);
  });

  it('exempts /health from auth', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/health',
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('exempts /docs from auth', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('exempts webhook route from API key auth', async () => {
    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      body: { campaign_id: '00000000-0000-0000-0000-000000000001', lead_id: '00000000-0000-0000-0000-000000000002', event: 'REPLIED' },
    });
    // Will get 401 from webhook signature, NOT API key
    expect(res.statusCode).not.toBe(401);
  });
});

// ─────────────────────────────────────────────
// Auth no-op in test mode
// ─────────────────────────────────────────────

describe('Auth middleware — test mode (no-op)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = '';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('allows requests without API key in test mode', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
    });
    // Should not get 401 — auth is no-op in test mode
    expect(res.statusCode).not.toBe(401);
  });
});

// ─────────────────────────────────────────────
// Rate limiter tests
// ─────────────────────────────────────────────

describe('Rate limiter', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    // Reset rate limiter memory store to get clean state
    const rateLimitMod = await import('../../src/api/plugins/rateLimit.js');
    (rateLimitMod as any)._resetMemoryStore();
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = 'sk_test_abc123';
    process.env.RATE_LIMIT_DEFAULT_RPM = '5';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('returns correct X-RateLimit headers', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
    });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('allows requests within limit', async () => {
    // Use the same app but rate limiter memory is now reset
    const freshApp = await buildServer();
    await freshApp.ready();
    (await import('../../src/api/plugins/rateLimit.js'))._resetMemoryStore();
    process.env.RATE_LIMIT_DEFAULT_RPM = '100';
    try {
      for (let i = 0; i < 3; i++) {
        const res = await inject(freshApp, {
          method: 'GET',
          path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
          headers: { 'x-forwarded-for': `198.51.100.${20 + i}` },
        });
        expect(res.statusCode).not.toBe(429);
      }
    } finally {
      await freshApp.close();
      process.env.RATE_LIMIT_DEFAULT_RPM = '5';
    }
  });

  it('returns 429 after exceeding limit', async () => {
    const app2 = await buildServer();
    await app2.ready();
    (await import('../../src/api/plugins/rateLimit.js'))._resetMemoryStore();
    process.env.RATE_LIMIT_DEFAULT_RPM = '5';
    process.env.RATE_LIMIT_ELEVATED_RPM = '5';
    process.env.ELEVATED_API_KEYS = '';
    try {
      for (let i = 0; i < 6; i++) {
        await inject(app2, {
          method: 'GET',
          path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        });
      }
      const res = await inject(app2, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
      });
      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Too Many Requests');
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await app2.close();
    }
  });

  it('/health is exempt from rate limiting', async () => {
    const testApp = await buildServer();
    await testApp.ready();
    (await import('../../src/api/plugins/rateLimit.js'))._resetMemoryStore();
    try {
      for (let i = 0; i < 7; i++) {
        const health = await inject(testApp, {
          method: 'GET',
          path: '/health',
        });
        expect(health.statusCode).not.toBe(429);
      }
    } finally {
      await testApp.close();
    }
  });
});

// ─────────────────────────────────────────────
// Webhook HMAC signature tests
// ─────────────────────────────────────────────

describe('Webhook HMAC signature validation', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const webhookSecret = 'whsec_test_secret_key_12345';
  const validBody = {
    campaign_id: '00000000-0000-0000-0000-000000000001',
    lead_id: '00000000-0000-0000-0000-000000000002',
    event: 'REPLIED',
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = 'sk_test_abc123';
    process.env.WEBHOOK_SECRET = webhookSecret;
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  function signPayload(body: unknown, secret: string): { header: string; timestamp: string } {
    const timestamp = Math.floor(Date.now()).toString();
    const rawBody = JSON.stringify(body);
    const signedPayload = `${timestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return { header: `t=${timestamp},v1=${hmac}`, timestamp };
  }

  it('rejects webhook without signature header', async () => {
    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      body: validBody,
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Invalid signature');
  });

  it('rejects webhook with invalid signature', async () => {
    const ts = Math.floor(Date.now()).toString();
    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: {
        'x-webhook-signature': `t=${ts},v1=invalid_signature_here`,
      },
      body: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects expired timestamp (>5 min old)', async () => {
    const oldTimestamp = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString();
    const rawBody = JSON.stringify(validBody);
    const signedPayload = `${oldTimestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: {
        'x-webhook-signature': `t=${oldTimestamp},v1=${hmac}`,
      },
      body: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects future timestamp', async () => {
    const futureTimestamp = Math.floor((Date.now() + 10 * 60 * 1000) / 1000).toString();
    const rawBody = JSON.stringify(validBody);
    const signedPayload = `${futureTimestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: {
        'x-webhook-signature': `t=${futureTimestamp},v1=${hmac}`,
      },
      body: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('skips validation when WEBHOOK_SECRET is empty in dev', async () => {
    process.env.WEBHOOK_SECRET = '';
    const app2 = await buildServer();
    await app2.ready();
    try {
      const res = await inject(app2, {
        method: 'POST',
        path: '/api/v1/webhooks/outreach',
        body: validBody,
      });
      expect(res.statusCode).not.toBe(401);
    } finally {
      await app2.close();
      process.env.WEBHOOK_SECRET = webhookSecret;
    }
  });
});

// ─────────────────────────────────────────────
// Timing-safe comparison
// ─────────────────────────────────────────────

describe('timingSafeEqual', () => {
  it('returns true for equal strings', async () => {
    const { timingSafeEqual } = await import('../../src/api/plugins/webhookAuth.js');
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings', async () => {
    const { timingSafeEqual } = await import('../../src/api/plugins/webhookAuth.js');
    expect(timingSafeEqual('abc123', 'xyz789')).toBe(false);
  });

  it('returns false for different length strings', async () => {
    const { timingSafeEqual } = await import('../../src/api/plugins/webhookAuth.js');
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// HMAC computation
// ─────────────────────────────────────────────

describe('computeHmac', () => {
  it('produces consistent output', async () => {
    const { computeHmac } = await import('../../src/api/plugins/webhookAuth.js');
    const result1 = computeHmac('payload123', 'secret');
    const result2 = computeHmac('payload123', 'secret');
    expect(result1).toBe(result2);
  });

  it('produces different output for different payloads', async () => {
    const { computeHmac } = await import('../../src/api/plugins/webhookAuth.js');
    const result1 = computeHmac('payload1', 'secret');
    const result2 = computeHmac('payload2', 'secret');
    expect(result1).not.toBe(result2);
  });
});

// ─────────────────────────────────────────────
// Idempotency tests
// ─────────────────────────────────────────────

describe('Idempotency', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = 'sk_test_abc123';
    process.env.WEBHOOK_SECRET = '';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('processes request without Idempotency-Key normally', async () => {
    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      body: {
        campaign_id: '00000000-0000-0000-0000-000000000001',
        lead_id: '00000000-0000-0000-0000-000000000002',
        event: 'REPLIED',
      },
    });
    // Will get 400 or 500 because no real DB — but NOT blocked by idempotency
    expect(res.statusCode).not.toBe(409);
  });

  it('returns cached result for duplicate Idempotency-Key (memory fallback)', async () => {
    const idemKey = crypto.randomUUID();
    const body = {
      campaign_id: '00000000-0000-0000-0000-000000000001',
      lead_id: '00000000-0000-0000-0000-000000000002',
      event: 'REPLIED',
    };

    const res1 = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: { 'idempotency-key': idemKey },
      body,
    });

    const res2 = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: { 'idempotency-key': idemKey },
      body,
    });

    // Second request should replay the cached result
    expect(res2.headers['idempotency-replayed']).toBe('true');
  });

  it('processes different Idempotency-Keys independently (memory fallback)', async () => {
    const key1 = crypto.randomUUID();
    const key2 = crypto.randomUUID();
    const body = {
      campaign_id: '00000000-0000-0000-0000-000000000001',
      lead_id: '00000000-0000-0000-0000-000000000002',
      event: 'REPLIED',
    };

    await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: { 'idempotency-key': key1 },
      body,
    });

    const res2 = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      headers: { 'idempotency-key': key2 },
      body,
    });

    // Second key should not be flagged as replay
    expect(res2.headers['idempotency-replayed']).toBeUndefined();
  });

  it('in-memory cache stores and retrieves results', async () => {
    const { memoryCache } = await import('../../src/api/plugins/idempotency.js');
    memoryCache.set('unit-test-key', { status: 200, body: { ok: true }, createdAt: Date.now() });

    const cached = memoryCache.get('unit-test-key');
    expect(cached).toBeDefined();
    expect(cached!.status).toBe(200);
    expect(cached!.body).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────
// CORS tests
// ─────────────────────────────────────────────

describe('CORS', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CORS_ORIGINS = 'http://localhost:3000,https://app.example.com';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('allows requests from configured origin', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('omits Access-Control-Allow-Origin for disallowed origin', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles OPTIONS preflight correctly', async () => {
    const res = await inject(app, {
      method: 'OPTIONS',
      path: '/docs',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.statusCode).toBe(204);
  });
});

// ─────────────────────────────────────────────
// Security headers tests
// ─────────────────────────────────────────────

describe('Security headers', () => {
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

  it('adds X-Content-Type-Options header', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('adds X-Frame-Options header', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
    });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('adds Content-Security-Policy header', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
    });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('adds Cache-Control: no-store', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('adds Referrer-Policy header', async () => {
    const res = await inject(app, {
      method: 'GET',
      path: '/docs',
    });
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

// ─────────────────────────────────────────────
// Input validation tests
// ─────────────────────────────────────────────

describe('Input validation', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = 'sk_test_abc123';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  it('rejects text/plain content type with 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: buildApiUrl('/api/v1/webhooks/outreach'),
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(res.statusCode).toBe(415);
  });

  it('accepts application/json content type', async () => {
    const res = await inject(app, {
      method: 'POST',
      path: '/api/v1/webhooks/outreach',
      body: { key: 'value' },
    });
    // Not 415 — may fail downstream but content-type is accepted
    expect(res.statusCode).not.toBe(415);
  });
});

// ─────────────────────────────────────────────
// Auth fingerprint
// ─────────────────────────────────────────────

describe('fingerprint', () => {
  it('returns first 4 + last 4 chars for long keys', async () => {
    const { fingerprint } = await import('../../src/api/plugins/auth.js');
    const fp = fingerprint('sk_test_abcdef1234567890');
    expect(fp).toBe('sk_t...7890');
  });

  it('returns first 4 chars for short keys', async () => {
    const { fingerprint } = await import('../../src/api/plugins/auth.js');
    const fp = fingerprint('abc');
    expect(fp).toBe('abc');
  });
});

// ─────────────────────────────────────────────
// API key extraction
// ─────────────────────────────────────────────

describe('extractApiKey', () => {
  it('extracts Bearer token', async () => {
    const { extractApiKey } = await import('../../src/api/plugins/auth.js');
    const key = extractApiKey({
      headers: { authorization: 'Bearer sk_mykey123' },
    } as any);
    expect(key).toBe('sk_mykey123');
  });

  it('extracts X-API-Key', async () => {
    const { extractApiKey } = await import('../../src/api/plugins/auth.js');
    const key = extractApiKey({
      headers: { 'x-api-key': 'sk_mykey456' },
    } as any);
    expect(key).toBe('sk_mykey456');
  });

  it('prefers Bearer over X-API-Key when both present', async () => {
    const { extractApiKey } = await import('../../src/api/plugins/auth.js');
    const key = extractApiKey({
      headers: {
        authorization: 'Bearer sk_bearer',
        'x-api-key': 'sk_header',
      },
    } as any);
    expect(key).toBe('sk_bearer');
  });

  it('returns null when neither is present', async () => {
    const { extractApiKey } = await import('../../src/api/plugins/auth.js');
    const key = extractApiKey({ headers: {} } as any);
    expect(key).toBeNull();
  });

  it('returns null for empty X-API-Key', async () => {
    const { extractApiKey } = await import('../../src/api/plugins/auth.js');
    const key = extractApiKey({ headers: { 'x-api-key': '' } } as any);
    expect(key).toBeNull();
  });
});

// ─────────────────────────────────────────────
// getEnvKeys
// ─────────────────────────────────────────────

describe('getEnvKeys', () => {
  it('parses comma-separated keys from env', async () => {
    const oldKeys = process.env.API_KEYS;
    process.env.API_KEYS = 'key1,key2,key3';
    const { getEnvKeys } = await import('../../src/api/plugins/auth.js');
    const keys = getEnvKeys();
    expect(keys.has('key1')).toBe(true);
    expect(keys.has('key2')).toBe(true);
    expect(keys.has('key3')).toBe(true);
    expect(keys.has('key4')).toBe(false);
    process.env.API_KEYS = oldKeys;
  });

  it('returns empty set when API_KEYS is empty', async () => {
    const oldKeys = process.env.API_KEYS;
    process.env.API_KEYS = '';
    const { getEnvKeys } = await import('../../src/api/plugins/auth.js');
    const keys = getEnvKeys();
    expect(keys.size).toBe(0);
    process.env.API_KEYS = oldKeys;
  });
});