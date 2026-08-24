import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

/**
 * S12: Structured logging plugin with request ID, duration tracking,
 * and correlation IDs for cross-event tracing (webhooks → tracking → dispatcher).
 *
 * Sets `X-Request-Id` on every response and attaches a child logger
 * with request metadata.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation ID for linking webhook → tracking → dispatcher events */
    correlationId?: string;
  }
}

export default fp(
  async function structuredLogging(app: FastifyInstance) {
    // ── Add request-id to every request ──
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      // Prefer incoming X-Request-Id for propagation; generate if missing
      const incoming = request.headers['x-request-id'];
      const requestId = typeof incoming === 'string' && incoming.length > 0
        ? incoming
        : randomUUID();

      reply.header('X-Request-Id', requestId);
      request.id = requestId;

      // Propagate correlation ID if provided (webhook → tracking → dispatcher chain)
      const correlationHeader = request.headers['x-correlation-id'];
      if (typeof correlationHeader === 'string' && correlationHeader.length > 0) {
        request.correlationId = correlationHeader;
        reply.header('X-Correlation-Id', correlationHeader);
      }
    });

    // ── Log every completed request with duration ──
    app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
      const durationMs = Math.round(reply.elapsedTime);
      const route = request.routeOptions?.url ?? request.url.split('?')[0];
      const correlation = request.correlationId;

      reply.header('X-Response-Time', durationMs.toString());

      // Use structured log via Fastify's built-in logger
      request.log.info({
        msg: 'request_completed',
        method: request.method,
        route,
        statusCode: reply.statusCode,
        durationMs,
        remoteIp: request.ip,
        correlationId: correlation ?? undefined,
        userAgent: request.headers['user-agent']?.slice(0, 200),
      });

      // Warn on slow requests
      if (durationMs > 2000) {
        request.log.warn({
          msg: 'slow_request',
          method: request.method,
          route,
          durationMs,
          correlationId: correlation ?? undefined,
        });
      }
    });
  },
  { name: 'structured-logging' },
);