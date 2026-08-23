import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { config } from '../../config/env.js';

const WEBHOOK_ROUTE = '/api/v1/webhooks/outreach';
const RESEND_WEBHOOK_ROUTE = '/api/v1/email/webhooks/resend';
const WHATSAPP_WEBHOOK_ROUTE = '/api/v1/webhooks/whatsapp';
const WEBHOOK_ROUTES = [WEBHOOK_ROUTE, RESEND_WEBHOOK_ROUTE, WHATSAPP_WEBHOOK_ROUTE];
const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function computeHmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    // Buffers of different lengths will throw
    return false;
  }
}

async function validateWebhookSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.url !== WEBHOOK_ROUTE) return;

  // Dev/test: skip if WEBHOOK_SECRET not configured
  const secret = process.env.WEBHOOK_SECRET ?? config.WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WEBHOOK_SECRET must be configured in production');
    }
    request.log.warn('WEBHOOK_SECRET not configured — skipping webhook signature validation');
    return;
  }

  const signatureHeader = request.headers['x-webhook-signature'];
  if (typeof signatureHeader !== 'string') {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  // Parse: t=<timestamp>,v1=<hmac>
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(',')) {
    const [k, ...v] = part.split('=');
    if (k && v.length > 0) {
      parts[k.trim()] = v.join('=').trim();
    }
  }

  const timestamp = parts['t'];
  const providedSig = parts['v1'];

  if (!timestamp || !providedSig) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  // Check timestamp tolerance
  const tsMs = parseInt(timestamp, 10) * 1000;
  const now = Date.now();
  if (Math.abs(now - tsMs) > TOLERANCE_MS) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  // Get raw body from request
  const rawBody: string = (request as any)._rawBody;
  if (!rawBody) {
    request.log.warn('Raw body not available for webhook signature verification');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSig = computeHmac(signedPayload, secret);

  if (!timingSafeEqual(expectedSig, providedSig)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
}

// ─────────────────────────── Svix (Resend) ───────────────────────────

/**
 * Svix webhook signatures (used by Resend):
 * - Headers: `svix-id`, `svix-timestamp`, `svix-signature`
 * - Signature format: `v1,<base64-hmac-sha256>` (space-separated list, key rotation)
 * - Signed content: `<svix-id>.<svix-timestamp>.<raw-body>`
 * - Signing key: base64-decoded secret after the `whsec_` prefix
 */
export function computeSvixSignature(signedContent: string, secret: string): string {
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf-8');
  return crypto.createHmac('sha256', key).update(signedContent).digest('base64');
}

export async function validateSvixSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.url !== RESEND_WEBHOOK_ROUTE) return;

  // Dev/test: skip if RESEND_WEBHOOK_SECRET not configured
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? config.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RESEND_WEBHOOK_SECRET must be configured in production');
    }
    request.log.warn('RESEND_WEBHOOK_SECRET not configured — skipping Resend webhook signature validation');
    return;
  }

  const svixId = request.headers['svix-id'];
  const svixTimestamp = request.headers['svix-timestamp'];
  const svixSignature = request.headers['svix-signature'];

  if (
    typeof svixId !== 'string' ||
    typeof svixTimestamp !== 'string' ||
    typeof svixSignature !== 'string'
  ) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  // Check timestamp tolerance (Svix timestamps are Unix seconds)
  const tsMs = parseInt(svixTimestamp, 10) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TOLERANCE_MS) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const rawBody: string = (request as any)._rawBody;
  if (!rawBody) {
    request.log.warn('Raw body not available for webhook signature verification');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = computeSvixSignature(signedContent, secret);

  // Multiple signatures may be present (key rotation) — any match is valid
  const provided = svixSignature.split(' ').map(s => s.trim()).filter(Boolean);
  const valid = provided.some(sig => {
    if (!sig.startsWith('v1,')) return false;
    return timingSafeEqual(expected, sig.slice(3));
  });

  if (!valid) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
}

// ─────────────────────────── WhatsApp (Meta) X-Hub-Signature-256 ───────────────────────────

/**
 * Meta/WhatsApp webhook signatures:
 * - Header: `X-Hub-Signature-256: sha256=<hmac-hex>`
 * - Signed content: raw request body
 * - Signing key: WHATSAPP_APP_SECRET
 * - Used for POST /api/v1/webhooks/whatsapp (inbound messages & statuses)
 */

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';

export async function validateWhatsAppSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // request.url may include query string — strip for route matching
  const path = request.url.split('?')[0];
  if (path !== WHATSAPP_WEBHOOK_ROUTE) return;
  if (request.method !== 'POST') return;

  const secret = process.env.WHATSAPP_APP_SECRET ?? config.WHATSAPP_APP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WHATSAPP_APP_SECRET must be configured in production');
    }
    request.log.warn('WHATSAPP_APP_SECRET not configured — skipping WhatsApp webhook signature validation');
    return;
  }

  const signatureHeader = request.headers['x-hub-signature-256'];
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const providedSig = signatureHeader.slice('sha256='.length);

  const rawBody: string = (request as any)._rawBody;
  if (!rawBody) {
    request.log.warn('Raw body not available for WhatsApp webhook signature verification');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (!timingSafeEqual(expected, providedSig)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
}

/** Handle WhatsApp webhook verification handshake (GET request) */
export async function handleWhatsAppVerification(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // request.url includes query string — strip for route matching
  const path = request.url.split('?')[0];
  if (path !== WHATSAPP_WEBHOOK_ROUTE) return;
  if (request.method !== 'GET') return;

  const query = request.query as Record<string, string>;
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? config.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken && challenge) {
    reply.type('text/plain').send(challenge);
    return;
  }

  return reply.status(403).send({ error: 'Forbidden' });
}

export default fp(
  async function webhookAuth(app: FastifyInstance) {
    // Capture raw body for webhook routes BEFORE Fastify parses them
    app.addHook('preParsing', async (request, _reply, payload) => {
      if (WEBHOOK_ROUTES.includes(request.url) && payload) {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        (request as any)._rawBody = Buffer.concat(chunks).toString('utf-8');

        // Return a new stream so Fastify can still parse the body
        const { Readable } = await import('node:stream');
        return Readable.from([(request as any)._rawBody]);
      }
      return payload;
    });

    // WhatsApp verification handshake (GET)
    app.addHook('preHandler', async (request, reply) => {
      if (request.method === 'GET') {
        await handleWhatsAppVerification(request, reply);
      }
    });

    // Validate signature in preHandler (after body is parsed)
    app.addHook('preHandler', async (request, reply) => {
      if (request.method !== 'POST') return;
      if (request.url === WEBHOOK_ROUTE) {
        await validateWebhookSignature(request, reply);
      }
      if (request.url === RESEND_WEBHOOK_ROUTE) {
        await validateSvixSignature(request, reply);
      }
      if (request.url === WHATSAPP_WEBHOOK_ROUTE) {
        await validateWhatsAppSignature(request, reply);
      }
    });
  },
  { name: 'webhook-auth' },
);

export { computeHmac, timingSafeEqual, validateWebhookSignature };
