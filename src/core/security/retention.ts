/**
 * S15: Data Retention & Anonymization — PII expiry, consent management, right-to-erasure
 *
 * Implements LGPD/GDPR-compliant data lifecycle:
 * - Automatic anonymization of leads after configurable retention period
 * - Manual anonymization via admin endpoint (right to erasure)
 * - Data retention policies per entity type
 * - Anonymization replaces PII with irreversible SHA-256 hashes
 *   while preserving aggregate metrics integrity
 *
 * Canonical data in English (backend); user-facing copy in pt-BR.
 */

import crypto from 'node:crypto';

// ──────────────────────────────── Types ────────────────────────────────

export interface RetentionPolicy {
  id: string;
  entityType: string;
  retentionDays: number;
  autoAnonymize: boolean;
  autoDelete: boolean;
  description: string | null;
}

export interface AnonymizationResult {
  leadId: string;
  fieldsAnonymized: string[];
  anonymizedAt: Date;
}

// ──────────────────────────────── Store Interface ────────────────────────────────

export interface RetentionStore {
  lead: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      firstName: string;
      lastName: string | null;
      fullName: string;
      email: string | null;
      phone: string | null;
      linkedinUrl: string | null;
      title: string;
      location: string | null;
      metadata: unknown;
      anonymizedAt: Date | null;
    } | null>;
    findMany(args: { where: Record<string, unknown>; select?: Record<string, unknown>; take?: number }): Promise<Array<{ id: string }>>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ id: string }>;
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };
  dataRetentionPolicy: {
    findMany(args?: { where?: Record<string, unknown> }): Promise<RetentionPolicy[]>;
    findUnique(args: { where: { entityType: string } }): Promise<RetentionPolicy | null>;
    upsert(args: { where: { entityType: string }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<RetentionPolicy>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

// ──────────────────────────────── Default Policies ────────────────────────────────

export const DEFAULT_RETENTION_POLICIES = {
  LEAD: { retentionDays: 730, autoAnonymize: false, autoDelete: false }, // 2 years
  EMAIL_TRACKING: { retentionDays: 90, autoAnonymize: true, autoDelete: false }, // 90 days
  WEBHOOK_PAYLOAD: { retentionDays: 30, autoAnonymize: false, autoDelete: true }, // 30 days
  AUDIT_LOG: { retentionDays: 365 * 3, autoAnonymize: false, autoDelete: false }, // 3 years
};

// ──────────────────────────────── Helpers ────────────────────────────────

/**
 * Irreversibly hash PII field for aggregate metric preservation.
 * SHA-256 with deterministic keying so same input always produces same hash.
 */
function anonymizeField(value: string): string {
  const salt = process.env.ANONYMIZATION_SALT || 'lookaberry-anonymization-v1';
  return 'anon_' + crypto
    .createHash('sha256')
    .update(salt + ':' + value.trim().toLowerCase())
    .digest('hex')
    .slice(0, 24);
}

/**
 * Anonymize a single lead. Replaces PII fields with irreversible hashes.
 */
export async function anonymizeLead(
  store: RetentionStore,
  leadId: string,
  actor?: string,
): Promise<AnonymizationResult> {
  const lead = await store.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error(`Lead not found: ${leadId}`);
  if (lead.anonymizedAt) throw new Error(`Lead ${leadId} is already anonymized`);

  const now = new Date();
  const fieldsAnonymized: string[] = [];

  // Anonymize PII fields
  const updateData: Record<string, unknown> = { anonymizedAt: now };

  if (lead.firstName) {
    updateData.firstName = anonymizeField(lead.firstName);
    fieldsAnonymized.push('firstName');
  }
  if (lead.lastName) {
    updateData.lastName = anonymizeField(lead.lastName);
    fieldsAnonymized.push('lastName');
  }
  if (lead.fullName) {
    updateData.fullName = anonymizeField(lead.fullName);
    fieldsAnonymized.push('fullName');
  }
  if (lead.email) {
    updateData.email = anonymizeField(lead.email);
    fieldsAnonymized.push('email');
  }
  if (lead.phone) {
    updateData.phone = anonymizeField(lead.phone);
    fieldsAnonymized.push('phone');
  }
  if (lead.linkedinUrl) {
    updateData.linkedinUrl = anonymizeField(lead.linkedinUrl);
    fieldsAnonymized.push('linkedinUrl');
  }
  if (lead.title) {
    updateData.title = anonymizeField(lead.title);
    fieldsAnonymized.push('title');
  }
  if (lead.location) {
    updateData.location = anonymizeField(lead.location);
    fieldsAnonymized.push('location');
  }

  // Clear metadata
  updateData.metadata = { anonymized: true, anonymizedAt: now.toISOString() };

  await store.lead.update({
    where: { id: leadId },
    data: updateData,
  });

  // Audit trail
  await store.auditLog.create({
    data: {
      action: 'DATA_ANONYMIZED',
      actorId: actor ?? null,
      targetType: 'lead',
      targetId: leadId,
      details: {
        fieldsAnonymized,
        priorStatus: 'active',
      },
      severity: 'INFO',
    },
  });

  return { leadId, fieldsAnonymized, anonymizedAt: now };
}

/**
 * Get or create retention policy for a given entity type.
 */
export async function getRetentionPolicy(
  store: RetentionStore,
  entityType: string,
): Promise<RetentionPolicy> {
  let policy = await store.dataRetentionPolicy.findUnique({
    where: { entityType },
  });

  if (!policy) {
    const defaults = (DEFAULT_RETENTION_POLICIES as Record<string, { retentionDays: number; autoAnonymize: boolean; autoDelete: boolean }>)[entityType];
    if (!defaults) {
      throw new Error(`No default retention policy for entity type: ${entityType}`);
    }
    policy = await store.dataRetentionPolicy.upsert({
      where: { entityType },
      create: {
        entityType,
        retentionDays: defaults.retentionDays,
        autoAnonymize: defaults.autoAnonymize,
        autoDelete: defaults.autoDelete,
        description: `Default ${entityType} retention policy`,
      },
      update: {},
    });
  }

  return policy;
}

/**
 * Run scheduled anonymization — finds leads past retention period and anonymizes them.
 * Returns count of anonymized leads.
 */
export async function scheduledAnonymization(
  store: RetentionStore,
): Promise<{ anonymized: number; errors: string[] }> {
  const result = { anonymized: 0, errors: [] as string[] };

  try {
    const policy = await getRetentionPolicy(store, 'LEAD');
    if (!policy.autoAnonymize) return result;

    const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);

    // Find leads created before cutoff that are not yet anonymized and not already unsubscribed/anonymized
    const outdatedLeads = await store.lead.findMany({
      where: {
        createdAt: { lte: cutoff },
        anonymizedAt: null,
        status: { notIn: ['UNSUBSCRIBED'] },
      },
      select: { id: true },
      take: 100, // Batch size
    });

    for (const lead of outdatedLeads) {
      try {
        await anonymizeLead(store, lead.id, 'system_retention_policy');
        result.anonymized++;
      } catch (err) {
        result.errors.push(`Failed to anonymize lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(`Scheduled anonymization error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Update a retention policy.
 */
export async function updateRetentionPolicy(
  store: RetentionStore,
  entityType: string,
  updates: { retentionDays?: number; autoAnonymize?: boolean; autoDelete?: boolean; description?: string },
  actor?: string,
): Promise<RetentionPolicy> {
  const updateData: Record<string, unknown> = {};
  if (updates.retentionDays !== undefined) updateData.retentionDays = updates.retentionDays;
  if (updates.autoAnonymize !== undefined) updateData.autoAnonymize = updates.autoAnonymize;
  if (updates.autoDelete !== undefined) updateData.autoDelete = updates.autoDelete;
  if (updates.description !== undefined) updateData.description = updates.description;

  const policy = await store.dataRetentionPolicy.upsert({
    where: { entityType },
    create: {
      entityType,
      retentionDays: updates.retentionDays ?? 730,
      autoAnonymize: updates.autoAnonymize ?? false,
      autoDelete: updates.autoDelete ?? false,
      description: updates.description ?? null,
    },
    update: updateData,
  });

  await store.auditLog.create({
    data: {
      action: 'CONFIG_CHANGED',
      actorId: actor ?? null,
      targetType: 'data_retention_policy',
      targetId: entityType,
      details: { updates },
      severity: 'INFO',
    },
  });

  return policy;
}

/**
 * List all retention policies.
 */
export async function listRetentionPolicies(
  store: RetentionStore,
): Promise<RetentionPolicy[]> {
  return store.dataRetentionPolicy.findMany();
}

/**
 * pt-BR labels for retention entity types (user-facing copy).
 */
export const ENTITY_TYPE_LABELS_PT_BR: Record<string, string> = {
  LEAD: 'Lead',
  EMAIL_TRACKING: 'Rastreamento de E-mail',
  WEBHOOK_PAYLOAD: 'Payloads de Webhook',
  AUDIT_LOG: 'Log de Auditoria',
};