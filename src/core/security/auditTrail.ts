/**
 * S15: Audit Trail — Logging all administrative and operational actions.
 *
 * All audit entries include: action type, actor identity, target resource,
 * detailed context, IP, timestamp, and severity level.
 *
 * Canonical data in English; user-facing display may translate to pt-BR.
 */

/** Audit action types. Mirrors the AuditAction enum in Prisma schema. */
export type AuditAction =
  | 'API_KEY_CREATED'
  | 'API_KEY_ROTATED'
  | 'API_KEY_REVOKED'
  | 'API_KEY_USED'
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_REVOKED'
  | 'DATA_ANONYMIZED'
  | 'DATA_DELETED'
  | 'SUPPRESSION_ADDED'
  | 'SUPPRESSION_REMOVED'
  | 'LEAD_UNSUBSCRIBED'
  | 'SEQUENCE_CANCELLED'
  | 'CONFIG_CHANGED'
  | 'LOGIN_FAILED'
  | 'RATE_LIMIT_HIT'
  | 'SECURITY_ALERT';

// ──────────────────────────────── Types ────────────────────────────────

export interface AuditEntryInput {
  action: AuditAction;
  actorId?: string | null;
  apiKeyId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  severity?: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
}

export interface AuditEntryOutput {
  id: string;
  action: AuditAction;
  actorId: string | null;
  apiKeyId: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
  severity: string;
  createdAt: Date;
}

// ──────────────────────────────── Store Interface ────────────────────────────────

export interface AuditStore {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, string>;
      take?: number;
      skip?: number;
    }): Promise<AuditEntryOutput[]>;
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };
}

// ──────────────────────────────── Core Operations ────────────────────────────────

/** Record an audit event. */
export async function recordAudit(
  store: AuditStore,
  entry: AuditEntryInput,
): Promise<{ id: string }> {
  return store.auditLog.create({
    data: {
      action: entry.action,
      actorId: entry.actorId ?? null,
      apiKeyId: entry.apiKeyId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details ?? {},
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      correlationId: entry.correlationId ?? null,
      severity: entry.severity ?? 'INFO',
      createdAt: new Date(),
    },
  });
}

/** Query audit logs with optional filters. */
export async function queryAuditLogs(
  store: AuditStore,
  options: {
    action?: AuditAction | AuditAction[];
    actorId?: string;
    apiKeyId?: string;
    targetType?: string;
    targetId?: string;
    severity?: string | string[];
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
  },
): Promise<{ entries: AuditEntryOutput[]; total: number }> {
  const where: Record<string, unknown> = {};

  if (options.action) {
    where.action = Array.isArray(options.action)
      ? { in: options.action }
      : options.action;
  }
  if (options.actorId) where.actorId = options.actorId;
  if (options.apiKeyId) where.apiKeyId = options.apiKeyId;
  if (options.targetType) where.targetType = options.targetType;
  if (options.targetId) where.targetId = options.targetId;
  if (options.severity) {
    where.severity = Array.isArray(options.severity)
      ? { in: options.severity }
      : options.severity;
  }
  if (options.since || options.until) {
    where.createdAt = {};
    if (options.since) (where.createdAt as Record<string, Date>).gte = options.since;
    if (options.until) (where.createdAt as Record<string, Date>).lte = options.until;
  }

  const [entries, total] = await Promise.all([
    store.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 50,
      skip: options.offset ?? 0,
    }),
    store.auditLog.count({ where }),
  ]);

  return { entries, total };
}

/** Actions that require CRITICAL severity (immediate attention needed). */
export const CRITICAL_ACTIONS: AuditAction[] = [
  'API_KEY_REVOKED',
  'SECURITY_ALERT',
];

/** Actions that should be preserved and never purged (compliance). */
export const COMPLIANCE_ACTIONS: AuditAction[] = [
  'DATA_ANONYMIZED',
  'DATA_DELETED',
  'LEAD_UNSUBSCRIBED',
  'API_KEY_CREATED',
  'API_KEY_ROTATED',
  'API_KEY_REVOKED',
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
];

/** Determine severity for common actions. */
export function severityForAction(action: AuditAction): 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' {
  if (CRITICAL_ACTIONS.includes(action as any)) return 'CRITICAL';
  if (action === 'LOGIN_FAILED' || action === 'RATE_LIMIT_HIT') return 'WARNING';
  return 'INFO';
}