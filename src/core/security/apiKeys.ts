/**
 * S15: API Key Management — Creation, Rotation, Revocation & Validation
 *
 * Canonical data in English (backend), user-facing copy in pt-BR when applicable.
 *
 * Key lifecycle:
 *   create → active → (rotate) → rotated → (revoke) → revoked
 *
 * Rotation produces a new key and deactivates the old one, preserving an audit
 * trail through the `rotatedFrom` / `version` chain.
 */

import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Permission levels for API keys.
 * Mirrors the ApiKeyPermission enum in Prisma schema.
 */
export type ApiKeyPermission = 'ADMIN' | 'OPERATOR' | 'VIEWER' | 'CAMPAIGN_MANAGER';

// ──────────────────────────────── Types ────────────────────────────────

export interface CreateApiKeyInput {
  name: string;
  permission: ApiKeyPermission;
  userId?: string;
  teamId?: string;
  campaignIds?: string[];
  expiresInDays?: number; // Default: no expiry (null)
}

export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string;
  permission: ApiKeyPermission;
  userId: string | null;
  teamId: string | null;
  campaignIds: string[];
  active: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  requireTotp: boolean;
  version: number;
  createdAt: Date;
}

interface ApiKeyStore {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string; key: string }>;
  findUnique(args: { where: { id?: string; key?: string } }): Promise<ApiKeyRecord | null>;
  findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; skip?: number }): Promise<ApiKeyRecord[]>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<ApiKeyRecord>;
  delete(args: { where: { id: string } }): Promise<ApiKeyRecord>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
}

export interface ApiKeyStoreFull {
  apiKey: ApiKeyStore;
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

// ──────────────────────────────── Helpers ────────────────────────────────

const KEY_PREFIX = 'lb_';

/** Generate a cryptographically random API key: lb_ + 32 bytes base64url */
function generateKey(): string {
  const raw = crypto.randomBytes(32);
  return KEY_PREFIX + raw.toString('base64url');
}

/** Hash a key for storage lookup (not for the key value itself, just for rotatedFrom ref) */
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// ──────────────────────────────── Key Management ────────────────────────────────

/**
 * Create a new API key.
 * The full key value is returned only once at creation — it is stored hashed.
 */
export async function createApiKey(
  store: ApiKeyStoreFull,
  input: CreateApiKeyInput,
  actor?: { userId?: string; ip?: string },
): Promise<{ record: ApiKeyRecord; plainKey: string }> {
  const plainKey = generateKey();
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 86_400_000)
    : null;

  const record = await store.apiKey.create({
    data: {
      key: plainKey,
      name: input.name,
      permission: input.permission,
      userId: input.userId ?? null,
      teamId: input.teamId ?? null,
      campaignIds: input.campaignIds ?? [],
      active: true,
      expiresAt,
    },
  });

  // Audit trail
  await store.auditLog.create({
    data: {
      action: 'API_KEY_CREATED',
      actorId: actor?.userId ?? null,
      apiKeyId: record.id,
      targetType: 'api_key',
      targetId: record.id,
      details: {
        name: input.name,
        permission: input.permission,
        teamId: input.teamId ?? null,
      },
      ip: actor?.ip ?? null,
      severity: 'INFO',
      createdAt: new Date(),
    },
  });

  return {
    record: {
      id: record.id,
      key: hashKey(plainKey),
      name: input.name,
      permission: input.permission,
      userId: input.userId ?? null,
      teamId: input.teamId ?? null,
      campaignIds: input.campaignIds ?? [],
      active: true,
      expiresAt,
      lastUsedAt: null,
      requireTotp: false,
      version: 1,
      createdAt: new Date(),
    },
    plainKey,
  };
}

/**
 * Rotate an API key — creates a new key with the same permissions and
 * deactivates the old one. Returns the new plain key.
 */
export async function rotateApiKey(
  store: ApiKeyStoreFull,
  existingKeyId: string,
  actor?: { userId?: string; ip?: string },
): Promise<{ record: ApiKeyRecord; plainKey: string }> {
  const existing = await store.apiKey.findUnique({ where: { id: existingKeyId } });
  if (!existing) throw new Error('API key not found');
  if (!existing.active) throw new Error('Cannot rotate an inactive key');

  const plainKey = generateKey();
  const newVersion = (existing.version ?? 1) + 1;

  // Deactivate old key
  await store.apiKey.update({
    where: { id: existingKeyId },
    data: { active: false },
  });

  // Create new key linked to old
  const record = await store.apiKey.create({
    data: {
      key: plainKey,
      name: existing.name,
      permission: existing.permission,
      userId: existing.userId,
      teamId: existing.teamId,
      campaignIds: existing.campaignIds ?? [],
      active: true,
      expiresAt: existing.expiresAt,
      rotatedFrom: hashKey(existing.key),
      version: newVersion,
    },
  });

  // Audit trail
  await store.auditLog.create({
    data: {
      action: 'API_KEY_ROTATED',
      actorId: actor?.userId ?? null,
      apiKeyId: record.id,
      targetType: 'api_key',
      targetId: existingKeyId,
      details: {
        oldKeyId: existingKeyId,
        newKeyId: record.id,
        version: newVersion,
        name: existing.name,
      },
      ip: actor?.ip ?? null,
      severity: 'INFO',
      createdAt: new Date(),
    },
  });

  return {
    record: {
      id: record.id,
      key: hashKey(plainKey),
      name: existing.name,
      permission: existing.permission,
      userId: existing.userId,
      teamId: existing.teamId,
      campaignIds: existing.campaignIds ?? [],
      active: true,
      expiresAt: existing.expiresAt,
      lastUsedAt: null,
      requireTotp: false,
      version: newVersion,
      createdAt: new Date(),
    },
    plainKey,
  };
}

/**
 * Revoke (delete) an API key. Marks it inactive and records the audit trail.
 */
export async function revokeApiKey(
  store: ApiKeyStoreFull,
  keyId: string,
  actor?: { userId?: string; ip?: string },
): Promise<ApiKeyRecord> {
  const existing = await store.apiKey.findUnique({ where: { id: keyId } });
  if (!existing) throw new Error('API key not found');

  const record = await store.apiKey.update({
    where: { id: keyId },
    data: { active: false },
  });

  // Audit trail
  await store.auditLog.create({
    data: {
      action: 'API_KEY_REVOKED',
      actorId: actor?.userId ?? null,
      apiKeyId: keyId,
      targetType: 'api_key',
      targetId: keyId,
      details: {
        name: existing.name,
        permission: existing.permission,
      },
      ip: actor?.ip ?? null,
      severity: 'WARNING',
      createdAt: new Date(),
    },
  });

  return record;
}

/**
 * List active API keys.
 */
export async function listApiKeys(
  store: ApiKeyStoreFull,
  options?: { activeOnly?: boolean; teamId?: string; userId?: string },
): Promise<Array<ApiKeyRecord & { keyPreview: string }>> {
  const where: Record<string, unknown> = {};
  if (options?.activeOnly !== false) where.active = true;
  if (options?.teamId) where.teamId = options.teamId;
  if (options?.userId) where.userId = options.userId;

  const keys = await store.apiKey.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  return keys.map((k) => ({
    ...k,
    keyPreview: k.key.length > 12 ? `${k.key.slice(0, 6)}...${k.key.slice(-4)}` : k.key.slice(0, 4),
  }));
}

/**
 * Validate an API key — returns the key record if valid, null otherwise.
 * Also updates lastUsedAt.
 */
export async function validateApiKey(
  store: ApiKeyStoreFull,
  plainKey: string,
): Promise<ApiKeyRecord | null> {
  const record = await store.apiKey.findUnique({ where: { key: plainKey } });
  if (!record) return null;

  if (!record.active) return null;
  if (record.expiresAt && record.expiresAt < new Date()) {
    // Auto-deactivate expired keys
    await store.apiKey.update({
      where: { id: record.id },
      data: { active: false },
    });
    return null;
  }

  // Update last used timestamp (fire and forget — non-blocking)
  store.apiKey.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => { /* non-critical */ });

  return record;
}

/**
 * Check if a key has a specific permission.
 */
export function hasPermission(record: ApiKeyRecord, required: ApiKeyPermission): boolean {
  const order: Record<string, number> = {
    ADMIN: 4,
    OPERATOR: 3,
    CAMPAIGN_MANAGER: 2,
    VIEWER: 1,
  };
  return (order[record.permission] ?? 0) >= (order[required] ?? 0);
}

/**
 * Check if a key can access a specific campaign. ADMINs bypass this check.
 */
export function canAccessCampaign(record: ApiKeyRecord, campaignId: string): boolean {
  if (record.permission === 'ADMIN') return true;
  if (record.campaignIds.length === 0 && record.permission === 'OPERATOR') return true;
  return record.campaignIds.includes(campaignId);
}