import type { Queue } from 'bullmq';
import { redisConnection } from './queue.js';

/**
 * S12: Queue helpers — idempotent enqueue, Redis recovery, and safe job counting.
 *
 * Every enqueue into BullMQ uses a deterministic job ID so that retries
 * after Redis blips do not create duplicate jobs.
 */

const ENQUEUE_TIMEOUT_MS = 3000;

/**
 * Add a job with a deterministic jobId to prevent duplicates.
 * Returns `true` if the job was newly enqueued, `false` if it was already present.
 */
export async function enqueueIdempotent<TData = unknown>(
  queue: Queue<unknown, any, string>,
  name: string,
  data: TData,
  jobId: string,
  opts?: { delay?: number },
): Promise<{ enqueued: boolean; error?: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.race([
      (queue as any).add(name, data, { jobId, ...(opts?.delay != null ? { delay: opts.delay } : {}) }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Queue add timed out')), ENQUEUE_TIMEOUT_MS),
      ),
    ]);
    return { enqueued: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Duplicate job ID — a job with this ID already exists. Not an error.
    if (msg.includes('Job') && (msg.includes('exists') || msg.includes('duplicate'))) {
      return { enqueued: false };
    }

    // Connection error — Redis is likely down; caller should treat as not-enqueued
    // but NOT lose the job — the caller should retry next tick.
    return { enqueued: false, error: msg };
  }
}

// ──────────────────────────── Redis recovery tracker ────────────────────────────

interface RecoveryTracker {
  recoveryTimer: ReturnType<typeof setInterval> | null;
  lastAttemptAt: number;
}

const recoveryTrackers = new Map<string, RecoveryTracker>();

/**
 * Register a periodic Redis recovery check.
 * Calls the callback every `intervalMs` when `isDownFn()` returns true.
 * When the callback succeeds, recovery stops and `isDownFn` should return false.
 */
export function registerRedisRecovery(
  key: string,
  intervalMs: number,
  isDownFn: () => boolean,
  onRecovery: () => void,
): void {
  // Avoid duplicate registration
  if (recoveryTrackers.has(key)) return;

  const tracker: RecoveryTracker = {
    recoveryTimer: null,
    lastAttemptAt: 0,
  };

  tracker.recoveryTimer = setInterval(() => {
    // Only attempt recovery when Redis was previously marked down
    if (!isDownFn()) return;

    // Check if Redis is available
    if (redisConnection.status === 'ready') {
      try {
        redisConnection.ping()
          .then(() => {
            onRecovery();
            // Stop the recovery timer once recovered
            if (tracker.recoveryTimer) {
              clearInterval(tracker.recoveryTimer);
              tracker.recoveryTimer = null;
            }
          })
          .catch(() => {
            // Still down — only log once every 60s max
            if (Date.now() - tracker.lastAttemptAt > 60_000) {
              tracker.lastAttemptAt = Date.now();
              console.warn(`[redis-recovery] ${key}: Redis ping failed — still unreachable`);
            }
          });
      } catch {
        // Connection not available
      }
    }
  }, intervalMs).unref();

  recoveryTrackers.set(key, tracker);
}

/**
 * Clean up a recovery tracker (e.g., on app shutdown).
 */
export function unregisterRedisRecovery(key: string): void {
  const tracker = recoveryTrackers.get(key);
  if (tracker?.recoveryTimer) {
    clearInterval(tracker.recoveryTimer);
  }
  recoveryTrackers.delete(key);
}