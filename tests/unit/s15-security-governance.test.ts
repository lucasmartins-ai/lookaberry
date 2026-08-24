/**
 * S15 Unit Tests: Security & Governance
 *
 * Covers:
 * - API Key lifecycle (create, rotate, revoke, validate)
 * - RBAC permissions and campaign isolation
 * - Audit trail
 * - Global suppression list
 * - Unsubscribe cascade
 * - Data retention & anonymization
 * - Secrets masking
 *
 * Pure unit tests — no DB required (mocked stores).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────────
// API Key Management
// ────────────────────────────────────────────────────────────────────────────

import {
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  validateApiKey,
  hasPermission,
  canAccessCampaign,
  type ApiKeyRecord,
  type ApiKeyStoreFull,
} from '../../src/core/security/apiKeys.js';

function makeApiKeyStore(): ApiKeyStoreFull & { _keys: Map<string, any> } {
  const keys = new Map<string, any>();
  let nextIdx = 1;

  return {
    _keys: keys,
    apiKey: {
      create: vi.fn(async (args: any) => {
        const id = `key-${nextIdx++}`;
        const record = {
          id,
          key: args.data.key,
          name: args.data.name ?? '',
          permission: args.data.permission ?? 'OPERATOR',
          userId: args.data.userId ?? null,
          teamId: args.data.teamId ?? null,
          campaignIds: args.data.campaignIds ?? [],
          active: args.data.active ?? true,
          expiresAt: args.data.expiresAt ?? null,
          lastUsedAt: null,
          version: args.data.version ?? 1,
          createdAt: new Date(),
        };
        keys.set(id, record);
        keys.set(args.data.key, record); // Also index by key value
        return record;
      }),
      findUnique: vi.fn(async (args: any) => {
        if (args.where.id) return keys.get(args.where.id) ?? null;
        if (args.where.key) return keys.get(args.where.key) ?? null;
        return null;
      }),
      findMany: vi.fn(async () => Array.from(keys.values()).filter((k: any) => k.active)),
      update: vi.fn(async (args: any) => {
        const existing = keys.get(args.where.id);
        if (!existing) throw new Error('Not found');
        Object.assign(existing, args.data);
        return existing;
      }),
      delete: vi.fn(async (args: any) => {
        const existing = keys.get(args.where.id);
        keys.delete(args.where.id);
        return existing;
      }),
      count: vi.fn(async () => keys.size),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
    },
  };
}

describe('S15 API Key Management', () => {
  let store: ReturnType<typeof makeApiKeyStore>;

  beforeEach(() => {
    store = makeApiKeyStore();
  });

  describe('createApiKey', () => {
    it('creates a key with the lb_ prefix', async () => {
      const { plainKey, record } = await createApiKey(store, {
        name: 'test-key',
        permission: 'OPERATOR',
      });

      expect(plainKey).toMatch(/^lb_[A-Za-z0-9_-]{32,}$/);
      expect(record.name).toBe('test-key');
      expect(record.permission).toBe('OPERATOR');
      expect(record.active).toBe(true);
      expect(record.version).toBe(1);
    });

    it('sets expiry correctly', async () => {
      const { record } = await createApiKey(store, {
        name: 'expiring-key',
        permission: 'VIEWER',
        expiresInDays: 30,
      });

      expect(record.expiresAt).toBeInstanceOf(Date);
      const diff = record.expiresAt!.getTime() - Date.now();
      expect(diff).toBeGreaterThan(29 * 86400000);
      expect(diff).toBeLessThan(31 * 86400000);
    });

    it('records an audit entry', async () => {
      const { record } = await createApiKey(store, {
        name: 'audited-key',
        permission: 'ADMIN',
      });

      expect(store.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'API_KEY_CREATED',
            targetType: 'api_key',
          }),
        }),
      );
    });

    it('supports campaignIds restriction', async () => {
      const { record } = await createApiKey(store, {
        name: 'campaign-key',
        permission: 'CAMPAIGN_MANAGER',
        campaignIds: ['campaign-1', 'campaign-2'],
      });

      expect(record.campaignIds).toEqual(['campaign-1', 'campaign-2']);
    });
  });

  describe('rotateApiKey', () => {
    it('creates a new key and deactivates the old one', async () => {
      const { record: oldKey } = await createApiKey(store, {
        name: 'to-rotate',
        permission: 'OPERATOR',
      });

      const { plainKey, record: newKey } = await rotateApiKey(store, oldKey.id);

      expect(plainKey).toMatch(/^lb_/);
      expect(newKey.name).toBe('to-rotate');
      expect(newKey.version).toBe(2);

      const oldRecord = await store.apiKey.findUnique({ where: { id: oldKey.id } });
      expect(oldRecord?.active).toBe(false);
    });

    it('throws when rotating inactive key', async () => {
      const { record: key } = await createApiKey(store, {
        name: 'to-rotate',
        permission: 'OPERATOR',
      });

      await revokeApiKey(store, key.id);

      await expect(rotateApiKey(store, key.id)).rejects.toThrow('Cannot rotate an inactive key');
    });

    it('throws when key not found', async () => {
      await expect(rotateApiKey(store, 'non-existent')).rejects.toThrow('API key not found');
    });
  });

  describe('revokeApiKey', () => {
    it('deactivates the key and records audit', async () => {
      const { record: key } = await createApiKey(store, {
        name: 'to-revoke',
        permission: 'VIEWER',
      });

      const result = await revokeApiKey(store, key.id);
      expect(result.active).toBe(false);

      expect(store.auditLog.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'API_KEY_REVOKED',
          }),
        }),
      );
    });

    it('throws when key not found', async () => {
      await expect(revokeApiKey(store, 'non-existent')).rejects.toThrow('API key not found');
    });
  });

  describe('validateApiKey', () => {
    it('returns the key record for valid keys', async () => {
      const { plainKey, record } = await createApiKey(store, {
        name: 'valid-key',
        permission: 'OPERATOR',
      });

      const result = await validateApiKey(store, plainKey);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(record.id);
      expect(result!.permission).toBe('OPERATOR');
    });

    it('returns null for revoked keys', async () => {
      const { plainKey, record } = await createApiKey(store, {
        name: 'will-revoke',
        permission: 'OPERATOR',
      });

      await revokeApiKey(store, record.id);
      const result = await validateApiKey(store, plainKey);
      expect(result).toBeNull();
    });

    it('returns null for expired keys', async () => {
      const { plainKey, record } = await createApiKey(store, {
        name: 'will-expire',
        permission: 'OPERATOR',
        expiresInDays: 0, // Already expired
      });

      // Manually expire it
      await store.apiKey.update({
        where: { id: record.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const result = await validateApiKey(store, plainKey);
      expect(result).toBeNull();
    });

    it('returns null for unknown keys', async () => {
      const result = await validateApiKey(store, 'lb_not_a_real_key');
      expect(result).toBeNull();
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Permission Checks
// ────────────────────────────────────────────────────────────────────────────

describe('S15 hasPermission', () => {
  function makeRecord(permission: string): ApiKeyRecord {
    return {
      id: 'k1',
      key: 'hashed-key',
      name: 'test',
      permission: permission as any,
      userId: null,
      teamId: null,
      campaignIds: [],
      active: true,
      expiresAt: null,
      lastUsedAt: null,
      version: 1,
      createdAt: new Date(),
    };
  }

  it('ADMIN has all permissions', () => {
    const admin = makeRecord('ADMIN');
    expect(hasPermission(admin, 'VIEWER')).toBe(true);
    expect(hasPermission(admin, 'CAMPAIGN_MANAGER')).toBe(true);
    expect(hasPermission(admin, 'OPERATOR')).toBe(true);
    expect(hasPermission(admin, 'ADMIN')).toBe(true);
  });

  it('OPERATOR cannot access ADMIN-only resources', () => {
    const op = makeRecord('OPERATOR');
    expect(hasPermission(op, 'VIEWER')).toBe(true);
    expect(hasPermission(op, 'OPERATOR')).toBe(true);
    expect(hasPermission(op, 'ADMIN')).toBe(false);
  });

  it('CAMPAIGN_MANAGER can only manage campaigns', () => {
    const cm = makeRecord('CAMPAIGN_MANAGER');
    expect(hasPermission(cm, 'VIEWER')).toBe(true);
    expect(hasPermission(cm, 'CAMPAIGN_MANAGER')).toBe(true);
    expect(hasPermission(cm, 'OPERATOR')).toBe(false);
  });

  it('VIEWER is read-only', () => {
    const viewer = makeRecord('VIEWER');
    expect(hasPermission(viewer, 'VIEWER')).toBe(true);
    expect(hasPermission(viewer, 'CAMPAIGN_MANAGER')).toBe(false);
  });
});

describe('S15 canAccessCampaign', () => {
  function makeRecord(permission: string, campaignIds: string[] = []): ApiKeyRecord {
    return {
      id: 'k1',
      key: 'hashed-key',
      name: 'test',
      permission: permission as any,
      userId: null,
      teamId: null,
      campaignIds,
      active: true,
      expiresAt: null,
      lastUsedAt: null,
      version: 1,
      createdAt: new Date(),
    };
  }

  it('ADMIN can access any campaign', () => {
    expect(canAccessCampaign(makeRecord('ADMIN'), 'c1')).toBe(true);
  });

  it('OPERATOR can access any campaign', () => {
    expect(canAccessCampaign(makeRecord('OPERATOR'), 'c1')).toBe(true);
  });

  it('CAMPAIGN_MANAGER can only access assigned campaigns', () => {
    const key = makeRecord('CAMPAIGN_MANAGER', ['c1', 'c2']);
    expect(canAccessCampaign(key, 'c1')).toBe(true);
    expect(canAccessCampaign(key, 'c3')).toBe(false);
  });

  it('VIEWER can only access assigned campaigns', () => {
    const key = makeRecord('VIEWER', ['c1']);
    expect(canAccessCampaign(key, 'c1')).toBe(true);
    expect(canAccessCampaign(key, 'c2')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// RBAC
// ────────────────────────────────────────────────────────────────────────────

import {
  canPerform,
  canAccessCampaign as canAccessCampaignRBAC,
  canAccessLead,
  hasPermissionLevel,
  visibleCampaignIds,
  contextFromApiKey,
} from '../../src/core/security/rbac.js';

describe('S15 RBAC', () => {
  const adminCtx = contextFromApiKey({ permission: 'ADMIN', campaignIds: [] });
  const operatorCtx = contextFromApiKey({ permission: 'OPERATOR', teamId: 't1', campaignIds: [] });
  const cmCtx = contextFromApiKey({ permission: 'CAMPAIGN_MANAGER', campaignIds: ['c1', 'c2'] });
  const viewerCtx = contextFromApiKey({ permission: 'VIEWER', campaignIds: ['c1'] });

  describe('canPerform', () => {
    it('ADMIN can do anything', () => {
      expect(canPerform(adminCtx, 'api_key', 'admin')).toBe(true);
      expect(canPerform(adminCtx, 'audit_log', 'read')).toBe(true);
    });

    it('OPERATOR cannot manage API keys', () => {
      expect(canPerform(operatorCtx, 'api_key', 'create')).toBe(false);
      expect(canPerform(operatorCtx, 'api_key', 'admin')).toBe(false);
    });

    it('OPERATOR can manage campaigns', () => {
      expect(canPerform(operatorCtx, 'campaign', 'create')).toBe(true);
      expect(canPerform(operatorCtx, 'lead', 'read')).toBe(true);
    });

    it('CAMPAIGN_MANAGER cannot delete campaigns', () => {
      expect(canPerform(cmCtx, 'campaign', 'delete')).toBe(false);
    });

    it('VIEWER can only read', () => {
      expect(canPerform(viewerCtx, 'campaign', 'read')).toBe(true);
      expect(canPerform(viewerCtx, 'campaign', 'create')).toBe(false);
      expect(canPerform(viewerCtx, 'campaign', 'update')).toBe(false);
    });
  });

  describe('canAccessCampaign (RBAC)', () => {
    it('ADMIN accesses anything', () => {
      expect(canAccessCampaignRBAC(adminCtx, 'any-campaign')).toBe(true);
    });

    it('OPERATOR without restriction has team-wide access', () => {
      expect(canAccessCampaignRBAC(operatorCtx, 'any-campaign')).toBe(true);
    });

    it('CAMPAIGN_MANAGER only accesses assigned', () => {
      expect(canAccessCampaignRBAC(cmCtx, 'c1')).toBe(true);
      expect(canAccessCampaignRBAC(cmCtx, 'c3')).toBe(false);
    });
  });

  describe('visibleCampaignIds', () => {
    it('returns null for ADMIN (all campaigns)', () => {
      expect(visibleCampaignIds(adminCtx)).toBeNull();
    });

    it('returns null for unrestricted OPERATOR (all campaigns)', () => {
      expect(visibleCampaignIds(operatorCtx)).toBeNull();
    });

    it('returns campaign IDs for restricted roles', () => {
      expect(visibleCampaignIds(cmCtx)).toEqual(['c1', 'c2']);
    });
  });

  describe('hasPermissionLevel', () => {
    it('returns true when sufficient level', () => {
      expect(hasPermissionLevel(adminCtx, 'OPERATOR')).toBe(true);
      expect(hasPermissionLevel(operatorCtx, 'CAMPAIGN_MANAGER')).toBe(true);
    });

    it('returns false when insufficient', () => {
      expect(hasPermissionLevel(viewerCtx, 'OPERATOR')).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Audit Trail
// ────────────────────────────────────────────────────────────────────────────

import {
  recordAudit,
  queryAuditLogs,
  severityForAction,
  CRITICAL_ACTIONS,
  COMPLIANCE_ACTIONS,
  type AuditStore,
} from '../../src/core/security/auditTrail.js';

describe('S15 Audit Trail', () => {
  function makeAuditStore(): AuditStore & { _logs: any[] } {
    const logs: any[] = [];
    let nextId = 1;
    return {
      _logs: logs,
      auditLog: {
        create: vi.fn(async (args: any) => {
          const entry = { id: `audit-${nextId++}`, ...args.data, createdAt: new Date() };
          logs.push(entry);
          return entry;
        }),
        findMany: vi.fn(async (args: any) => {
          let filtered = [...logs];
          if (args?.where?.action) {
            const action = args.where.action;
            filtered = filtered.filter((l: any) =>
              Array.isArray(action) ? (action as any).in.includes(l.action) : l.action === action,
            );
          }
          if (args?.where?.severity) {
            const severity = args.where.severity;
            filtered = filtered.filter((l: any) =>
              Array.isArray(severity) ? (severity as any).in.includes(l.severity) : l.severity === severity,
            );
          }
          return filtered;
        }),
        count: vi.fn(async () => logs.length),
      },
    };
  }

  it('records an audit entry', async () => {
    const store = makeAuditStore();
    await recordAudit(store, {
      action: 'API_KEY_CREATED',
      ip: '127.0.0.1',
      severity: 'INFO',
    });

    expect(store._logs).toHaveLength(1);
    expect(store._logs[0].action).toBe('API_KEY_CREATED');
    expect(store._logs[0].ip).toBe('127.0.0.1');
  });

  it('queries audit logs with filters', async () => {
    const store = makeAuditStore();
    await recordAudit(store, { action: 'API_KEY_CREATED', severity: 'INFO' });
    await recordAudit(store, { action: 'SECURITY_ALERT', severity: 'CRITICAL' });
    await recordAudit(store, { action: 'DATA_ANONYMIZED', severity: 'INFO' });

    const { entries, total } = await queryAuditLogs(store, {
      severity: 'CRITICAL',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('SECURITY_ALERT');
  });

  describe('severityForAction', () => {
    it('CRITICAL for revoke and security alerts', () => {
      expect(severityForAction('API_KEY_REVOKED')).toBe('CRITICAL');
      expect(severityForAction('SECURITY_ALERT')).toBe('CRITICAL');
    });

    it('WARNING for login failures and rate limit hits', () => {
      expect(severityForAction('LOGIN_FAILED')).toBe('WARNING');
      expect(severityForAction('RATE_LIMIT_HIT')).toBe('WARNING');
    });

    it('INFO for everything else', () => {
      expect(severityForAction('API_KEY_CREATED')).toBe('INFO');
    });
  });

  it('defines compliance actions correctly', () => {
    expect(COMPLIANCE_ACTIONS).toContain('DATA_ANONYMIZED');
    expect(COMPLIANCE_ACTIONS).toContain('DATA_DELETED');
    expect(COMPLIANCE_ACTIONS).toContain('LEAD_UNSUBSCRIBED');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Global Suppression List
// ────────────────────────────────────────────────────────────────────────────

import {
  isSuppressed,
  addToSuppressionList,
  shouldBlockLead,
  unsubscribeLead,
  type SuppressionStore,
} from '../../src/core/security/suppression.js';

describe('S15 Suppression List', () => {
  function makeSuppressionStore(): SuppressionStore & { _suppressions: Map<string, any> } {
    const suppressions = new Map<string, any>();
    const leads = new Map<string, any>();

    // Add a test lead
    leads.set('lead-1', {
      id: 'lead-1',
      email: 'test@example.com',
      linkedinUrl: 'https://linkedin.com/in/testlead',
      firstName: 'Test',
      lastName: 'Lead',
      companyId: 'comp-1',
      company: { domain: 'example.com' },
    });

    return {
      _suppressions: suppressions,
      globalSuppressionList: {
        create: vi.fn(async (args: any) => {
          const key = `${args.data.suppressionType}:${args.data.value}`;
          if (suppressions.has(key)) throw new Error('Unique constraint');
          suppressions.set(key, args.data);
          return { id: `sup-${suppressions.size}`, ...args.data };
        }),
        findUnique: vi.fn(async (args: any) => {
          const key = `${args.where.suppressionType_value.suppressionType}:${args.where.suppressionType_value.value}`;
          return suppressions.get(key) ?? null;
        }),
        findMany: vi.fn(async () => Array.from(suppressions.values())),
        delete: vi.fn(async (args: any) => {
          for (const [key, val] of suppressions) {
            if (val.id === args.where.id) { suppressions.delete(key); return { id: args.where.id }; }
          }
          throw new Error('Not found');
        }),
        count: vi.fn(async () => suppressions.size),
      },
      lead: {
        update: vi.fn(async (args: any) => {
          const lead = leads.get(args.where.id);
          if (lead) Object.assign(lead, args.data);
          return { id: args.where.id, ...args.data };
        }),
        findUnique: vi.fn(async (args: any) => leads.get(args.where.id as string) ?? null),
      },
      leadSequenceState: {
        updateMany: vi.fn(async () => ({ count: 2 })),
        findMany: vi.fn(async () => [{ id: 'ls-1', sequenceId: 'seq-1' }]),
      },
      outreachMessage: {
        updateMany: vi.fn(async () => ({ count: 3 })),
      },
      outreachSequence: {
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: 'audit-1' })),
      },
    };
  }

  describe('isSuppressed', () => {
    it('returns false when list is empty', async () => {
      const store = makeSuppressionStore();
      const result = await isSuppressed(store, 'test@example.com', 'example.com', null);
      expect(result).toBe(false);
    });

    it('returns true for suppressed email', async () => {
      const store = makeSuppressionStore();
      await addToSuppressionList(store, {
        suppressionType: 'EMAIL' as any,
        value: 'test@example.com',
      });

      const result = await isSuppressed(store, 'test@example.com');
      expect(result).toBe(true);
    });

    it('returns true for suppressed domain', async () => {
      const store = makeSuppressionStore();
      await addToSuppressionList(store, {
        suppressionType: 'DOMAIN' as any,
        value: 'example.com',
      });

      const result = await isSuppressed(store, 'someone@example.com');
      expect(result).toBe(true);
    });

    it('case-insensitive for emails and domains', async () => {
      const store = makeSuppressionStore();
      await addToSuppressionList(store, {
        suppressionType: 'EMAIL' as any,
        value: 'Test@Example.Com',
      });

      const result = await isSuppressed(store, 'test@example.com');
      expect(result).toBe(true);
    });
  });

  describe('shouldBlockLead', () => {
    it('returns not blocked for clean lead', async () => {
      const store = makeSuppressionStore();
      const result = await shouldBlockLead(store, {
        id: 'lead-1',
        email: 'clean@test.com',
      });
      expect(result.blocked).toBe(false);
    });

    it('returns blocked for suppressed lead', async () => {
      const store = makeSuppressionStore();
      await addToSuppressionList(store, {
        suppressionType: 'EMAIL' as any,
        value: 'blocked@test.com',
      });

      const result = await shouldBlockLead(store, {
        id: 'lead-1',
        email: 'blocked@test.com',
      });
      expect(result.blocked).toBe(true);
    });
  });

  describe('unsubscribeLead', () => {
    it('cascades cancellation across all channels', async () => {
      const store = makeSuppressionStore();
      const result = await unsubscribeLead(store, 'lead-1');

      expect(result.suppressionAdded).toBe(true);
      expect(result.emailSuppressed).toBe(true);
      expect(result.domainSuppressed).toBe(true);
      expect(result.sequencesCancelled).toBe(2);
      expect(result.messagesCancelled).toBe(3);
    });

    it('throws for non-existent lead', async () => {
      const store = makeSuppressionStore();
      await expect(unsubscribeLead(store, 'no-such-lead')).rejects.toThrow('Lead not found');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Data Retention & Anonymization
// ────────────────────────────────────────────────────────────────────────────

import {
  anonymizeLead,
  getRetentionPolicy,
  updateRetentionPolicy,
  listRetentionPolicies,
  ENTITY_TYPE_LABELS_PT_BR,
  type RetentionStore,
} from '../../src/core/security/retention.js';

describe('S15 Data Retention & Anonymization', () => {
  function makeRetentionStore(): RetentionStore & { _leads: Map<string, any>; _policies: Map<string, any> } {
    const leads = new Map<string, any>();
    const policies = new Map<string, any>();

    leads.set('lead-1', {
      id: 'lead-1',
      firstName: 'John',
      lastName: 'Doe',
      fullName: 'John Doe',
      email: 'john@example.com',
      phone: '+5511999999999',
      linkedinUrl: 'https://linkedin.com/in/johndoe',
      title: 'CTO',
      location: 'São Paulo',
      metadata: {},
      anonymizedAt: null,
    });

    return {
      _leads: leads,
      _policies: policies,
      lead: {
        findUnique: vi.fn(async (args: any) => leads.get(args.where.id) ?? null),
        findMany: vi.fn(async () => Array.from(leads.values())),
        update: vi.fn(async (args: any) => {
          const lead = leads.get(args.where.id);
          if (!lead) throw new Error('Not found');
          Object.assign(lead, args.data);
          return lead;
        }),
        count: vi.fn(async () => leads.size),
      },
      dataRetentionPolicy: {
        findMany: vi.fn(async () => Array.from(policies.values())),
        findUnique: vi.fn(async (args: any) => policies.get(args.where.entityType) ?? null),
        upsert: vi.fn(async (args: any) => {
          const existing = policies.get(args.where.entityType);
          const merged = { ...existing, ...args.create, ...args.update };
          policies.set(args.where.entityType, merged);
          return merged;
        }),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: 'audit-1' })),
      },
    };
  }

  describe('anonymizeLead', () => {
    it('replaces PII with irreversible hashes', async () => {
      const store = makeRetentionStore();
      const result = await anonymizeLead(store, 'lead-1');

      expect(result.fieldsAnonymized).toContain('firstName');
      expect(result.fieldsAnonymized).toContain('email');

      const lead = store._leads.get('lead-1');
      expect(lead.firstName).toMatch(/^anon_[a-f0-9]{24}$/);
      expect(lead.email).toMatch(/^anon_[a-f0-9]{24}$/);
      expect(lead.fullName).toMatch(/^anon_/);
      expect(lead.anonymizedAt).toBeInstanceOf(Date);
    });

    it('throws if already anonymized', async () => {
      const store = makeRetentionStore();
      await anonymizeLead(store, 'lead-1');
      await expect(anonymizeLead(store, 'lead-1')).rejects.toThrow('already anonymized');
    });

    it('throws for non-existent lead', async () => {
      const store = makeRetentionStore();
      await expect(anonymizeLead(store, 'no-lead')).rejects.toThrow('Lead not found');
    });

    it('generates deterministic hashes', async () => {
      const store1 = makeRetentionStore();
      await anonymizeLead(store1, 'lead-1');
      const hash1 = store1._leads.get('lead-1').email;

      const store2 = makeRetentionStore();
      await anonymizeLead(store2, 'lead-1');
      const hash2 = store2._leads.get('lead-1').email;

      expect(hash1).toBe(hash2); // Same input → same hash
    });
  });

  describe('getRetentionPolicy', () => {
    it('returns default policy for LEAD', async () => {
      const store = makeRetentionStore();
      const policy = await getRetentionPolicy(store, 'LEAD');
      expect(policy.entityType).toBe('LEAD');
      expect(policy.retentionDays).toBe(730);
    });

    it('creates policy if not exists', async () => {
      const store = makeRetentionStore();
      const policy = await getRetentionPolicy(store, 'EMAIL_TRACKING');
      expect(policy.retentionDays).toBe(90);
    });
  });

  describe('updateRetentionPolicy', () => {
    it('updates and records audit', async () => {
      const store = makeRetentionStore();
      const policy = await updateRetentionPolicy(store, 'LEAD', {
        retentionDays: 365,
        autoAnonymize: true,
      });

      expect(policy.retentionDays).toBe(365);
      expect(policy.autoAnonymize).toBe(true);
      expect(store.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('ENTITY_TYPE_LABELS_PT_BR', () => {
    it('has pt-BR labels', () => {
      expect(ENTITY_TYPE_LABELS_PT_BR['LEAD']).toBe('Lead');
      expect(ENTITY_TYPE_LABELS_PT_BR['EMAIL_TRACKING']).toBe('Rastreamento de E-mail');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Secrets Masking
// ────────────────────────────────────────────────────────────────────────────

import {
  isSecretKey,
  maskValue,
  sanitizeObject,
  sanitizeText,
  sanitizeWebhookPayload,
  safeStringify,
} from '../../src/core/security/secretsMasking.js';

describe('S15 Secrets Masking', () => {
  describe('isSecretKey', () => {
    it('detects secret keys', () => {
      expect(isSecretKey('api_key')).toBe(true);
      expect(isSecretKey('apiKey')).toBe(true);
      expect(isSecretKey('password')).toBe(true);
      expect(isSecretKey('secret')).toBe(true);
      expect(isSecretKey('token')).toBe(true);
      expect(isSecretKey('authorization')).toBe(true);
      expect(isSecretKey('private_key')).toBe(true);
      expect(isSecretKey('session_key')).toBe(true);
      expect(isSecretKey('cookie')).toBe(true);
      expect(isSecretKey('jwt')).toBe(true);
    });

    it('does not flag safe keys', () => {
      expect(isSecretKey('name')).toBe(false);
      expect(isSecretKey('email')).toBe(false);
      expect(isSecretKey('title')).toBe(false);
      expect(isSecretKey('campaign_id')).toBe(false);
    });
  });

  describe('maskValue', () => {
    it('redacts known secret keys', () => {
      expect(maskValue('api_key', 'sk_secret_value_here')).toBe('[REDACTED]');
      expect(maskValue('password', 'supersecret')).toBe('[REDACTED]');
    });

    it('masks API key patterns', () => {
      expect(maskValue('header', 'sk_abcdefghij1234567890')).toBe('sk_a...7890');
      expect(maskValue('header', 'lb_someapikey1234567890abcdef')).toBe('lb_s...cdef');
      expect(maskValue('header', 'whsec_mXke3YhKJ8Xz3B2PnL')).toBe('whse...2PnL');
    });

    it('masks bearer tokens', () => {
      expect(maskValue('header', 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toContain('[REDACTED]');
    });
  });

  describe('sanitizeObject', () => {
    it('redacts known secret key values (direct)', () => {
      const input = { password: 'secret', name: 'safe' };
      sanitizeObject(input);
      expect(input.password).toBe('[REDACTED]');
      expect(input.name).toBe('safe');
    });

    it('redacts api_key values (direct)', () => {
      const input = { api_key: 'sk_my_secret_key_123' };
      sanitizeObject(input);
      expect(input.api_key).toBe('[REDACTED]');
    });

    it('handles nested objects with non-sensitive parent key', () => {
      const input = {
        name: 'safe',
        settings: {
          secret: 'topsecret',
          token: 'bearer-token',
        },
      };

      sanitizeObject(input);

      // Secret keys at any depth should be redacted
      expect(input.settings.secret).toBe('[REDACTED]');
      expect(input.settings.token).toBe('[REDACTED]');
      expect(input.name).toBe('safe');
    });
  });

  describe('sanitizeText', () => {
    it('masks api keys in text', () => {
      const text = 'Error using key sk_abcdefghij1234567890';
      const result = sanitizeText(text);
      expect(result).not.toContain('sk_abcdefghij1234567890');
      expect(result).toContain('sk_a');
    });

    it('masks bearer tokens', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def';
      const result = sanitizeText(text);
      expect(result).toContain('Bearer [REDACTED]');
    });
  });

  describe('sanitizeWebhookPayload', () => {
    it('redacts auth headers from Resend payloads', () => {
      const payload = {
        type: 'email.sent',
        data: {
          email: {
            from: 'sender@test.com',
            to: 'recipient@test.com',
            headers: { 'Authorization': 'Bearer secret' },
          },
        },
      };

      const result = sanitizeWebhookPayload(payload, 'resend') as any;
      expect(result.data.email.headers).toBe('[REDACTED]');
    });

    it('strips api_key from smartlead payloads', () => {
      const payload = {
        event: 'reply',
        api_key: 'sk_secret',
        payload: { api_key: 'sk_also_secret', data: 'safe' },
      };

      const result = sanitizeWebhookPayload(payload, 'smartlead') as any;
      expect(result.api_key).toBeUndefined();
      expect(result.payload.api_key).toBeUndefined();
      expect(result.payload.data).toBe('safe');
    });
  });

  describe('safeStringify', () => {
    it('produces JSON without secrets', () => {
      const obj = { user: 'test', api_key: 'sk_secret' };
      const result = safeStringify(obj);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('sk_secret');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Campaign Isolation (Integration-style)
// ────────────────────────────────────────────────────────────────────────────

describe('S15 Campaign Isolation', () => {
  it('CAMPAIGN_MANAGER with campaign-1 cannot access campaign-2', () => {
    const ctx = contextFromApiKey({
      permission: 'CAMPAIGN_MANAGER',
      campaignIds: ['campaign-1'],
    });

    expect(canAccessCampaignRBAC(ctx, 'campaign-1')).toBe(true);
    expect(canAccessCampaignRBAC(ctx, 'campaign-2')).toBe(false);

    // Same for leads in those campaigns
    expect(canAccessLead(ctx, 'campaign-1')).toBe(true);
    expect(canAccessLead(ctx, 'campaign-2')).toBe(false);
  });

  it('VIEWER with no campaigns cannot access anything', () => {
    const ctx = contextFromApiKey({
      permission: 'VIEWER',
      campaignIds: [],
    });

    expect(canAccessCampaignRBAC(ctx, 'any-campaign')).toBe(false);
  });  it('ADMIN bypasses all isolation', () => {
    const ctx = contextFromApiKey({ permission: 'ADMIN', campaignIds: [] });
    expect(canAccessCampaignRBAC(ctx, 'any-campaign')).toBe(true);
    expect(canAccessLead(ctx, 'any-campaign')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher Integration — Suppression Check
// ────────────────────────────────────────────────────────────────────────────

import {
  isSuppressed,
  addToSuppressionList,
  shouldBlockLead,
  type SuppressionStore,
} from '../../src/core/security/suppression.js';

describe('S15 Dispatcher Suppression Check', () => {
  function makeStore(): SuppressionStore & { _suppressions: Map<string, any> } {
    const suppressions = new Map<string, any>();
    return {
      _suppressions: suppressions,
      globalSuppressionList: {
        create: vi.fn(async (args: any) => {
          const key = `${args.data.suppressionType}:${args.data.value}`;
          if (suppressions.has(key)) throw new Error('Unique constraint');
          suppressions.set(key, args.data);
          return { id: `sup-${suppressions.size}`, ...args.data };
        }),
        findUnique: vi.fn(async (args: any) => {
          const key = `${args.where.suppressionType_value.suppressionType}:${args.where.suppressionType_value.value}`;
          return suppressions.get(key) ?? null;
        }),
        findMany: vi.fn(async () => Array.from(suppressions.values())),
        delete: vi.fn(async (args: any) => {
          for (const [key, val] of suppressions) {
            if (val.id === args.where.id) { suppressions.delete(key); return { id: args.where.id }; }
          }
          throw new Error('Not found');
        }),
        count: vi.fn(async () => suppressions.size),
      },
      lead: {
        update: vi.fn(async () => ({ id: 'lead-1' })),
        findUnique: vi.fn(async () => null),
      },
      leadSequenceState: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      outreachMessage: {
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      outreachSequence: {
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: 'audit-1' })),
      },
    };
  }

  it('returns not blocked for clean lead (dispatcher path)', async () => {
    const store = makeStore();
    const result = await shouldBlockLead(store, {
      id: 'lead-d1',
      email: 'clean@foleon.com',
      linkedinUrl: 'https://linkedin.com/in/cleanlead',
      company: { domain: 'foleon.com' },
    });
    expect(result.blocked).toBe(false);
  });

  it('blocks lead suppressed by email', async () => {
    const store = makeStore();
    await addToSuppressionList(store, {
      suppressionType: 'EMAIL' as any,
      value: 'blocked@example.com',
    });

    const result = await shouldBlockLead(store, {
      id: 'lead-d2',
      email: 'blocked@example.com',
      linkedinUrl: null,
      company: { domain: null },
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('suppression');
  });

  it('blocks lead suppressed by domain', async () => {
    const store = makeStore();
    await addToSuppressionList(store, {
      suppressionType: 'DOMAIN' as any,
      value: 'evilcorp.com',
    });

    // Email domain matches suppression
    const result = await shouldBlockLead(store, {
      id: 'lead-d3',
      email: 'john@evilcorp.com',
      linkedinUrl: null,
      company: { domain: null },
    });
    expect(result.blocked).toBe(true);
  });

  it('blocks lead suppressed by LinkedIn URL', async () => {
    const store = makeStore();
    await addToSuppressionList(store, {
      suppressionType: 'LINKEDIN_URL' as any,
      value: 'https://linkedin.com/in/blockedperson',
    });

    const result = await shouldBlockLead(store, {
      id: 'lead-d4',
      email: null,
      linkedinUrl: 'https://linkedin.com/in/blockedperson',
      company: { domain: null },
    });
    expect(result.blocked).toBe(true);
  });

  it('blocks lead suppressed by company domain (via company object)', async () => {
    const store = makeStore();
    await addToSuppressionList(store, {
      suppressionType: 'DOMAIN' as any,
      value: 'spamcorp.com',
    });

    const result = await shouldBlockLead(store, {
      id: 'lead-d5',
      email: null,
      linkedinUrl: null,
      company: { domain: 'spamcorp.com' },
    });
    expect(result.blocked).toBe(true);
  });
});
