/**
 * S15: Retention Scheduler — Periodic anonymization of outdated leads.
 *
 * Polls the data_retention_policies table every `intervalMs` and runs
 * `scheduledAnonymization()` when the LEAD policy has autoAnonymize=true.
 *
 * The scheduler is lightweight — it only runs when autoAnonymize is
 * enabled and only processes leads past their retention window.
 *
 * By default, autoAnonymize is OFF for LEADs. Enable it via:
 *   PUT /api/v1/admin/retention/policies/LEAD  { "autoAnonymize": true, "retentionDays": 730 }
 */

import { prisma } from '../../db/client.js';
import { scheduledAnonymization, getRetentionPolicy } from '../security/retention.js';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

export class RetentionScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private intervalMs: number;

  constructor(intervalMs = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /** Start the periodic retention check. */
  start(): void {
    if (this.running) return;

    this.running = true;
    console.log(`[RetentionScheduler] Starting with interval ${this.intervalMs}ms`);

    // Run immediately on start (catch up on missed work)
    this.poll().catch(() => {});

    this.intervalId = setInterval(() => {
      this.poll().catch(() => {});
    }, this.intervalMs).unref();
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log('[RetentionScheduler] Stopped.');
  }

  /** Whether the scheduler is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Poll the retention policy and run anonymization if enabled. */
  async poll(): Promise<{ anonymized: number; errors: string[] }> {
    try {
      const db = prisma as any;
      const policy = await getRetentionPolicy(db, 'LEAD');

      if (!policy.autoAnonymize) {
        return { anonymized: 0, errors: [] };
      }

      const result = await scheduledAnonymization(db);

      if (result.anonymized > 0) {
        console.log(`[RetentionScheduler] Anonymized ${result.anonymized} lead(s)`);
      }

      if (result.errors.length > 0) {
        console.warn(`[RetentionScheduler] ${result.errors.length} error(s):`, result.errors.slice(0, 5).join(', '));
      }

      return result;
    } catch (err) {
      console.error('[RetentionScheduler] Poll failed:', err instanceof Error ? err.message : String(err));
      return { anonymized: 0, errors: [String(err)] };
    }
  }
}