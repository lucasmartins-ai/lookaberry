/**
 * S15: IP Filtering Plugin — Allowlist / Denylist for HTTP Requests
 *
 * Two modes, applied in order:
 * 1. **Denylist** (`IP_DENYLIST`) — blocked IPs get 403 immediately
 * 2. **Allowlist** (`IP_ALLOWLIST`) — when set, ONLY listed IPs pass;
 *    all others get 403
 *
 * Admin routes (`/api/v1/admin/*`) can have a separate, tighter allowlist
 * via `ADMIN_IP_ALLOWLIST` (falls back to `IP_ALLOWLIST` when empty).
 *
 * Exempt routes (always pass regardless of IP):
 *   - /health, /health/*   (liveness/readiness probes)
 *   - /api/v1/email/track/* (email tracking pixels)
 *
 * Webhook routes are NOT exempt from IP filtering by default — providers'
 * IPs should be added to the allowlist in production.
 *
 * The real client IP is determined from:
 *   1. `X-Forwarded-For` header (first entry, trust from reverse proxy)
 *   2. `X-Real-IP` header
 *   3. `request.ip` (Fastify built-in)
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/env.js';

// ──────────────────────────────── Route Classification ────────────────────────────────

/** Routes that bypass IP filtering entirely (liveness probes, trackers) */
const IP_EXEMPT_PREFIXES = ['/health', '/api/v1/email/track'];

/** Admin API prefix */
const ADMIN_PREFIX = '/api/v1/admin';

// ──────────────────────────────── IP Helpers ────────────────────────────────

/**
 * Parse a comma-separated list of IPs and CIDR ranges.
 * Accepts:
 *   - Bare IPv4:  192.168.1.1
 *   - IPv4 CIDR:   192.168.1.0/24
 *   - Bare IPv6:   ::1, 2001:db8::1
 *   - IPv6 CIDR:   2001:db8::/32
 *   - localhost
 */
function parseIpList(raw: string): IpMatcher[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => parseIpItem(item));
}

interface IpMatcher {
  matches(ip: string): boolean;
  toString(): string;
}

function parseIpItem(item: string): IpMatcher {
  if (item === 'localhost') {
    return {
      matches: (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1',
      toString: () => 'localhost',
    };
  }

  // Try CIDR
  const cidrMatch = item.match(/^([^/]+)\/(\d{1,3})$/);
  if (cidrMatch) {
    const prefix = ipToBytes(cidrMatch[1]);
    const maskBits = parseInt(cidrMatch[2], 10);

    if (prefix) {
      return {
        matches: (ip: string) => {
          const addr = ipToBytes(ip);
          if (!addr) return false;
          return ipInCidr(addr, prefix, maskBits);
        },
        toString: () => item,
      };
    }
  }

  // Bare IP
  const normalized = normalizeIp(item);
  return {
    matches: (ip: string) => normalizeIp(ip) === normalized,
    toString: () => item,
  };
}

/**
 * Convert an IPv4 or IPv6 address string to a byte array.
 * Returns null on parse failure.
 */
function ipToBytes(ip: string): number[] | null {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;

  // IPv4
  const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return [parseInt(v4[1]), parseInt(v4[2]), parseInt(v4[3]), parseInt(v4[4])];
  }

  // IPv6 (full expansion)
  try {
    // Must contain at least one ':' to be an IPv6
    if (!normalized.includes(':')) return null;

    const parts = normalized.split(':');
    // IPv6 has at most 8 segments
    const nonEmpty = parts.filter(p => p !== '');
    if (nonEmpty.length > 8) return null;

    // Validate each segment is hexadecimal
    for (const part of nonEmpty) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    }

    const bytes: number[] = [];
    for (const part of parts) {
      if (part === '') {
        // :: collapse — pad with zeros
        const missing = 8 - nonEmpty.length;
        for (let i = 0; i < missing; i++) { bytes.push(0, 0); }
      } else {
        const val = parseInt(part, 16);
        bytes.push((val >> 8) & 0xff, val & 0xff);
      }
    }
    while (bytes.length < 16) bytes.push(0);
    return bytes.slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Check if an IP address (as bytes) falls within a CIDR range.
 */
function ipInCidr(addr: number[], prefix: number[], maskBits: number): boolean {
  if (addr.length !== prefix.length) return false;

  const fullBytes = Math.floor(maskBits / 8);
  const remainingBits = maskBits % 8;

  // Full bytes must match exactly
  for (let i = 0; i < fullBytes; i++) {
    if (addr[i] !== prefix[i]) return false;
  }

  // Partial byte: only compare the masked bits
  if (remainingBits > 0 && fullBytes < addr.length) {
    const mask = 0xff << (8 - remainingBits);
    if ((addr[fullBytes] & mask) !== (prefix[fullBytes] & mask)) return false;
  }

  return true;
}

/**
 * Normalize IP address strings for comparison.
 */
function normalizeIp(ip: string): string {
  return ip.trim()
    .replace(/^::ffff:/, '')  // IPv4-mapped IPv6 → bare IPv4
    .toLowerCase();
}

// ──────────────────────────────── Client IP Resolution ────────────────────────────────

/**
 * Extract the real client IP from request headers.
 * Trusts X-Forwarded-For from a properly configured reverse proxy.
 */
function getClientIp(request: FastifyRequest): string {
  // 1. X-Forwarded-For (first entry is the original client)
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }

  // 2. X-Real-IP
  const xri = request.headers['x-real-ip'];
  if (typeof xri === 'string' && xri.length > 0) {
    return xri.trim();
  }

  // 3. Fastify built-in
  return request.ip;
}

// ──────────────────────────────── Plugin Logic ────────────────────────────────

/**
 * Compile the IP lists from env vars once at startup.
 * Called inside the plugin factory so it snapshots env vars.
 */
function loadIpLists(): {
  allowlist: IpMatcher[];
  denylist: IpMatcher[];
  adminAllowlist: IpMatcher[];
  allowlistEnabled: boolean;
  denylistEnabled: boolean;
  adminListEnabled: boolean;
} {
  const allowlist = parseIpList(process.env.IP_ALLOWLIST ?? config.IP_ALLOWLIST);
  const denylist = parseIpList(process.env.IP_DENYLIST ?? config.IP_DENYLIST);
  const adminAllowlist = process.env.ADMIN_IP_ALLOWLIST?.trim()
    ? parseIpList(process.env.ADMIN_IP_ALLOWLIST)
    : allowlist;

  return {
    allowlist,
    denylist,
    adminAllowlist,
    allowlistEnabled: allowlist.length > 0,
    denylistEnabled: denylist.length > 0,
    adminListEnabled: (process.env.ADMIN_IP_ALLOWLIST?.trim() ?? '').length > 0,
  };
}

export default fp(
  async function ipFilter(app: FastifyInstance) {
    const lists = loadIpLists();

    // Fast path: neither list is configured → skip plugin entirely
    if (!lists.allowlistEnabled && !lists.denylistEnabled && !lists.adminListEnabled) {
      return;
    }

    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      // No-op in test mode
      if (process.env.NODE_ENV === 'test') return;

      const url = request.url;
      const path = url.split('?')[0];

      // Exempt routes always pass (liveness probes, trackers)
      if (IP_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
        return;
      }

      const clientIp = getClientIp(request);

      // ── Step 1: Denylist check ──
      if (lists.denylistEnabled) {
        const blocked = lists.denylist.some((m) => m.matches(clientIp));
        if (blocked) {
          request.log.warn({
            msg: 'ip_denied',
            reason: 'denylist',
            clientIp,
            route: url,
          });
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Access denied from this IP address.',
          });
        }
      }

      // ── Step 2: Admin route extra guarding ──
      if (path.startsWith(ADMIN_PREFIX) && lists.adminListEnabled) {
        const allowed = lists.adminAllowlist.some((m) => m.matches(clientIp));
        if (!allowed) {
          request.log.warn({
            msg: 'ip_denied',
            reason: 'admin_ip_not_allowed',
            clientIp,
            route: url,
          });
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Admin routes are restricted to specific IP addresses.',
          });
        }
        return; // Passed admin check — don't re-check global allowlist
      }

      // ── Step 3: Global allowlist check ──
      if (lists.allowlistEnabled) {
        const allowed = lists.allowlist.some((m) => m.matches(clientIp));
        if (!allowed) {
          request.log.warn({
            msg: 'ip_denied',
            reason: 'not_in_allowlist',
            clientIp,
            route: url,
          });
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Access denied from this IP address.',
          });
        }
      }
    });
  },
  { name: 'ip-filter' },
);

export { getClientIp, parseIpList, normalizeIp, ipInCidr, ipToBytes, type IpMatcher };