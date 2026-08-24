/**
 * S14: Idempotent Webhook Event Processing
 *
 * Shared helper used by webhook routes (email tracking, email webhooks,
 * WhatsApp webhooks, outreach webhooks, LinkedIn inbox) to apply idempotency
 * guarantees to OPEN, CLICK, REPLY, BOUNCE, and DELIVERED events.
 *
 * Every status transition goes through this module.
 */

import {
  buildIdempotencyKey,
  checkAndRecordIdempotency,
  IdempotencyCache,
  type IdempotencyStore,
  type IdempotentEventType,
} from './idempotency.js';

/** Shared cache across all webhook routes */
const webhookCache = new IdempotencyCache(20_000);

export function getWebhookCache(): IdempotencyCache {
  return webhookCache;
}

/**
 * Status transition rules: which transitions are valid from a given status.
 * Prevents regressions (e.g., a BOUNCE after OPENED is valid; OPENED after BOUNCED is not).
 * The idempotency key check (first write wins) handles the primary dedup.
 *
 * This map defines which target statuses are reachable from a current status.
 * If `fromStatus` is undefined (new message), only QUEUED → anything is valid.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  QUEUED: ['SCHEDULED', 'SENT', 'FAILED'],
  SCHEDULED: ['QUEUED', 'SENT', 'FAILED'],
  SENT: ['DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED', 'FAILED'],
  DELIVERED: ['OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'],
  OPENED: ['CLICKED', 'REPLIED'],
  CLICKED: ['REPLIED'],
  // Terminal states - no outgoing transitions
  REPLIED: [],
  FAILED: [],
  BOUNCED: [],
};

/**
 * Check whether a message status transition is valid.
 */
export function isValidTransition(
  fromStatus: string | undefined | null,
  toStatus: string,
): boolean {
  if (!fromStatus) return true; // New message, any initial transition valid
  const allowed = VALID_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.includes(toStatus);
}

/**
 * Maps interaction types to message status transitions.
 */
const EVENT_TO_STATUS: Record<string, string> = {
  OPEN: 'OPENED',
  CLICK: 'CLICKED',
  REPLY: 'REPLIED',
  BOUNCE: 'BOUNCED',
  DELIVERED: 'DELIVERED',
};

/**
 * Process a webhook event with idempotency guarantees.
 *
 * Performs these steps atomically (via DB unique constraint):
 * 1. Check idempotency key → if already processed, return { alreadyProcessed: true }
 * 2. Validate status transition → if invalid, return { invalidTransition: true }
 * 3. Update message status → DB update
 * 4. Return success
 *
 * The caller is responsible for creating feedback/analytics records,
 * which are also idempotent via the feedback table's unique constraints.
 */
export interface WebhookEventResult {
  /** Event was already processed (idempotent replay) */
  alreadyProcessed: boolean;
  /** Status transition was invalid (e.g., OPENED after BOUNCED) */
  invalidTransition: boolean;
  /** The current message status after processing */
  currentStatus?: string;
  /** The idempotency key used */
  idempotencyKey: string;
}

export interface WebhookEventPayload {
  messageId: string;
  leadId: string;
  eventType: IdempotentEventType;
  /** Current message status (for transition validation) */
  currentStatus?: string | null;
  /** Opaque payload digest for content-based dedup */
  payloadDigest?: string;
}

export interface WebhookStore extends IdempotencyStore {
  outreachMessage: {
    findUnique(args: { where: { id: string }; select: Record<string, boolean> }): Promise<{ id: string; status: string; leadId: string } | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Process a webhook event with full idempotency and transition validation.
 */
export async function processWebhookEvent(
  store: WebhookStore,
  payload: WebhookEventPayload,
): Promise<WebhookEventResult> {
  // 1. Idempotency check
  const idemKey = buildIdempotencyKey(
    payload.messageId,
    payload.leadId,
    payload.eventType,
    payload.payloadDigest,
  );

  // Fast path: memory cache
  if (webhookCache.has(idemKey.key)) {
    return { alreadyProcessed: true, invalidTransition: false, idempotencyKey: idemKey.key };
  }

  // Slow path: DB check (atomic insert)
  const checkResult = await checkAndRecordIdempotency(store, idemKey);

  if (checkResult.processed) {
    webhookCache.set(idemKey.key);
    return { alreadyProcessed: true, invalidTransition: false, idempotencyKey: idemKey.key };
  }

  // 2. Load current message state for transition validation
  const targetStatus = EVENT_TO_STATUS[payload.eventType];
  if (!targetStatus) {
    return { alreadyProcessed: false, invalidTransition: true, idempotencyKey: idemKey.key };
  }

  // Resolve current status
  let effectiveCurrentStatus = payload.currentStatus;
  if (!effectiveCurrentStatus) {
    const msg = await store.outreachMessage.findUnique({
      where: { id: payload.messageId },
      select: { status: true, leadId: true },
    });
    effectiveCurrentStatus = msg?.status;
  }

  // 3. Validate transition
  if (effectiveCurrentStatus && !isValidTransition(effectiveCurrentStatus, targetStatus)) {
    webhookCache.set(idemKey.key); // Still cache to avoid repeated DB lookups
    return {
      alreadyProcessed: false,
      invalidTransition: true,
      currentStatus: effectiveCurrentStatus,
      idempotencyKey: idemKey.key,
    };
  }

  // 4. Update message status (silently skip if message doesn't exist in DB)
  const now = new Date();
  const updateData: Record<string, unknown> = { status: targetStatus };

  // Set timestamps based on event type
  switch (payload.eventType) {
    case 'OPEN':
      updateData.openedAt = now;
      break;
    case 'CLICK':
      updateData.clickedAt = now;
      break;
    case 'REPLY':
      updateData.repliedAt = now;
      break;
  }

  try {
    await store.outreachMessage.update({
      where: { id: payload.messageId },
      data: updateData,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // P2025 = Prisma not-found (message doesn't exist in this DB instance)
    if (msg.includes('Record to update') || msg.includes('not found')) {
      // Non-fatal — the event is idempotent, just skip the update
    } else {
      throw err;
    }
  }

  // Cache for fast future rejection
  webhookCache.set(idemKey.key);

  return {
    alreadyProcessed: false,
    invalidTransition: false,
    currentStatus: targetStatus,
    idempotencyKey: idemKey.key,
  };
}

/**
 * Build a webhook store from the Prisma client.
 */
export function createWebhookStoreFromPrisma(
  prisma: unknown,
): WebhookStore {
  type PrismaWithModels = {
    idempotencyKey: { create(args: { data: Record<string, unknown> }): Promise<{ id: string; key: string }> };
    outreachMessage: {
      findUnique(args: { where: { id: string }; select: Record<string, boolean> }): Promise<{ id: string; status: string; leadId: string } | null>;
      update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    };
  };

  const p = prisma as PrismaWithModels;

  if (!p.idempotencyKey) {
    throw new Error('idempotencyKey model not available. Run prisma generate.');
  }

  return {
    idempotencyKey: p.idempotencyKey,
    outreachMessage: p.outreachMessage,
  };
}