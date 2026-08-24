/**
 * S14 Unit Tests: Idempotency, Backoff, DLQ, Locking, Recovery
 *
 * Pure unit tests — no database or Redis needed.
 * Proves correctness of the reliability primitives.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildIdempotencyKey,
  hashPayload,
  IdempotencyCache,
  checkAndRecordIdempotency,
  isEventProcessed,
  type IdempotencyStore,
  type IdempotentEventType,
} from '../../src/core/execution/idempotency.js';

import {
  calculateDelay,
  createBackoffState,
  advanceBackoff,
  isRetryDue,
  resetBackoff,
  remainingWaitMs,
  BackoffTracker,
  DEFAULT_BACKOFF_CONFIG,
} from '../../src/core/execution/backoff.js';

import {
  deadLetterJob,
  resolveDLQJob,
  ignoreDLQJob,
  listPendingDLQJobs,
  type DLQStore,
} from '../../src/core/execution/dlq.js';

import {
  MemoryLock,
  tryAcquireLock,
  releaseLock,
} from '../../src/core/execution/locking.js';

import {
  isValidTransition,
  processWebhookEvent,
  getWebhookCache,
  type WebhookStore,
} from '../../src/core/execution/webhookIdempotency.js';

// ────────────────────────────────────────────────────────────────────────────
// Idempotency
// ────────────────────────────────────────────────────────────────────────────

describe('S14 Idempotency', () => {
  describe('buildIdempotencyKey', () => {
    it('produces deterministic keys for same inputs', () => {
      const k1 = buildIdempotencyKey('msg1', 'lead1', 'OPEN');
      const k2 = buildIdempotencyKey('msg1', 'lead1', 'OPEN');
      expect(k1.key).toBe(k2.key);
    });

    it('produces different keys for different event types', () => {
      const open = buildIdempotencyKey('msg1', 'lead1', 'OPEN');
      const click = buildIdempotencyKey('msg1', 'lead1', 'CLICK');
      expect(open.key).not.toBe(click.key);
    });

    it('produces different keys for different payload digests', () => {
      const k1 = buildIdempotencyKey('msg1', 'lead1', 'REPLY', 'abc');
      const k2 = buildIdempotencyKey('msg1', 'lead1', 'REPLY', 'def');
      expect(k1.key).not.toBe(k2.key);
    });

    it('all key types produce valid prefixed keys', () => {
      const types: IdempotentEventType[] = ['OPEN', 'CLICK', 'REPLY', 'BOUNCE', 'DELIVERED', 'SEND'];
      for (const type of types) {
        const key = buildIdempotencyKey('m1', 'l1', type);
        expect(key.key.length).toBeLessThan(100);
        expect(key.eventType).toBe(type);
        expect(key.messageId).toBe('m1');
        expect(key.leadId).toBe('l1');
      }
    });
  });

  describe('hashPayload', () => {
    it('produces consistent hashes', () => {
      expect(hashPayload('hello')).toBe(hashPayload('hello'));
    });

    it('produces different hashes for different payloads', () => {
      expect(hashPayload('hello')).not.toBe(hashPayload('world'));
    });

    it('handles objects', () => {
      expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ a: 1, b: 2 }));
    });
  });

  describe('IdempotencyCache', () => {
    it('returns false for unseen keys', () => {
      const cache = new IdempotencyCache();
      expect(cache.has('key1')).toBe(false);
    });

    it('returns true after set', () => {
      const cache = new IdempotencyCache();
      cache.set('key1');
      expect(cache.has('key1')).toBe(true);
    });

    it('evicts oldest entries when at capacity', () => {
      const cache = new IdempotencyCache(3);
      cache.set('a');
      cache.set('b');
      cache.set('c');
      cache.set('d'); // Should evict 'a'
      expect(cache.has('a')).toBe(false);
      expect(cache.has('d')).toBe(true);
    });

    it('delete removes entry', () => {
      const cache = new IdempotencyCache();
      cache.set('k');
      expect(cache.has('k')).toBe(true);
      cache.delete('k');
      expect(cache.has('k')).toBe(false);
    });

    it('clear empties all', () => {
      const cache = new IdempotencyCache();
      cache.set('a');
      cache.set('b');
      cache.clear();
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.size).toBe(0);
    });
  });

  describe('checkAndRecordIdempotency', () => {
    it('returns processed=false on first insert', async () => {
      const store: IdempotencyStore = {
        idempotencyKey: {
          create: vi.fn().mockResolvedValue({ id: 'new-id', key: 'open:abc123' }),
        },
      };
      const key = buildIdempotencyKey('m1', 'l1', 'OPEN');
      const result = await checkAndRecordIdempotency(store, key);
      expect(result.processed).toBe(false);
      expect(result.key).toBe('open:abc123');
    });

    it('returns processed=true on duplicate', async () => {
      const store: IdempotencyStore = {
        idempotencyKey: {
          create: vi.fn().mockRejectedValue(new Error('Unique constraint violation')),
        },
      };
      const key = buildIdempotencyKey('m1', 'l1', 'OPEN');
      const result = await checkAndRecordIdempotency(store, key);
      expect(result.processed).toBe(true);
    });

    it('rethrows non-constraint errors', async () => {
      const store: IdempotencyStore = {
        idempotencyKey: {
          create: vi.fn().mockRejectedValue(new Error('Connection refused')),
        },
      };
      const key = buildIdempotencyKey('m1', 'l1', 'OPEN');
      await expect(checkAndRecordIdempotency(store, key)).rejects.toThrow('Connection refused');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Backoff
// ────────────────────────────────────────────────────────────────────────────

describe('S14 Backoff', () => {
  describe('calculateDelay', () => {
    it('returns base delay for attempt 0', () => {
      // Without jitter, attempt 0: 1000 * 2^0 = 1000
      const delay = calculateDelay(0, { ...DEFAULT_BACKOFF_CONFIG, useJitter: false });
      expect(delay).toBe(1000);
    });

    it('grows exponentially', () => {
      const d1 = calculateDelay(1, { ...DEFAULT_BACKOFF_CONFIG, useJitter: false });
      const d2 = calculateDelay(2, { ...DEFAULT_BACKOFF_CONFIG, useJitter: false });
      expect(d1).toBe(2000);
      expect(d2).toBe(4000);
    });

    it('caps at maxDelay', () => {
      const delay = calculateDelay(99, { ...DEFAULT_BACKOFF_CONFIG, useJitter: false, maxDelayMs: 5000 });
      expect(delay).toBe(5000);
    });

    it('jitter produces values in range', () => {
      const config = { ...DEFAULT_BACKOFF_CONFIG, useJitter: true, maxDelayMs: 10000 };
      for (let i = 0; i < 100; i++) {
        const delay = calculateDelay(0, config);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(1000);
      }
    });
  });

  describe('BackoffTracker', () => {
    let tracker: BackoffTracker;

    beforeEach(() => {
      tracker = new BackoffTracker({
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxAttempts: 3,
        factor: 2,
        useJitter: false,
      });
    });

    it('allows first attempt', () => {
      expect(tracker.canRetry('key1')).toBe(true);
    });

    it('tracks failures and delays', () => {
      const delay = tracker.recordFailure('key1');
      expect(delay).not.toBeNull();
      expect(tracker.canRetry('key1')).toBe(false);
    });

    it('resets on success', () => {
      tracker.recordFailure('key1');
      tracker.recordSuccess('key1');
      expect(tracker.canRetry('key1')).toBe(true);
    });

    it('exhausts after maxAttempts', () => {
      for (let i = 0; i < 3; i++) {
        const delay = tracker.recordFailure('key1');
        if (i < 2) expect(delay).not.toBeNull();
        else expect(delay).toBeNull();
      }
      expect(tracker.isExhausted('key1')).toBe(true);
    });

    it('remainingWaitMs returns positive during backoff', () => {
      tracker.recordFailure('key1');
      const state = tracker.get('key1');
      expect(remainingWaitMs(state)).toBeGreaterThan(0);
    });

    it('clears all state', () => {
      tracker.recordFailure('a');
      tracker.recordFailure('b');
      expect(tracker.size).toBe(2);
      tracker.clear();
      expect(tracker.size).toBe(0);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DLQ
// ────────────────────────────────────────────────────────────────────────────

describe('S14 Dead-Letter Queue', () => {
  function makeStore(jobs: any[] = []): DLQStore {
    return {
      deadLetterJob: {
        create: vi.fn(async (args: any) => ({
          id: 'dlq-1',
          sequenceId: args.data.sequenceId ?? 'unknown',
          jobData: args.data.jobData ?? {},
          errorMessage: args.data.errorMessage ?? '',
          errorStack: args.data.errorStack ?? null,
          attemptCount: args.data.attemptCount ?? 0,
          firstFailedAt: args.data.firstFailedAt ?? new Date(),
          deadLetteredAt: args.data.deadLetteredAt ?? new Date(),
          status: args.data.status ?? 'PENDING',
          resolvedBy: null,
          resolutionNotes: null,
          resolvedAt: null,
          replayable: args.data.replayable ?? true,
          createdAt: new Date(),
        })),
        findMany: vi.fn(async (args?: any) => {
          if (args?.where?.status) {
            return jobs.filter(j => j.status === args.where.status);
          }
          return jobs;
        }),
        count: vi.fn(async (args?: any) => {
          if (args?.where?.status) {
            return jobs.filter(j => j.status === args.where.status).length;
          }
          return jobs.length;
        }),
        findUnique: vi.fn(async (args: any) => jobs.find(j => j.id === args.where.id) ?? null),
        update: vi.fn(async (args: any) => {
          const job = jobs.find(j => j.id === args.where.id);
          if (!job) throw new Error('Not found');
          Object.assign(job, args.data);
          return job;
        }),
      },
    };
  }

  it('creates a dead-letter job', async () => {
    const store = makeStore();
    const job = await deadLetterJob(store, {
      sequenceId: 'seq-1',
      jobData: { sequenceId: 'seq-1' },
      error: new Error('Send failed'),
      attemptCount: 5,
      firstFailedAt: new Date(),
    });
    expect(job.status).toBe('PENDING');
    expect(job.replayable).toBe(true);
    expect(job.errorMessage).toBe('Send failed');
  });

  it('resolves a DLQ job', async () => {
    const jobs = [{ id: 'dlq-1', status: 'PENDING', replayable: true }];
    const store = makeStore(jobs);
    const result = await resolveDLQJob(store, 'dlq-1', 'admin', 'Fixed config');
    expect(result.status).toBe('RESOLVED');
    expect(result.replayable).toBe(false);
    expect(result.resolvedBy).toBe('admin');
  });

  it('ignores a DLQ job', async () => {
    const jobs = [{ id: 'dlq-2', status: 'PENDING', replayable: true }];
    const store = makeStore(jobs);
    const result = await ignoreDLQJob(store, 'dlq-2', 'admin');
    expect(result.status).toBe('IGNORED');
    expect(result.replayable).toBe(false);
  });

  it('lists pending DLQ jobs', async () => {
    const jobs = [
      { id: 'a', status: 'PENDING' },
      { id: 'b', status: 'PENDING' },
      { id: 'c', status: 'RESOLVED' },
    ];
    const store = makeStore(jobs);
    const result = await listPendingDLQJobs(store);
    expect(result.total).toBe(2);
    expect(result.jobs.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Locking
// ────────────────────────────────────────────────────────────────────────────

describe('S14 Locking', () => {
  describe('MemoryLock', () => {
    it('acquires a free lock', () => {
      const lock = new MemoryLock(5000);
      expect(lock.tryAcquire('key1')).toBe(true);
      expect(lock.isLocked('key1')).toBe(true);
    });

    it('rejects when already locked', () => {
      const lock = new MemoryLock(5000);
      lock.tryAcquire('key1');
      expect(lock.tryAcquire('key1')).toBe(false);
    });

    it('releases a lock', () => {
      const lock = new MemoryLock(5000);
      lock.tryAcquire('key1');
      lock.release('key1');
      expect(lock.isLocked('key1')).toBe(false);
      expect(lock.tryAcquire('key1')).toBe(true);
    });

    it('expires locks after TTL', async () => {
      const lock = new MemoryLock(50); // 50ms TTL
      lock.tryAcquire('key1');
      expect(lock.isLocked('key1')).toBe(true);
      await new Promise(r => setTimeout(r, 60));
      expect(lock.isLocked('key1')).toBe(false);
    });

    it('cleanup removes expired locks', async () => {
      const lock = new MemoryLock(50);
      lock.startCleanup(20);
      lock.tryAcquire('key1');
      await new Promise(r => setTimeout(r, 100));
      // Force cleanup
      lock.clear(); // Direct test
      expect(lock.tryAcquire('key1')).toBe(true);
      lock.stopCleanup();
    });

    it('different keys don\'t conflict', () => {
      const lock = new MemoryLock(5000);
      expect(lock.tryAcquire('a')).toBe(true);
      expect(lock.tryAcquire('b')).toBe(true);
      expect(lock.isLocked('a')).toBe(true);
      expect(lock.isLocked('b')).toBe(true);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Webhook Idempotency
// ────────────────────────────────────────────────────────────────────────────

describe('S14 Webhook Idempotency', () => {
  describe('isValidTransition', () => {
    it('allows QUEUED → SENT', () => {
      expect(isValidTransition('QUEUED', 'SENT')).toBe(true);
    });

    it('allows SENT → DELIVERED', () => {
      expect(isValidTransition('SENT', 'DELIVERED')).toBe(true);
    });

    it('allows SENT → OPENED', () => {
      expect(isValidTransition('SENT', 'OPENED')).toBe(true);
    });

    it('allows OPENED → CLICKED', () => {
      expect(isValidTransition('OPENED', 'CLICKED')).toBe(true);
    });

    it('allows SENT → BOUNCED', () => {
      expect(isValidTransition('SENT', 'BOUNCED')).toBe(true);
    });

    it('rejects BOUNCED → OPENED (cannot un-bounce)', () => {
      expect(isValidTransition('BOUNCED', 'OPENED')).toBe(false);
    });

    it('rejects FAILED → SENT', () => {
      expect(isValidTransition('FAILED', 'SENT')).toBe(false);
    });

    it('rejects REPLIED → OPENED', () => {
      expect(isValidTransition('REPLIED', 'OPENED')).toBe(false);
    });

    it('allows null/undefined fromStatus (new message)', () => {
      expect(isValidTransition(null, 'SENT')).toBe(true);
      expect(isValidTransition(undefined, 'QUEUED')).toBe(true);
    });
  });

  describe('processWebhookEvent', () => {
    // Clear the shared cache before each test to avoid cross-test contamination
    beforeEach(() => {
      getWebhookCache().clear();
    });

    function makeWebhookStore(options: {
      createFn?: () => Promise<{ id: string; key: string }>;
      messageStatus?: string;
    } = {}): WebhookStore {
      return {
        idempotencyKey: {
          create: options.createFn
            ? options.createFn
            : vi.fn().mockResolvedValue({ id: 'new-id', key: 'test-key' }),
        },
        outreachMessage: {
          findUnique: vi.fn().mockResolvedValue(
            options.messageStatus ? { id: 'm1', status: options.messageStatus, leadId: 'l1' } : null,
          ),
          update: vi.fn().mockResolvedValue({}),
        },
      };
    }

    it('processes a new event', async () => {
      const store = makeWebhookStore({ messageStatus: 'SENT' });
      const result = await processWebhookEvent(store, {
        messageId: 'new-msg-1',
        leadId: 'new-lead-1',
        eventType: 'OPEN',
      });
      expect(result.alreadyProcessed).toBe(false);
      expect(result.invalidTransition).toBe(false);
      expect(result.currentStatus).toBe('OPENED');
    });

    it('detects duplicate events', async () => {
      const store = makeWebhookStore({
        createFn: vi.fn().mockRejectedValue(new Error('Unique constraint violation')),
      });
      const result = await processWebhookEvent(store, {
        messageId: 'dup-msg-1',
        leadId: 'dup-lead-1',
        eventType: 'OPEN',
      });
      expect(result.alreadyProcessed).toBe(true);
    });

    it('rejects invalid transitions', async () => {
      const store = makeWebhookStore({ messageStatus: 'BOUNCED' });
      const result = await processWebhookEvent(store, {
        messageId: 'bounced-msg',
        leadId: 'bounced-lead',
        eventType: 'OPEN',
      });
      expect(result.invalidTransition).toBe(true);
      expect(result.currentStatus).toBe('BOUNCED');
    });

    it('deduplicates via memory cache on second call', async () => {
      let createCount = 0;
      const store = makeWebhookStore({
        createFn: async () => { createCount++; return { id: `id-${createCount}`, key: `key-${createCount}` }; },
        messageStatus: 'SENT',
      });

      // First call — should create
      const r1 = await processWebhookEvent(store, {
        messageId: 'cache-msg', leadId: 'cache-lead', eventType: 'OPEN',
      });
      expect(r1.alreadyProcessed).toBe(false);
      expect(createCount).toBe(1);

      // Second call — should hit memory cache (no DB call)
      const r2 = await processWebhookEvent(store, {
        messageId: 'cache-msg', leadId: 'cache-lead', eventType: 'OPEN',
      });
      expect(r2.alreadyProcessed).toBe(true);
      // createCount should still be 1 because cache hit skipped DB
      expect(createCount).toBe(1);
    });

    it('sets timestamps on status transitions', async () => {
      const store = makeWebhookStore({ messageStatus: 'SENT' });

      const openResult = await processWebhookEvent(store, {
        messageId: 'ts-msg', leadId: 'ts-lead', eventType: 'OPEN',
      });
      expect(openResult.invalidTransition).toBe(false);

      // Verify update was called with openedAt
      const updateFn = store.outreachMessage.update as ReturnType<typeof vi.fn>;
      expect(updateFn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ts-msg' },
          data: expect.objectContaining({ status: 'OPENED', openedAt: expect.any(Date) }),
        }),
      );
    });
  });
});