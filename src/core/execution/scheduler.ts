import { outreachQueue } from '../queues/queue.js';
import { enqueueIdempotent } from '../queues/helpers.js';
import { prisma } from '../../db/client.js';
import { getMemoryLock } from './locking.js';

export interface SequenceSchedulerOptions {
  /** Polling interval in milliseconds (default: 60_000 = 60s) */
  intervalMs?: number;
  /** Custom Prisma client (for testing) */
  _prisma?: typeof prisma;
}

export class SequenceScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly _prisma: typeof prisma;
  private running = false;

  constructor(options: SequenceSchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this._prisma = options._prisma ?? prisma;
  }

  /** Start the scheduler. Idempotent — no-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[SequenceScheduler] Starting with interval ${this.intervalMs}ms`);

    const tick = async () => {
      try {
        const count = await this.poll();
        if (count > 0) {
          console.log(`[SequenceScheduler] Enqueued ${count} due sequence(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Graceful degradation: log warning, don't crash
        console.warn('[SequenceScheduler] Poll cycle failed:', msg);
      }
    };

    // Run immediately on start, then on interval
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  /** Stop the scheduler. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[SequenceScheduler] Stopped.');
  }

  /** Whether the scheduler is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Poll for active sequences due for execution and enqueue them.
   * Returns the number of sequences enqueued.
   */
  async poll(): Promise<number> {
    const now = new Date();

    const sequences = await this._prisma.outreachSequence.findMany({
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

    if (sequences.length === 0) return 0;

    let enqueued = 0;

    const memLock = getMemoryLock();

    for (const seq of sequences) {
      // S14: Per-sequence lock prevents scheduler→dispatcher race
      const seqLockKey = `seq:${seq.id}`;
      if (!memLock.tryAcquire(seqLockKey, 'scheduler')) {
        // Dispatcher is already working on this sequence — skip enqueue
        continue;
      }

      // Deterministic job ID prevents duplicate dispatch jobs when a Redis blip
      // causes a previous add to be retried on the next tick.
      const jobId = `dispatch-${seq.id}`;
      const result = await enqueueIdempotent(
        outreachQueue,
        'dispatch',
        { sequenceId: seq.id },
        jobId,
      );

      if (result.enqueued) {
        enqueued++;
      } else if (result.error) {
        // Redis unreachable — do NOT advance nextRunAt; the sequence stays due
        // and is retried on the next tick. This avoids silent job loss.
        console.warn(
          `[SequenceScheduler] Could not enqueue sequence ${seq.id}: ${result.error}`,
        );
      }

      // Release lock after enqueue so the dispatcher can pick it up
      memLock.release(seqLockKey);
    }

    return enqueued;
  }
}