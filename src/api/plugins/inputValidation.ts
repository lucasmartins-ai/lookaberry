import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config/env.js';

const MAX_KEY_LENGTH = 256;
const MAX_DEPTH = 20;

function checkDepth(obj: unknown, depth: number = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (obj === null || typeof obj !== 'object') return true;
  if (Array.isArray(obj)) {
    return obj.every((item) => checkDepth(item, depth + 1));
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key.length > MAX_KEY_LENGTH) return false;
    if (!checkDepth(value, depth + 1)) return false;
  }
  return true;
}

export default fp(
  async function inputValidation(app: FastifyInstance) {
    app.addHook('onRequest', async (request, reply) => {
      const method = request.method.toUpperCase();
      const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(method);

      if (!isBodyMethod) return;

      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        return reply.status(415).send({
          error: 'Unsupported Media Type',
          message: 'Only application/json is accepted for request bodies',
        });
      }

      const maxSize = Number(process.env.MAX_BODY_SIZE_BYTES ?? config.MAX_BODY_SIZE_BYTES);
      const contentLength = parseInt(request.headers['content-length'] ?? '0', 10);
      if (contentLength > maxSize) {
        return reply.status(413).send({
          error: 'Payload Too Large',
          message: `Body exceeds maximum size of ${config.MAX_BODY_SIZE_BYTES} bytes`,
        });
      }
    });

    // Validate body depth after parsing
    app.addHook('preHandler', async (request, reply) => {
      const method = request.method.toUpperCase();
      const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(method);

      if (!isBodyMethod || !request.body) return;

      if (!checkDepth(request.body)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Payload exceeds maximum nesting depth or key length',
        });
      }
    });
  },
  { name: 'input-validation' },
);