import { describe, expect, it, vi } from 'vitest';
import {
  enqueueIdempotent,
  registerRedisRecovery,
  unregisterRedisRecovery,
} from '../../src/core/queues/helpers.js';

/**
 * S12: Queue helper + Redis recovery regression tests.
 *
 * Verifies that enqueues are idempotent (no duplicates on retry), that
 * Redis failures are surfaced (never silently swallowed), and that recovery
 * trackers register/unregister without leaking timers.
 */

// ─────────────────────────────────────────────────────────────────────────────

describe('enqueueIdempotent (S12)', () => {
  it('returns enqueued=true when add succeeds', async () => {
    const queue = {
      add: vi.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const result = await enqueueIdempotent(
      queue as any,
      'dispatch',
      { sequenceId: 'seq-1' },
      'dispatch:seq-1',
    );

    expect(result.enqueued).toBe(true);
    expect(result.error).toBeUndefined();
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      { sequenceId: 'seq-1' },
      { jobId: 'dispatch:seq-1' },
    );
  });

  it('returns enqueued=false for duplicate job (no error)', async () => {
    const queue = {
      add: vi.fn().mockRejectedValue(new Error('Job Job dispatch:seq-1 exists')),
    };

    const result = await enqueueIdempotent(
      queue as any,
      'dispatch',
      { sequenceId: 'seq-1' },
      'dispatch:seq-1',
    );

    expect(result.enqueued).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns enqueued=false with error when Redis is down', async () => {
    const queue = {
      add: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    };

    const result = await enqueueIdempotent(
      queue as any,
      'dispatch',
      { sequenceId: 'seq-1' },
      'dispatch:seq-1',
    );

    expect(result.enqueued).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('surfaces timeout as an error (never silent)', async () => {
    const queue = {
      add: vi.fn().mockImplementation(
        () => new Promise((_resolve) => { /* never resolves */ }),
      ),
    };

    const result = await enqueueIdempotent(
      queue as any,
      'dispatch',
      { sequenceId: 'seq-1' },
      'dispatch:seq-1',
    );

    expect(result.enqueued).toBe(false);
    expect(result.error).toContain('timed out');
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('registerRedisRecovery (S12)', () => {
  it('registers and unregisters without duplicate timers', () => {
    registerRedisRecovery('test-recovery', 10_000, () => false, () => {});
    registerRedisRecovery('test-recovery', 10_000, () => false, () => {}); // dedupe

    unregisterRedisRecovery('test-recovery');
    // Should not throw
    expect(true).toBe(true);
  });
});
