/**
 * S15: Admin API Routes — API key management, suppression list, anonymization, audit
 *
 * All routes require ADMIN or OPERATOR permission.
 * Canonical data in English (backend); user-facing messages in pt-BR.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  validateApiKey,
  type ApiKeyRecord,
} from '../../core/security/apiKeys.js';
import { recordAudit, queryAuditLogs } from '../../core/security/auditTrail.js';
import {
  unsubscribeLead,
  addToSuppressionList,
  removeFromSuppressionList,
  listSuppressionEntries,
  isSuppressed,
} from '../../core/security/suppression.js';
import {
  anonymizeLead,
  scheduledAnonymization,
  getRetentionPolicy,
  updateRetentionPolicy,
  listRetentionPolicies,
} from '../../core/security/retention.js';
import {
  setupTotp,
  confirmTotp,
  disableTotp,
  regenerateBackupCodes,
} from '../../core/security/totp.js';

// ──────────────────────────────── Helpers ────────────────────────────────

/** Typed Prisma client for S15 models (avoids TS errors before prisma generate runs) */
const db = prisma as any;

function isAdmin(key: any): boolean {
  return key?.permission === 'ADMIN';
}

function isOperatorOrAbove(key: any): boolean {
  return ['ADMIN', 'OPERATOR'].includes(key?.permission);
}

// ──────────────────────────────── Validation Schemas ────────────────────────────────

const CreateKeySchema = z.object({
  name: z.string().min(1).max(255),
  permission: z.enum(['ADMIN', 'OPERATOR', 'VIEWER', 'CAMPAIGN_MANAGER']),
  userId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  campaignIds: z.array(z.string().uuid()).optional(),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

const AddSuppressionSchema = z.object({
  suppressionType: z.enum(['EMAIL', 'DOMAIN', 'LINKEDIN_URL']),
  value: z.string().min(1).max(500),
  reason: z.string().max(2000).optional(),
  leadId: z.string().uuid().optional(),
});

const UpdateRetentionSchema = z.object({
  retentionDays: z.number().int().positive().max(36500).optional(),
  autoAnonymize: z.boolean().optional(),
  autoDelete: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

// ──────────────────────────────── Routes ────────────────────────────────

export async function adminRoutes(app: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────────
  // API Key Management
  // ────────────────────────────────────────────────────────────────────────

  app.post('/api/v1/admin/api-keys', {
    schema: {
      description: 'S15: Create a new API key. Only ADMIN.',
      tags: ['Admin', 'S15'],
    },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores podem criar chaves.' });
    }
    const parsed = CreateKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    try {
      const { plainKey, record } = await createApiKey(
        { apiKey: db.apiKey, auditLog: db.auditLog },
        parsed.data,
      );
      return reply.status(201).send({
        message: 'Chave de API criada com sucesso.',
        apiKey: { id: record.id, name: record.name, permission: record.permission, active: record.active, expiresAt: record.expiresAt, version: record.version },
        key: plainKey,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Chave não pôde ser criada', message: err.message });
    }
  });

  app.post('/api/v1/admin/api-keys/:id/rotate', {
    schema: { description: 'S15: Rotate an API key. Only ADMIN.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores podem rotacionar chaves.' });
    }
    try {
      const { plainKey, record } = await rotateApiKey(
        { apiKey: db.apiKey, auditLog: db.auditLog },
        (request.params as { id: string }).id,
      );
      return {
        message: 'Chave rotacionada com sucesso.',
        apiKey: { id: record.id, name: record.name, permission: record.permission, version: record.version },
        key: plainKey,
      };
    } catch (err: any) {
      const status = err.message.includes('not found') ? 404 : 400;
      return reply.status(status).send({ error: 'Falha ao rotacionar chave', message: err.message });
    }
  });

  app.delete('/api/v1/admin/api-keys/:id', {
    schema: { description: 'S15: Revoke an API key. Only ADMIN.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores podem revogar chaves.' });
    }
    try {
      await revokeApiKey(
        { apiKey: db.apiKey, auditLog: db.auditLog },
        (request.params as { id: string }).id,
      );
      return { message: 'Chave revogada com sucesso.' };
    } catch (err: any) {
      const status = err.message.includes('not found') ? 404 : 400;
      return reply.status(status).send({ error: 'Falha ao revogar chave', message: err.message });
    }
  });

  app.get('/api/v1/admin/api-keys', {
    schema: { description: 'S15: List all active API keys. ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const keys = await listApiKeys(
        { apiKey: db.apiKey, auditLog: db.auditLog },
        { activeOnly: true },
      );
      return { keys };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao listar chaves', message: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suppression List Management
  // ────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/suppression', {
    schema: { description: 'S15: List suppression entries. ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const type = (request.query as any)?.type;
      const entries = await listSuppressionEntries(db, type ? { type: type as any } : undefined);
      return { entries };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao listar supressões', message: err.message });
    }
  });

  app.post('/api/v1/admin/suppression', {
    schema: { description: 'S15: Add entry to global suppression list. ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    const parsed = AddSuppressionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    try {
      const result = await addToSuppressionList(db, { ...parsed.data, isAutomatic: false, addedBy: request.__apiKey?.id ?? 'admin' });
      if (result.alreadyExisted) {
        return { message: 'Entrada já existe na lista de supressão.' };
      }
      return { message: 'Adicionado à lista de supressão.', id: result.id };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao adicionar à supressão', message: err.message });
    }
  });

  app.delete('/api/v1/admin/suppression/:id', {
    schema: { description: 'S15: Remove entry from global suppression list. ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const ok = await removeFromSuppressionList(db, (request.params as { id: string }).id);
      if (!ok) return reply.status(404).send({ error: 'Entrada não encontrada.' });
      return { message: 'Removido da lista de supressão.' };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao remover supressão', message: err.message });
    }
  });

  app.get('/api/v1/admin/suppression/check', {
    schema: { description: 'S15: Check if email/domain/LinkedIn URL is suppressed. Operator+.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const q = request.query as Record<string, string>;
      const suppressed = await isSuppressed(db, q.email, q.domain, q.linkedin_url);
      return { suppressed };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao verificar supressão', message: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Anonymization & Retention
  // ────────────────────────────────────────────────────────────────────────

  app.post('/api/v1/admin/anonymize/lead/:id', {
    schema: { description: 'S15: Anonymize a lead (LGPD right-to-erasure). ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const result = await anonymizeLead(db, (request.params as { id: string }).id, request.__apiKey?.id);
      return { message: 'Lead anonimizado com sucesso.', ...result };
    } catch (err: any) {
      const status = err.message.includes('not found') ? 404 : 400;
      return reply.status(status).send({ error: 'Falha ao anonimizar lead', message: err.message });
    }
  });

  app.post('/api/v1/admin/retention/run', {
    schema: { description: 'S15: Run scheduled anonymization manually. ADMIN only.', tags: ['Admin', 'S15'] },
  }, async (_request: any, reply: any) => {
    if (!isAdmin(_request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores.' });
    }
    try {
      const result = await scheduledAnonymization(db);
      return { message: 'Anonimização executada.', ...result };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha na anonimização', message: err.message });
    }
  });

  app.get('/api/v1/admin/retention/policies', {
    schema: { description: 'S15: List data retention policies. ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const policies = await listRetentionPolicies(db);
      return { policies };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao listar políticas', message: err.message });
    }
  });

  app.put('/api/v1/admin/retention/policies/:entityType', {
    schema: { description: 'S15: Update a data retention policy. ADMIN only.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores.' });
    }
    const parsed = UpdateRetentionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    try {
      const policy = await updateRetentionPolicy(db, (request.params as { entityType: string }).entityType, parsed.data, request.__apiKey?.id);
      return { message: 'Política atualizada.', policy };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao atualizar política', message: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Audit Log
  // ────────────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────────
  // TOTP Two-Factor Authentication (S15)
  // ────────────────────────────────────────────────────────────────────────

  /** POST /api/v1/admin/totp/setup/:apiKeyId — Set up TOTP for a key */
  app.post('/api/v1/admin/totp/setup/:apiKeyId', {
    schema: { description: 'S15: Initiate TOTP setup for an API key. ADMIN only.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores.' });
    }
    try {
      const apiKeyId = (request.params as { apiKeyId: string }).apiKeyId;
      const key = await db.apiKey.findUnique({ where: { id: apiKeyId } });
      if (!key) return reply.status(404).send({ error: 'Chave não encontrada.' });

      const result = await setupTotp(
        { totpSecret: db.totpSecret, apiKey: db.apiKey },
        apiKeyId,
        key.name,
      );

      return {
        message: 'Configuração TOTP iniciada. Escaneie o QR code e confirme com um código.',
        otpauthUri: result.otpauthUri,
        secretPreview: result.secretPreview,
        backupCodes: result.backupCodes,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha na configuração', message: err.message });
    }
  });

  /** POST /api/v1/admin/totp/confirm/:apiKeyId — Confirm TOTP setup with a code */
  app.post('/api/v1/admin/totp/confirm/:apiKeyId', {
    schema: { description: 'S15: Confirm TOTP setup with authenticator code. ADMIN only.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores.' });
    }
    const body = request.body as { code?: string };
    if (!body?.code || !/^\d{6}$/.test(body.code)) {
      return reply.status(400).send({ error: 'Validation failed', message: 'Forneça um código TOTP de 6 dígitos.' });
    }
    try {
      const result = await confirmTotp(
        { totpSecret: db.totpSecret, apiKey: db.apiKey },
        (request.params as { apiKeyId: string }).apiKeyId,
        body.code,
      );
      if (!result.confirmed) {
        return reply.status(400).send({ error: 'Código inválido', message: 'O código TOTP não corresponde. Tente novamente.' });
      }
      return { message: 'TOTP ativado com sucesso. A chave agora requer 2FA para rotas admin.' };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha na confirmação', message: err.message });
    }
  });

  /** POST /api/v1/admin/totp/disable/:apiKeyId — Disable TOTP */
  app.post('/api/v1/admin/totp/disable/:apiKeyId', {
    schema: { description: 'S15: Disable TOTP for a key. ADMIN only.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores.' });
    }
    const body = request.body as { code?: string };
    try {
      const result = await disableTotp(
        { totpSecret: db.totpSecret, apiKey: db.apiKey },
        (request.params as { apiKeyId: string }).apiKeyId,
        body?.code,
      );
      if (!result.disabled) {
        return reply.status(400).send({ error: 'Não foi possível desativar', message: result.reason });
      }
      return { message: 'TOTP desativado com sucesso.' };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao desativar', message: err.message });
    }
  });

  /** POST /api/v1/admin/totp/backup-codes/:apiKeyId — Regenerate backup codes */
  app.post('/api/v1/admin/totp/backup-codes/:apiKeyId', {
    schema: { description: 'S15: Regenerate TOTP backup codes. ADMIN only.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isAdmin(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Apenas administradores.' });
    }
    const body = request.body as { totpCode?: string };
    if (!body?.totpCode || !/^\d{6}$/.test(body.totpCode)) {
      return reply.status(400).send({ error: 'Validation failed', message: 'Forneça um código TOTP de 6 dígitos para autorizar.' });
    }
    try {
      const result = await regenerateBackupCodes(
        { totpSecret: db.totpSecret, apiKey: db.apiKey },
        (request.params as { apiKeyId: string }).apiKeyId,
        body.totpCode,
      );
      if (!result.success) {
        return reply.status(400).send({ error: result.reason, message: result.reason });
      }
      return { message: 'Novos códigos de backup gerados.', backupCodes: result.backupCodes };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao gerar códigos', message: err.message });
    }
  });

  app.get('/api/v1/admin/audit', {
    schema: { description: 'S15: Query audit log entries. ADMIN and OPERATOR.', tags: ['Admin', 'S15'] },
  }, async (request: any, reply: any) => {
    if (!isOperatorOrAbove(request.__apiKey)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Permissão insuficiente.' });
    }
    try {
      const q = request.query as Record<string, string>;
      const { entries, total } = await queryAuditLogs(
        { auditLog: db.auditLog },
        {
          action: q.action ? (q.action as any) : undefined,
          severity: q.severity,
          limit: q.limit ? parseInt(q.limit) : 50,
          offset: q.offset ? parseInt(q.offset) : 0,
        },
      );
      return { entries, total };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Falha ao consultar logs', message: err.message });
    }
  });
}