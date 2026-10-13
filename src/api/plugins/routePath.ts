import type { FastifyRequest } from 'fastify';

/**
 * The path the router actually matched: the registered route pattern when there is one,
 * else the percent-decoded path without the query string. Every security decision
 * (auth exemptions, TOTP, admin IP allowlist, rate tiers, webhook checks) must use this,
 * never request.url: "/api/v1/%61dmin" routes to /api/v1/admin but fails a raw prefix check.
 */
export function routePath(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url;
  if (pattern) return pattern;
  const raw = request.url.split('?')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
