/**
 * S15 Unit Tests: IP Filtering Plugin
 *
 * Covers:
 * - IPv4 bare IP matching (allowlist, denylist)
 * - IPv4 CIDR matching (/24, /16)
 * - IPv6 matching (bare and CIDR)
 * - localhost keyword
 * - Admin route separation (ADMIN_IP_ALLOWLIST)
 * - Exempt routes (/health, /api/v1/email/track/*)
 * - Client IP extraction (X-Forwarded-For, X-Real-IP)
 * - Denylist takes precedence over allowlist
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../../src/api/server.js';

// ─────────────────────────── Helpers ───────────────────────────

const ORIGINAL_ENV = { ...process.env };

function buildApiUrl(path: string): string {
  return `http://127.0.0.1:3000${path}`;
}

async function inject(
  app: Awaited<ReturnType<typeof buildServer>>,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    remoteAddress?: string;
  },
) {
  return app.inject({
    method: opts.method as any,
    url: buildApiUrl(opts.path),
    headers: {
      'content-type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  });
}

// ─────────────────────────── Unit-level: IP matching logic ───────────────────────────

import { parseIpList, normalizeIp, ipInCidr, ipToBytes, getClientIp } from '../../src/api/plugins/ipFilter.js';

describe('IP matching primitives', () => {
  describe('parseIpList', () => {
    it('parses bare IPv4', () => {
      const matchers = parseIpList('192.168.1.100');
      expect(matchers).toHaveLength(1);
      expect(matchers[0].matches('192.168.1.100')).toBe(true);
      expect(matchers[0].matches('192.168.1.101')).toBe(false);
    });

    it('parses CIDR /24', () => {
      const matchers = parseIpList('10.0.0.0/24');
      expect(matchers).toHaveLength(1);
      expect(matchers[0].matches('10.0.0.1')).toBe(true);
      expect(matchers[0].matches('10.0.0.255')).toBe(true);
      expect(matchers[0].matches('10.0.1.1')).toBe(false);
    });

    it('parses CIDR /16', () => {
      const matchers = parseIpList('172.16.0.0/16');
      expect(matchers[0].matches('172.16.0.1')).toBe(true);
      expect(matchers[0].matches('172.16.255.255')).toBe(true);
      expect(matchers[0].matches('172.17.0.1')).toBe(false);
    });

    it('parses CIDR /0 (matches everything)', () => {
      const matchers = parseIpList('0.0.0.0/0');
      expect(matchers[0].matches('1.2.3.4')).toBe(true);
      expect(matchers[0].matches('255.255.255.255')).toBe(true);
    });

    it('parses localhost keyword', () => {
      const matchers = parseIpList('localhost');
      expect(matchers[0].matches('127.0.0.1')).toBe(true);
      expect(matchers[0].matches('::1')).toBe(true);
      expect(matchers[0].matches('::ffff:127.0.0.1')).toBe(true);
      expect(matchers[0].matches('192.168.1.1')).toBe(false);
    });

    it('parses IPv6 bare', () => {
      const matchers = parseIpList('2001:db8::1');
      expect(matchers[0].matches('2001:db8::1')).toBe(true);
      expect(matchers[0].matches('2001:db8::2')).toBe(false);
    });

    it('parses comma-separated mixed list', () => {
      const matchers = parseIpList('127.0.0.1, 10.0.0.0/8, localhost, 192.168.1.0/24');
      expect(matchers).toHaveLength(4);
      expect(matchers.some(m => m.matches('127.0.0.1'))).toBe(true);
      expect(matchers.some(m => m.matches('10.123.45.67'))).toBe(true);
      expect(matchers.some(m => m.matches('::1'))).toBe(true);
      expect(matchers.some(m => m.matches('192.168.1.42'))).toBe(true);
    });

    it('returns empty for empty string', () => {
      expect(parseIpList('')).toHaveLength(0);
    });

    it('ignores whitespace', () => {
      const matchers = parseIpList('  192.168.1.1 ,  10.0.0.0/8  ');
      expect(matchers).toHaveLength(2);
    });
  });

  describe('normalizeIp', () => {
    it('strips IPv4-mapped prefix', () => {
      expect(normalizeIp('::ffff:192.168.1.1')).toBe('192.168.1.1');
    });

    it('lowercases IPv6', () => {
      expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    });

    it('trims whitespace', () => {
      expect(normalizeIp('  192.168.1.1  ')).toBe('192.168.1.1');
    });
  });

  describe('ipToBytes', () => {
    it('converts IPv4 to 4 bytes', () => {
      expect(ipToBytes('192.168.1.1')).toEqual([192, 168, 1, 1]);
      expect(ipToBytes('10.0.0.255')).toEqual([10, 0, 0, 255]);
    });

    it('converts IPv6 to 16 bytes', () => {
      const bytes = ipToBytes('::1');
      expect(bytes).not.toBeNull();
      expect(bytes!.length).toBe(16);
    });

    it('returns null for garbage', () => {
      expect(ipToBytes('not-an-ip')).toBeNull();
    });
  });

  describe('ipInCidr', () => {
    it('matches within /24', () => {
      const prefix = ipToBytes('10.0.0.0')!;
      expect(ipInCidr(ipToBytes('10.0.0.42')!, prefix, 24)).toBe(true);
      expect(ipInCidr(ipToBytes('10.0.1.1')!, prefix, 24)).toBe(false);
    });

    it('matches within /8', () => {
      const prefix = ipToBytes('10.0.0.0')!;
      expect(ipInCidr(ipToBytes('10.255.255.255')!, prefix, 8)).toBe(true);
      expect(ipInCidr(ipToBytes('11.0.0.1')!, prefix, 8)).toBe(false);
    });

    it('handles edge: /32 exact match', () => {
      const prefix = ipToBytes('1.2.3.4')!;
      expect(ipInCidr(ipToBytes('1.2.3.4')!, prefix, 32)).toBe(true);
      expect(ipInCidr(ipToBytes('1.2.3.5')!, prefix, 32)).toBe(false);
    });
  });

  describe('getClientIp', () => {
    it('prefers X-Forwarded-For', () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
        ip: '127.0.0.1',
      } as any;
      expect(getClientIp(req)).toBe('203.0.113.1');
    });

    it('falls back to X-Real-IP', () => {
      const req = {
        headers: { 'x-real-ip': '198.51.100.42' },
        ip: '127.0.0.1',
      } as any;
      expect(getClientIp(req)).toBe('198.51.100.42');
    });

    it('falls back to request.ip', () => {
      const req = {
        headers: {},
        ip: '127.0.0.1',
      } as any;
      expect(getClientIp(req)).toBe('127.0.0.1');
    });
  });
});

// ─────────────────────────── Plugin-level: Fastify integration ───────────────────────────

describe('IP Filter Plugin (integration with Fastify)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  afterAll(async () => {
    process.env = ORIGINAL_ENV;
  });

  describe('allowlist mode', () => {
    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.API_KEYS = 'sk_test_abc123';
      process.env.IP_ALLOWLIST = '192.168.1.0/24, 10.0.0.1';
      process.env.IP_DENYLIST = '';
      process.env.ADMIN_IP_ALLOWLIST = '';
      app = await buildServer();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows IP within CIDR range', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '192.168.1.42',
      });
      // Should NOT get 403 — may get 404 from DB but not IP-blocked
      expect(res.statusCode).not.toBe(403);
    });

    it('allows exact IP match', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '10.0.0.1',
      });
      expect(res.statusCode).not.toBe(403);
    });

    it('blocks IP outside allowlist with 403', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '203.0.113.99',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Forbidden');
    });

    it('exempts /health from IP filtering', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/health',
        remoteAddress: '203.0.113.99', // Not in allowlist
      });
      expect(res.statusCode).not.toBe(403);
    });

    it('exempts /health/db from IP filtering', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/health/db',
        remoteAddress: '203.0.113.99',
      });
      expect(res.statusCode).not.toBe(403);
    });

    it('exempts /api/v1/email/track/* from IP filtering', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/email/track/open/some-message-id',
        remoteAddress: '203.0.113.99',
      });
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe('denylist mode', () => {
    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.API_KEYS = 'sk_test_abc123';
      process.env.IP_ALLOWLIST = '';
      process.env.IP_DENYLIST = '198.51.100.0/24, 203.0.113.42';
      process.env.ADMIN_IP_ALLOWLIST = '';
      app = await buildServer();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('blocks IP in denylist CIDR', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '198.51.100.50',
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks exact denylist IP', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '203.0.113.42',
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows IP not in denylist', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '1.2.3.4',
      });
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe('denylist beats allowlist', () => {
    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.API_KEYS = 'sk_test_abc123';
      process.env.IP_ALLOWLIST = '10.0.0.0/8';
      process.env.IP_DENYLIST = '10.0.99.1';
      process.env.ADMIN_IP_ALLOWLIST = '';
      app = await buildServer();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('blocks IP that is in both allowlist and denylist', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '10.0.99.1',
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows IP in allowlist but not denylist', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '10.0.0.42',
      });
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe('admin IP allowlist', () => {
    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.API_KEYS = 'sk_test_abc123';
      process.env.IP_ALLOWLIST = '';
      process.env.IP_DENYLIST = '';
      process.env.ADMIN_IP_ALLOWLIST = '10.20.30.0/24,192.168.100.1';
      app = await buildServer();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows admin IP to admin route', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/admin/api-keys',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '10.20.30.5',
      });
      expect(res.statusCode).not.toBe(403);
    });

    it('blocks non-admin IP from admin route', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/admin/api-keys',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '203.0.113.99',
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('Admin');
    });

    it('non-admin IP can still access non-admin routes', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '203.0.113.99',
      });
      // Only admin routes are restricted by ADMIN_IP_ALLOWLIST
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe('X-Forwarded-For handling', () => {
    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.API_KEYS = 'sk_test_abc123';
      process.env.IP_ALLOWLIST = '203.0.113.1';
      process.env.IP_DENYLIST = '';
      process.env.ADMIN_IP_ALLOWLIST = '';
      app = await buildServer();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('uses X-Forwarded-For for IP decision', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: {
          authorization: 'Bearer sk_test_abc123',
          'x-forwarded-for': '203.0.113.1, 10.0.0.1',
        },
        remoteAddress: '127.0.0.1', // Fastify's internal IP
      });
      expect(res.statusCode).not.toBe(403);
    });
  });

  describe('no-op when not configured', () => {
    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      process.env.API_KEYS = 'sk_test_abc123';
      process.env.IP_ALLOWLIST = '';
      process.env.IP_DENYLIST = '';
      process.env.ADMIN_IP_ALLOWLIST = '';
      app = await buildServer();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows all IPs when no lists are configured', async () => {
      const res = await inject(app, {
        method: 'GET',
        path: '/api/v1/icp/00000000-0000-0000-0000-000000000001',
        headers: { authorization: 'Bearer sk_test_abc123' },
        remoteAddress: '8.8.8.8',
      });
      expect(res.statusCode).not.toBe(403);
    });
  });
});