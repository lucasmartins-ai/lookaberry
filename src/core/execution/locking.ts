/**
 * S14: Distributed Locking via PostgreSQL Advisory Locks
 *
 * Provides per-sequence and per-message locking to prevent races between:
 * - SequenceScheduler (enqueuing dispatch jobs)
 * - Dispatcher (processing sends)
 * - Webhook handlers (updating message status)
 *
 * Advisory locks are:
 *  - Session-scoped (auto-released on connection close / pool return)
 *  - Lightweight (no table row needed)
 *  - Integer-keyed (we hash string keys to bigint)
 *
 * Fallback: In-memory locks when DB is unavailable (for tests & dev).
 */

import { createHash } from 'node:crypto';

/** Prisma-like interface for running raw SQL */
export interface LockExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Hash a string key to a bigint suitable for pg_try_advisory_lock.
 *
 * PostgreSQL advisory locks use bigint (int8). We hash to ensure
 * even distribution across the 64-bit space.
 */
function hashKey(key: string): bigint {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 16); // 64 bits
  return BigInt(`0x${hex}`);
}

const LOCK_NAMESPACE = {
  SEQUENCE: 'seq',
  MESSAGE: 'msg',
  LEAD_SEQUENCE: 'ls',
} as const;

function buildLockKey(namespace: string, id: string): string {
  return `${LOCK_NAMESPACE[namespace as keyof typeof LOCK_NAMESPACE] ?? namespace}:${id}`;
}

/**
 * Acquire a non-blocking advisory lock.
 *
 * Returns true if the lock was acquired, false if another session holds it.
 * The lock is automatically released when the current transaction/connection
 * is returned to the pool.
 */
export async function tryAcquireLock(
  executor: LockExecutor,
  namespace: string,
  id: string,
): Promise<boolean> {
  const key = buildLockKey(namespace, id);
  const hash = hashKey(key);

  try {
    const result = await executor.$queryRawUnsafe<Array<{ locked: boolean }>>(
      `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
      hash,
    );
    return result[0]?.locked === true;
  } catch (err) {
    console.warn(`[Lock] pg_try_advisory_lock failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return false; // DB unavailable — assume lock not acquired (safety-first)
  }
}

/**
 * Release an advisory lock. Normally unnecessary (auto-released on session
 * end), but useful in long-lived transactions to release early.
 */
export async function releaseLock(
  executor: LockExecutor,
  namespace: string,
  id: string,
): Promise<boolean> {
  const key = buildLockKey(namespace, id);
  const hash = hashKey(key);

  try {
    const result = await executor.$queryRawUnsafe<Array<{ released: boolean }>>(
      `SELECT pg_advisory_unlock($1::bigint) AS released`,
      hash,
    );
    return result[0]?.released === true;
  } catch {
    return false;
  }
}

/**
 * Acquire a lock with retries (for high-contention scenarios).
 * Polls every `intervalMs` for up to `timeoutMs`.
 */
export async function acquireLockWithRetry(
  executor: LockExecutor,
  namespace: string,
  id: string,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await tryAcquireLock(executor, namespace, id)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return false;
}

// ──────────────── In-Memory Fallback (for tests / no-DB) ────────────────

export class MemoryLock {
  private locks = new Map<string, { holder: string; acquiredAt: number }>();
  private readonly ttlMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  /** Start automatic cleanup of expired locks */
  startCleanup(intervalMs = 10_000): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), intervalMs).unref();
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  tryAcquire(key: string, holder = 'default'): boolean {
    this.cleanup();

    const existing = this.locks.get(key);
    if (existing && Date.now() - existing.acquiredAt < this.ttlMs) {
      return false; // Still locked
    }

    this.locks.set(key, { holder, acquiredAt: Date.now() });
    return true;
  }

  release(key: string): void {
    this.locks.delete(key);
  }

  isLocked(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    return Date.now() - existing.acquiredAt < this.ttlMs;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, info] of this.locks) {
      if (now - info.acquiredAt >= this.ttlMs) {
        this.locks.delete(key);
      }
    }
  }

  clear(): void {
    this.locks.clear();
  }
}

/** Global memory lock for fallback scenarios */
let globalMemoryLock: MemoryLock | null = null;

export function getMemoryLock(ttlMs?: number): MemoryLock {
  if (!globalMemoryLock) {
    globalMemoryLock = new MemoryLock(ttlMs);
    globalMemoryLock.startCleanup();
  }
  return globalMemoryLock;
}

export function resetMemoryLock(): void {
  globalMemoryLock?.stopCleanup();
  globalMemoryLock?.clear();
  globalMemoryLock = null;
}