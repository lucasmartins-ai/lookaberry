import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { extractApiKey, fingerprint } from './auth.js';

const EXEMPT_ROUTES = new Set(['/health']);
const EXEMPT_PREFIXES = ['/health/'];

export default fp(
  async function auditLog(app: FastifyInstance) {
    app.addHook('onResponse', async (request: FastifyRequest, reply) => {
      const url = request.url;

      // Skip health checks — too noisy
      const path = url.split('?')[0];
      if (EXEMPT_ROUTES.has(path)) return;
      if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return;

      // Only log authenticated routes (skip public docs endpoints)
      if (url === '/docs' || url.startsWith('/docs/')) return;

      const now = new Date().toISOString();
      const keyFingerprint = extractApiKey(request)
        ? fingerprint(extractApiKey(request)!)
        : 'anonymous';

      const rateLimitRemaining = reply.getHeader('x-ratelimit-remaining');

      app.log.info({
        msg: 'audit',
        timestamp: now,
        method: request.method,
        route: url,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        ip: request.ip,
        keyFingerprint,
        correlationId: request.correlationId ?? undefined,
        ...(rateLimitRemaining !== undefined && {
          rateLimitRemaining: Number(rateLimitRemaining),
        }),
      });
    });
  },
  { name: 'audit-log' },
);