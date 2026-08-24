/**
 * S15: Global Suppression List & Opt-Out Cascade
 *
 * When a lead unsubscribes, the system:
 * 1. Marks the lead as UNSUBSCRIBED
 * 2. Adds their email, domain, and LinkedIn URL to the global suppression list
 * 3. Cascades cancellation: stops all active sequences, cancels all queued/scheduled
 *    messages for that lead across ALL channels (Email, LinkedIn, WhatsApp)
 * 4. Logs audit trail entries for each cancelled resource
 *
 * Canonical data in English (backend); user-facing copy in pt-BR.
 */

import type { PrismaClient } from '@prisma/client';

/** Suppression type. Mirrors the SuppressionType enum in Prisma schema. */
export type SuppressionType = 'EMAIL' | 'DOMAIN' | 'LINKEDIN_URL';

// ──────────────────────────────── Store Interface ────────────────────────────────

export interface SuppressionStore {
  globalSuppressionList: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string; suppressionType: string; value: string }>;
    findUnique(args: { where: { suppressionType_value: { suppressionType: string; value: string } } }): Promise<{ id: string } | null>;
    findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; skip?: number }): Promise<Array<{ id: string; suppressionType: string; value: string; reason?: string | null; addedBy?: string | null; isAutomatic: boolean; createdAt: Date }>>;
    delete(args: { where: { id: string } }): Promise<{ id: string }>;
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
  };
  lead: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ id: string }>;
    findUnique(args: { where: { id: string }; select?: Record<string, unknown> }): Promise<{
      id: string;
      email: string | null;
      linkedinUrl: string | null;
      firstName: string;
      lastName: string | null;
      companyId: string;
      company?: { domain: string | null } | null;
    } | null>;
  };
  leadSequenceState: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    findMany(args: { where: Record<string, unknown>; select?: Record<string, unknown> }): Promise<Array<{ id: string; sequenceId: string }>>;
  };
  outreachMessage: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  outreachSequence: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

// ──────────────────────────────── Core Operations ────────────────────────────────

/**
 * Check if a value is in the global suppression list.
 * Returns true if the value should be suppressed.
 */
export async function isSuppressed(
  store: SuppressionStore,
  email?: string | null,
  domain?: string | null,
  linkedinUrl?: string | null,
): Promise<boolean> {
  const checks: Array<{ suppressionType: SuppressionType; value: string }> = [];

  if (email?.trim()) {
    checks.push({ suppressionType: 'EMAIL' as SuppressionType, value: email.trim().toLowerCase() });
    // Also check domain from email
    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (emailDomain) {
      checks.push({ suppressionType: 'DOMAIN' as SuppressionType, value: emailDomain });
    }
  }
  if (domain?.trim()) {
    checks.push({ suppressionType: 'DOMAIN' as SuppressionType, value: domain.trim().toLowerCase() });
  }
  if (linkedinUrl?.trim()) {
    checks.push({ suppressionType: 'LINKEDIN_URL' as SuppressionType, value: linkedinUrl.trim().toLowerCase() });
  }

  for (const check of checks) {
    try {
      const found = await store.globalSuppressionList.findUnique({
        where: {
          suppressionType_value: {
            suppressionType: check.suppressionType,
            value: check.value,
          },
        },
      });
      if (found) return true;
    } catch {
      // DB unavailable — fail open (don't suppress)
    }
  }

  return false;
}

/**
 * Add an entry to the global suppression list.
 */
export async function addToSuppressionList(
  store: SuppressionStore,
  params: {
    suppressionType: SuppressionType;
    value: string;
    reason?: string;
    addedBy?: string;
    leadId?: string;
    campaignId?: string;
    isAutomatic?: boolean;
  },
): Promise<{ id: string; alreadyExisted: boolean }> {
  const normalizedValue = params.suppressionType === 'EMAIL' || params.suppressionType === 'DOMAIN'
    ? params.value.trim().toLowerCase()
    : params.value.trim().toLowerCase();

  try {
    const record = await store.globalSuppressionList.create({
      data: {
        suppressionType: params.suppressionType,
        value: normalizedValue,
        reason: params.reason ?? null,
        addedBy: params.addedBy ?? null,
        leadId: params.leadId ?? null,
        campaignId: params.campaignId ?? null,
        isAutomatic: params.isAutomatic ?? false,
      },
    });
    return { id: record.id, alreadyExisted: false };
  } catch {
    // Unique constraint — already exists
    return { id: 'existing', alreadyExisted: true };
  }
}

/**
 * Remove an entry from the global suppression list.
 */
export async function removeFromSuppressionList(
  store: SuppressionStore,
  suppressionId: string,
  actor?: string,
): Promise<boolean> {
  try {
    await store.globalSuppressionList.delete({ where: { id: suppressionId } });
    await store.auditLog.create({
      data: {
        action: 'SUPPRESSION_REMOVED',
        actorId: actor ?? null,
        targetType: 'global_suppression_list',
        targetId: suppressionId,
        details: { removedBy: actor ?? 'system' },
        severity: 'INFO',
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Query suppression list entries.
 */
export async function listSuppressionEntries(
  store: SuppressionStore,
  options?: { type?: SuppressionType; limit?: number; offset?: number },
): Promise<Array<{ id: string; suppressionType: string; value: string; reason?: string | null; addedBy?: string | null; isAutomatic: boolean; createdAt: Date }>> {
  const where: Record<string, unknown> = {};
  if (options?.type) where.suppressionType = options.type;

  return store.globalSuppressionList.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: options?.limit ?? 100,
    skip: options?.offset ?? 0,
  });
}

// ──────────────────────────────── Unsubscribe Cascade ────────────────────────────────

export interface UnsubscribeResult {
  leadId: string;
  sequencesCancelled: number;
  messagesCancelled: number;
  suppressionAdded: boolean;
  emailSuppressed: boolean;
  domainSuppressed: boolean;
  linkedinSuppressed: boolean;
}

/**
 * Unsubscribe a lead across ALL channels.
 *
 * This is the single entry point for opt-out. It:
 * 1. Adds email, domain, and LinkedIn URL to the global suppression list
 * 2. Marks the lead status as UNSUBSCRIBED
 * 3. Cancels all active LeadSequenceState records
 * 4. Cancels all QUEUED/SCHEDULED messages for the lead
 */
export async function unsubscribeLead(
  store: SuppressionStore,
  leadId: string,
  actor?: string,
): Promise<UnsubscribeResult> {
  // Fetch the lead data
  const lead = await store.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true as const,
      email: true as const,
      linkedinUrl: true as const,
      firstName: true as const,
      lastName: true as const,
      companyId: true as const,
      company: { select: { domain: true } },
    },
  });

  if (!lead) throw new Error(`Lead not found: ${leadId}`);

  const result: UnsubscribeResult = {
    leadId,
    sequencesCancelled: 0,
    messagesCancelled: 0,
    suppressionAdded: false,
    emailSuppressed: false,
    domainSuppressed: false,
    linkedinSuppressed: false,
  };

  // 1. Add email to suppression
  if (lead.email?.trim()) {
    const emailResult = await addToSuppressionList(store, {
      suppressionType: 'EMAIL' as SuppressionType,
      value: lead.email.trim(),
      reason: `Automatic opt-out: lead ${lead.firstName} ${lead.lastName ?? ''}`.trim(),
      leadId,
      isAutomatic: true,
    });
    result.emailSuppressed = !emailResult.alreadyExisted;
  }

  // 2. Add domain to suppression
  const domain = lead.email?.split('@')[1]?.toLowerCase() ?? lead.company?.domain?.toLowerCase();
  if (domain?.trim()) {
    const domainResult = await addToSuppressionList(store, {
      suppressionType: 'DOMAIN' as SuppressionType,
      value: domain.trim(),
      reason: `Automatic domain opt-out from lead ${leadId}`,
      leadId,
      isAutomatic: true,
    });
    result.domainSuppressed = !domainResult.alreadyExisted;
  }

  // 3. Add LinkedIn URL to suppression
  if (lead.linkedinUrl?.trim()) {
    const linkedinResult = await addToSuppressionList(store, {
      suppressionType: 'LINKEDIN_URL' as SuppressionType,
      value: lead.linkedinUrl.trim(),
      reason: `Automatic LinkedIn opt-out from lead ${leadId}`,
      leadId,
      isAutomatic: true,
    });
    result.linkedinSuppressed = !linkedinResult.alreadyExisted;
  }

  result.suppressionAdded = result.emailSuppressed || result.domainSuppressed || result.linkedinSuppressed;

  // 4. Mark lead as UNSUBSCRIBED
  await store.lead.update({
    where: { id: leadId },
    data: { status: 'UNSUBSCRIBED' },
  });

  // 5. Cancel all active lead sequence states
  const sequenceUpdate = await store.leadSequenceState.updateMany({
    where: { leadId, status: 'ACTIVE' },
    data: { status: 'CANCELLED' },
  });
  result.sequencesCancelled = sequenceUpdate.count;

  // 6. Cancel all QUEUED and SCHEDULED messages for this lead
  const messageUpdate = await store.outreachMessage.updateMany({
    where: {
      leadId,
      status: { in: ['QUEUED', 'SCHEDULED'] },
    },
    data: { status: 'FAILED', errorReason: 'Lead unsubscribed' },
  });
  result.messagesCancelled = messageUpdate.count;

  // 7. Audit trail
  await store.auditLog.create({
    data: {
      action: 'LEAD_UNSUBSCRIBED',
      actorId: actor ?? null,
      targetType: 'lead',
      targetId: leadId,
      details: {
        leadName: `${lead.firstName} ${lead.lastName ?? ''}`.trim(),
        sequencesCancelled: result.sequencesCancelled,
        messagesCancelled: result.messagesCancelled,
        emailSuppressed: result.emailSuppressed,
        domainSuppressed: result.domainSuppressed,
        linkedinSuppressed: result.linkedinSuppressed,
      },
      severity: 'INFO',
      createdAt: new Date(),
    },
  });

  return result;
}

/**
 * Check if a lead should be blocked before sending.
 * Called by the dispatcher BEFORE any outbound action.
 */
export async function shouldBlockLead(
  store: SuppressionStore,
  lead: { id: string; email?: string | null; linkedinUrl?: string | null; company?: { domain?: string | null } | null },
): Promise<{ blocked: boolean; reason?: string }> {
  const suppressed = await isSuppressed(
    store,
    lead.email,
    lead.company?.domain,
    lead.linkedinUrl,
  );

  if (suppressed) {
    return { blocked: true, reason: 'Lead in global suppression list' };
  }

  return { blocked: false };
}

/**
 * pt-BR labels for suppression types (user-facing copy).
 */
export const SUPPRESSION_TYPE_LABELS_PT_BR: Record<string, string> = {
  EMAIL: 'E-mail',
  DOMAIN: 'Domínio',
  LINKEDIN_URL: 'URL do LinkedIn',
};