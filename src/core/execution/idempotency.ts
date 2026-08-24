/**
 * S14: Idempotency Module — Event Deduplication & Safe Replay
 *
 * Guarantees each event (OPEN, CLICK, REPLY, BOUNCE, DELIVERED) for a given
 * message+lead is processed exactly once. Uses PostgreSQL UNIQUE constraint on
 * (messageId, interactionType) as the atomic guard, plus a lightweight
 * in-memory negative cache for fast early rejection.
 */

import { createHash } from 'node:crypto';

export type IdempotentEventType =
  | 'OPEN'
  | 'CLICK'
  | 'REPLY'
  | 'BOUNCE'
  | 'DELIVERED'
  | 'SEND';

/** Canonical idempotency key format: {prefix}:{hash} */
export interface IdempotencyKey {
  key: string;
  eventType: IdempotentEventType;
  messageId: string;
  leadId: string;
  createdAt: Date;
  /** Opaque payload hash to detect duplicate submissions of the same event with different data */
  payloadHash: string;
}

/** Idempotency key prefix for each event type */
const PREFIX = {
  OPEN: 'open',
  CLICK: 'click',
  REPLY: 'reply',
  BOUNCE: 'bounce',
  DELIVERED: 'delivered',
  SEND: 'send',
} as const satisfies Record<IdempotentEventType, string>;

/**
 * Build a deterministic idempotency key.
 *
 * Format: {prefix}:{sha256(messageId + leadId + eventType + payloadDigest)[:32]}
 *
 * The key is short enough for a DB index (< 128 chars) and cryptographically
 * unique per (message, lead, event type, payload).
 */
export function buildIdempotencyKey(
  messageId: string,
  leadId: string,
  eventType: IdempotentEventType,
  payloadDigest?: string,
): IdempotencyKey {
  const hashInput = [messageId, leadId, eventType, payloadDigest ?? ''].join(':');
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 32);
  const key = `${PREFIX[eventType]}:${hash}`;

  return {
    key,
    eventType,
    messageId,
    leadId,
    createdAt: new Date(),
    payloadHash: payloadDigest ?? '',
  };
}

/**
 * Build a payload hash for content-based deduplication.
 */
export function hashPayload(payload: unknown): string {
  const normalized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * In-memory negative cache (LRU-ish) for fast rejection of recently-seen keys.
 * Bounded to ~10K entries; evicts oldest on overflow.
 */
export class IdempotencyCache {
  private cache = new Map<string, number>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  /** Returns true if the key was already seen (cached hit). */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Mark a key as seen. */
  set(key: string): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (simple FIFO — good enough for negative cache)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, Date.now());
  }

  /** Remove a key (e.g., after a cache inconsistency detected). */
  delete(key: string): void {
    this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Check whether an idempotency key already exists in the database.
 *
 * Uses raw SQL for atomic UPSERT: INSERT … ON CONFLICT DO NOTHING.
 * Returns:
 * - { processed: true } if the event was already processed (key existed)
 * - { processed: false, key } if the event is new and the key was inserted
 */
export interface IdempotencyCheckResult {
  processed: boolean;
  key: string;
  /** Existing record id if already processed */
  existingId?: string;
}

export interface IdempotencyStore {
  idempotencyKey: {
    create(args: { data: { key: string; eventType: string; messageId: string; leadId: string; payloadHash: string } }): Promise<{ id: string; key: string }>;
  };
}

/**
 * Atomically insert an idempotency key. Returns whether this is the first insert.
 *
 * NOTE: Relies on a UNIQUE constraint on the `key` column in the `idempotency_keys` table.
 * If the insert fails with a unique violation, the event was already processed.
 */
export async function checkAndRecordIdempotency(
  store: IdempotencyStore,
  idemKey: IdempotencyKey,
): Promise<IdempotencyCheckResult> {
  try {
    const record = await store.idempotencyKey.create({
      data: {
        key: idemKey.key,
        eventType: idemKey.eventType,
        messageId: idemKey.messageId,
        leadId: idemKey.leadId,
        payloadHash: idemKey.payloadHash,
      },
    });
    return { processed: false, key: record.key };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Prisma unique constraint violation
    if (msg.includes('Unique constraint') || msg.includes('duplicate key') || msg.includes('duplicate')) {
      return { processed: true, key: idemKey.key };
    }
    // For other errors (e.g., DB down), assume not processed so the caller retries
    throw err;
  }
}

/**
 * Combined check: first check the in-memory cache, then fall back to the DB.
 * Returns true if the event was already processed.
 */
export async function isEventProcessed(
  cache: IdempotencyCache,
  store: IdempotencyStore,
  messageId: string,
  leadId: string,
  eventType: IdempotentEventType,
  payloadDigest?: string,
): Promise<boolean> {
  const idemKey = buildIdempotencyKey(messageId, leadId, eventType, payloadDigest);

  // Fast path: memory cache hit
  if (cache.has(idemKey.key)) {
    return true;
  }

  // Slow path: DB check
  const result = await checkAndRecordIdempotency(store, idemKey);

  if (result.processed) {
    // Cache the hit to avoid future DB lookups
    cache.set(idemKey.key);
    return true;
  }

  // First time — cache it for fast future rejections
  cache.set(idemKey.key);
  return false;
}

/**
 * Create a Prisma-compatible idempotency store for use by webhook handlers.
 * Accepts a { outreachMessage: { updateMany } } shape so the caller can
 * pair the idempotency check with a status transition.
 */
export function createIdempotencyStoreFromPrisma(
  prisma: { idempotencyKey?: { create: IdempotencyStore['idempotencyKey']['create'] } },
): IdempotencyStore {
  if (!prisma.idempotencyKey) {
    throw new Error('idempotencyKey model not available in Prisma client. Run `prisma generate`.');
  }
  return prisma as unknown as IdempotencyStore;
}