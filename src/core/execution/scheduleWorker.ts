import { outreachQueue } from '../queues/queue.js';
import { enqueueIdempotent } from '../queues/helpers.js';

/**
 * S10: Schedule Worker
 *
 * Periodically checks for OutreachMessages with status='SCHEDULED'
 * whose scheduledAt has arrived. Re-enqueues them to the dispatcher.
 *
 * This is the bridge between the Smart Scheduler (which defers messages
 * outside business hours) and the Dispatcher (which sends them).
 */

export interface ScheduleWorkerDeps {
  /** Injectable Prisma client (for testing) */
  prisma?: {
    outreachMessage: {
      findMany: (args: {
        where: Record<string, unknown>;
        select: Record<string, unknown>;
      }) => Promise<Array<{ id: string; leadId: string; campaignId: string }>>;
      updateMany: (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
    outreachSequence: {
      findMany: (args: {
        where: Record<string, unknown>;
        select: Record<string, unknown>;
      }) => Promise<Array<{ id: string }>>;
    };
  };
  /** Poll interval in ms (default 30s) */
  intervalMs?: number;
  /** Max messages to dequeue per poll */
  batchSize?: number;
}

export class ScheduleWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: ScheduleWorkerDeps;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private running = false;

  constructor(deps: ScheduleWorkerDeps = {}) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.batchSize = deps.batchSize ?? 50;
  }

  /** Start the worker. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[ScheduleWorker] Starting with interval ${this.intervalMs}ms`);

    const tick = async () => {
      try {
        const count = await this.poll();
        if (count > 0) {
          console.log(`[ScheduleWorker] Re-enqueued ${count} scheduled message(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[ScheduleWorker] Poll cycle failed:', msg);
      }
    };

    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  /** Stop the worker. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[ScheduleWorker] Stopped.');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Poll for due scheduled messages and re-enqueue them.
   * Returns the number of messages re-enqueued.
   */
  async poll(): Promise<number> {
    if (!this.deps.prisma) return 0;

    const now = new Date();

    // Find scheduled messages whose time has come
    const messages = await this.deps.prisma.outreachMessage.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
      },
      select: {
        id: true,
        leadId: true,
        campaignId: true,
      },
    }).then(msgs => msgs.slice(0, this.batchSize));

    if (messages.length === 0) return 0;

    let enqueued = 0;

    // Group by sequence — find which sequences these messages belong to
    const campaignIds = [...new Set(messages.map(m => m.campaignId))];

    for (const campaignId of campaignIds) {
      try {
        // Find active sequences for this campaign that contain these leads
        const sequences = await this.deps.prisma!.outreachSequence.findMany({
          where: {
            campaignId,
            status: 'ACTIVE',
            leads: {
              some: {
                id: { in: messages.filter(m => m.campaignId === campaignId).map(m => m.leadId) },
              },
            },
          },
          select: { id: true },
        });

        for (const seq of sequences) {
          const result = await enqueueIdempotent(
            outreachQueue,
            'dispatch',
            { sequenceId: seq.id },
            `dispatch-${seq.id}`,
          );
          if (result.enqueued) {
            enqueued++;
          } else if (result.error) {
            console.warn(`[ScheduleWorker] Could not enqueue sequence ${seq.id}: ${result.error}`);
          }
          // already enqueued (dedupe) → skip
        }
      } catch {
        // Skip campaign if sequence lookup fails
      }
    }

    // Update message status from SCHEDULED to QUEUED for those re-enqueued
    if (enqueued > 0) {
      const messageIds = messages.slice(0, enqueued).map(m => m.id);
      try {
        await this.deps.prisma.outreachMessage.updateMany({
          where: { id: { in: messageIds } },
          data: { status: 'QUEUED', scheduledAt: null },
        });
      } catch {
        // Best-effort update
      }
    }

    return enqueued;
  }

  /**
   * Directly enqueue a specific message for a future send time.
   * Called by the dispatcher when shouldSendNow returns false.
   */
  async enqueueScheduled(
    prisma: ScheduleWorkerDeps['prisma'],
    messageId: string,
    scheduledAt: Date,
  ): Promise<void> {
    if (!prisma) return;

    try {
      await prisma.outreachMessage.updateMany({
        where: { id: messageId },
        data: {
          status: 'SCHEDULED',
          scheduledAt,
        },
      });
    } catch (err) {
      console.warn(`[ScheduleWorker] Could not schedule message ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}