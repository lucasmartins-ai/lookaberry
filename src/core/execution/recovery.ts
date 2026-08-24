/**
 * S14: Recovery Module — Resilient Restart & Reconnection
 *
 * Handles graceful recovery after:
 * - API server restart (Fastify)
 * - Redis connection loss / restart
 * - BullMQ worker restart
 * - PostgreSQL connection loss / restart
 *
 * Strategy:
 * - Redis: Reconnect with exponential backoff via ioredis built-in retry
 * - BullMQ: Workers auto-retry failed jobs; blocked connection handles reconnect
 * - PostgreSQL: Prisma connection pool auto-reconnects; advisory locks auto-release
 * - Scheduler: On restart, re-scan for due sequences
 *
 * Key invariant: No job is lost across restarts. All state lives in PostgreSQL.
 * Redis holds only transient BullMQ job data (rebuilt from PG on drain).
 */

import { redisConnection } from '../queues/queue.js';
import { prisma } from '../../db/client.js';
import type { SequenceScheduler } from './scheduler.js';
import { getMemoryLock, MemoryLock } from './locking.js';
import { getBackoffTracker, BackoffTracker } from './backoff.js';
import { IdempotencyCache } from './idempotency.js';

export interface RecoveryState {
  redis: 'connected' | 'disconnected' | 'reconnecting';
  postgres: 'connected' | 'disconnected' | 'reconnecting';
  workers: 'running' | 'stopped' | 'unknown';
  scheduler: 'running' | 'stopped';
  lastRecoveryAt: number | null;
  recoveryCount: number;
}

/**
 * Health-check the core dependencies.
 */
export async function checkDependencies(): Promise<{
  redis: boolean;
  postgres: boolean;
}> {
  const results: { redis: boolean; postgres: boolean } = {
    redis: false,
    postgres: false,
  };

  // Redis
  try {
    if (redisConnection.status === 'ready') {
      await redisConnection.ping();
      results.redis = true;
    }
  } catch {
    // Still disconnected
  }

  // PostgreSQL
  try {
    await prisma.$queryRaw`SELECT 1`;
    results.postgres = true;
  } catch {
    // Still disconnected
  }

  return results;
}

/**
 * Register recovery hooks for the SequenceScheduler.
 *
 * On Redis recovery: re-enqueue all due sequences (they were missed
 * while Redis was down).
 * On PostgreSQL recovery: no-op (Prisma handles reconnection).
 */
export function registerSchedulerRecovery(
  scheduler: SequenceScheduler,
): () => void {
  const interval = setInterval(async () => {
    if (!scheduler.isRunning()) return;

    const deps = await checkDependencies();

    if (deps.redis) {
      try {
        // Re-poll for due sequences that were missed
        const count = await scheduler.poll();
        if (count > 0) {
          console.log(`[Recovery] Re-enqueued ${count} missed sequences after connectivity restore`);
        }
      } catch {
        // Scheduler poll handles its own errors
      }
    }
  }, 15_000).unref(); // Every 15 seconds

  return () => clearInterval(interval);
}

/**
 * Recover after a full restart:
 * 1. Clear stale in-memory state (cadence governor, backoff tracker, locks)
 * 2. Re-scan for SCHEDULED messages whose time has passed
 * 3. Re-scan for due sequences
 */

export interface RecoveryReport {
  staleScheduledMessages: number;
  dueSequences: number;
  reenqueuedSequences: number;
  errors: string[];
}

export async function performFullRecovery(
  scheduler: SequenceScheduler,
): Promise<RecoveryReport> {
  const now = new Date();
  const report: RecoveryReport = {
    staleScheduledMessages: 0,
    dueSequences: 0,
    reenqueuedSequences: 0,
    errors: [],
  };

  // 1. Find SCHEDULED messages whose scheduledAt has passed while the system was down
  try {
    const staleCount = await prisma.outreachMessage.updateMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
      },
      data: {
        status: 'QUEUED',
        scheduledAt: null,
      },
    });
    report.staleScheduledMessages = staleCount.count;
    if (staleCount.count > 0) {
      console.log(`[Recovery] Re-queued ${staleCount.count} stale scheduled messages`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Stale message recovery failed: ${msg}`);
  }

  // 2. Find due sequences and enqueue them
  try {
    const dueSequences = await prisma.outreachSequence.findMany({
      where: {
        status: 'ACTIVE',
        nextRunAt: { lte: now },
        OR: [
          { pausedUntil: null },
          { pausedUntil: { lte: now } },
        ],
      },
      select: { id: true },
    });
    report.dueSequences = dueSequences.length;

    if (dueSequences.length > 0) {
      // Use scheduler poll to enqueue (handles idempotent enqueue)
      const enqueued = await scheduler.poll();
      report.reenqueuedSequences = enqueued;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Due sequence recovery failed: ${msg}`);
  }

  console.log(
    JSON.stringify({
      msg: 'recovery_completed',
      ...report,
    }),
  );

  return report;
}

// ─────────────────────── Recovery state tracker ───────────────────────

let recoveryState: RecoveryState = {
  redis: 'disconnected',
  postgres: 'disconnected',
  workers: 'unknown',
  scheduler: 'stopped',
  lastRecoveryAt: null,
  recoveryCount: 0,
};

export function getRecoveryState(): RecoveryState {
  // Update live state from connections
  recoveryState.redis = redisConnection.status === 'ready' ? 'connected' : 'disconnected';

  return recoveryState;
}

export function updateRecoveryState(update: Partial<RecoveryState>): void {
  recoveryState = { ...recoveryState, ...update };
}

// ─────────────────────── Reset helpers (for testing) ───────────────────────

export function resetRecoveryState(): void {
  recoveryState = {
    redis: 'disconnected',
    postgres: 'disconnected',
    workers: 'unknown',
    scheduler: 'stopped',
    lastRecoveryAt: null,
    recoveryCount: 0,
  };
  getMemoryLock().clear();
  getBackoffTracker().clear();
}