import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

export default fp(
  async function securityHeaders(app: FastifyInstance) {
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('X-XSS-Protection', '0');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');

      if (process.env.NODE_ENV === 'production') {
        reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
      }

      try {
        reply.removeHeader('X-Powered-By');
      } catch {
        // Header may not exist — ignore
      }

      return payload;
    });
  },
  { name: 'security-headers' },
);