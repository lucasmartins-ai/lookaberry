import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../config/env.js';
import securityHeaders from '../api/plugins/securityHeaders.js';
import inputValidation from '../api/plugins/inputValidation.js';
import auth from '../api/plugins/auth.js';
import rateLimit from '../api/plugins/rateLimit.js';
import webhookAuth from '../api/plugins/webhookAuth.js';
import idempotency from '../api/plugins/idempotency.js';
import auditLog from '../api/plugins/auditLog.js';
import structuredLogging from '../api/plugins/structuredLogging.js';
import ipFilter from '../api/plugins/ipFilter.js';
import { setupSwagger } from '../api/plugins/swagger.js';
import { healthRoutes } from '../api/routes/health.js';
import { icpRoutes } from '../api/routes/icp.js';
import { mcpSseRoutes } from '../api/routes/mcpSse.js';
import { webhookRoutes } from '../api/routes/webhooks.js';
import { emailTrackingRoutes } from '../api/routes/emailTracking.js';
import { emailWebhookRoutes } from '../api/routes/emailWebhooks.js';
import { whatsappWebhookRoutes } from '../api/routes/whatsappWebhooks.js';
import { campaignRoutes } from '../api/routes/campaigns.js';
import { adminRoutes } from '../api/routes/admin.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'error' : 'info',
    },
  });

  // S7: Security plugins — order matters
  // 0. Structured logging (request ID, correlation, duration)
  await app.register(structuredLogging);

  // 0.5 IP filtering (allowlist/denylist — runs before auth)
  await app.register(ipFilter);

  // 1. Security headers on every response
  await app.register(securityHeaders);

  // 2. Input validation (content-type, size, depth)
  await app.register(inputValidation);

  // 3. CORS hardening
  const corsOrigins = (process.env.CORS_ORIGINS ?? config.CORS_ORIGINS)
    .split(',').map((o) => o.trim()).filter(Boolean);

  // Reject wildcard origin when credentials are enabled — browsers refuse this
  // combination, and it silently disables CORS protection.
  if (corsOrigins.includes('*')) {
    throw new Error(
      'CORS_ORIGINS must not contain "*" when credentials are enabled. ' +
      'List explicit origins instead.',
    );
  }

  await app.register(cors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'Idempotency-Key',
      'X-Webhook-Signature',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'Idempotency-Replayed',
    ],
    credentials: true,
  });

  // 4. API key authentication (no-op in test mode, exempt: /health, /docs, /webhooks)
  await app.register(auth);

  // 5. Rate limiting (exempt: /health)
  await app.register(rateLimit);

  // 6. Webhook HMAC signature validation (only /api/v1/webhooks/outreach)
  await app.register(webhookAuth);

  // 7. Webhook idempotency (only /api/v1/webhooks/outreach)
  await app.register(idempotency);

  // 8. Audit logging (onResponse hook)
  await app.register(auditLog);

  await setupSwagger(app);
  await app.register(healthRoutes);
  await app.register(icpRoutes);
  await app.register(mcpSseRoutes);
  await app.register(webhookRoutes);
  await app.register(emailTrackingRoutes);
  await app.register(emailWebhookRoutes);
  await app.register(whatsappWebhookRoutes);
  await app.register(campaignRoutes);
  await app.register(adminRoutes);

  return app;
}
