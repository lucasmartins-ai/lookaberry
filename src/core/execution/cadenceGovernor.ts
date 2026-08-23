import type { ChannelId } from '../channels/types.js';

/**
 * S10: Global Cadence Governor
 *
 * Controls overall send rate to prevent bursting:
 * - Global max per minute across all channels
 * - Global max per hour across all channels
 * - Per-channel max per minute
 *
 * Uses in-memory sliding windows (no Redis dependency).
 * Future: Redis-backed for horizontal scaling when REDIS_URL is set.
 */

export interface CadenceConfig {
  globalMaxPerMinute: number;
  globalMaxPerHour: number;
  perChannelMaxPerMinute: number;
}

export interface SendSlotResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface CadenceState {
  channelSlots: Record<string, { available: boolean; used: number; limit: number }>;
  globalSlots: { available: boolean; usedPerMinute: number; usedPerHour: number; limitPerMinute: number; limitPerHour: number };
  nextAvailableMs: number;
}

/**
 * Singleton CadenceGovernor.
 * One instance should be used across the application.
 */
export class CadenceGovernor {
  private readonly config: CadenceConfig;
  /** Per-channel sliding window: channel → timestamps[] */
  private channelWindows = new Map<string, number[]>();
  /** Global per-minute sliding window */
  private globalMinuteWindow: number[] = [];
  /** Global per-hour sliding window */
  private globalHourWindow: number[] = [];

  // For slot reservations (pre-allocating before actual send)
  private reservedChannelSlots = new Map<string, number>();
  private reservedGlobalMinuteCount = 0;
  private reservedGlobalHourCount = 0;

  constructor(config: CadenceConfig) {
    this.config = config;
  }

  /**
   * Attempt to acquire a send slot for the given channel.
   * Returns { allowed: true } if within limits, or { allowed: false, retryAfterMs } if throttled.
   */
  acquireSendSlot(channel: ChannelId): SendSlotResult {
    const now = Date.now();

    // Prune expired timestamps from all windows
    this.pruneAll(now);

    // Check per-channel limit
    const channelTs = this.getChannelWindow(channel);
    const channelReserved = this.reservedChannelSlots.get(channel) ?? 0;
    const perChannelLimit = this.config.perChannelMaxPerMinute;
    if (channelTs.length + channelReserved >= perChannelLimit) {
      const oldestInWindow = channelTs[0] ?? now;
      const retryAfterMs = Math.max(0, (oldestInWindow + 60_000) - now + 100);
      return { allowed: false, retryAfterMs };
    }

    // Check global per-minute limit
    const globalMinReserved = this.reservedGlobalMinuteCount;
    if (this.globalMinuteWindow.length + globalMinReserved >= this.config.globalMaxPerMinute) {
      const oldestInWindow = this.globalMinuteWindow[0] ?? now;
      const retryAfterMs = Math.max(0, (oldestInWindow + 60_000) - now + 100);
      return { allowed: false, retryAfterMs };
    }

    // Check global per-hour limit
    const globalHourReserved = this.reservedGlobalHourCount;
    if (this.globalHourWindow.length + globalHourReserved >= this.config.globalMaxPerHour) {
      const oldestInWindow = this.globalHourWindow[0] ?? now;
      const retryAfterMs = Math.max(0, (oldestInWindow + 3_600_000) - now + 100);
      return { allowed: false, retryAfterMs };
    }

    // Reserve the slot
    this.reservedChannelSlots.set(channel, channelReserved + 1);
    this.reservedGlobalMinuteCount++;
    this.reservedGlobalHourCount++;

    return { allowed: true };
  }

  /**
   * Commit a previously acquired slot to the sliding windows.
   * Called after the send actually completes.
   */
  commitSendSlot(channel: ChannelId): void {
    const now = Date.now();
    this.getChannelWindow(channel).push(now);
    this.globalMinuteWindow.push(now);
    this.globalHourWindow.push(now);

    // Decrement reservation
    const reserved = this.reservedChannelSlots.get(channel) ?? 0;
    if (reserved > 0) this.reservedChannelSlots.set(channel, reserved - 1);
    if (this.reservedGlobalMinuteCount > 0) this.reservedGlobalMinuteCount--;
    if (this.reservedGlobalHourCount > 0) this.reservedGlobalHourCount--;
  }

  /**
   * Release a previously acquired slot without committing it (e.g., send failed).
   */
  releaseSendSlot(channel: ChannelId): void {
    const reserved = this.reservedChannelSlots.get(channel) ?? 0;
    if (reserved > 0) this.reservedChannelSlots.set(channel, reserved - 1);
    if (this.reservedGlobalMinuteCount > 0) this.reservedGlobalMinuteCount--;
    if (this.reservedGlobalHourCount > 0) this.reservedGlobalHourCount--;
  }

  /**
   * Get current cadence state for monitoring.
   */
  getGlobalState(): CadenceState {
    this.pruneAll(Date.now());

    const channelSlots: Record<string, { available: boolean; used: number; limit: number }> = {};
    for (const [channel] of this.channelWindows) {
      const ts = this.channelWindows.get(channel) ?? [];
      const reserved = this.reservedChannelSlots.get(channel) ?? 0;
      channelSlots[channel] = {
        available: ts.length + reserved < this.config.perChannelMaxPerMinute,
        used: ts.length + reserved,
        limit: this.config.perChannelMaxPerMinute,
      };
    }

    const globalSlots = {
      available: this.globalMinuteWindow.length + this.reservedGlobalMinuteCount < this.config.globalMaxPerMinute
        && this.globalHourWindow.length + this.reservedGlobalHourCount < this.config.globalMaxPerHour,
      usedPerMinute: this.globalMinuteWindow.length + this.reservedGlobalMinuteCount,
      usedPerHour: this.globalHourWindow.length + this.reservedGlobalHourCount,
      limitPerMinute: this.config.globalMaxPerMinute,
      limitPerHour: this.config.globalMaxPerHour,
    };

    // Calculate next available slot
    let nextMs = 0;
    const now = Date.now();
    if (!globalSlots.available) {
      const oldestMin = this.globalMinuteWindow[0] ?? now;
      const oldestHour = this.globalHourWindow[0] ?? now;
      const minWait = (oldestMin + 60_000) - now;
      const hourWait = (oldestHour + 3_600_000) - now;
      nextMs = Math.max(0, Math.min(minWait, hourWait)) + 100;
    }

    return { channelSlots, globalSlots, nextAvailableMs: nextMs };
  }

  /** Reset all windows (for testing) */
  reset(): void {
    this.channelWindows.clear();
    this.globalMinuteWindow = [];
    this.globalHourWindow = [];
    this.reservedChannelSlots.clear();
    this.reservedGlobalMinuteCount = 0;
    this.reservedGlobalHourCount = 0;
  }

  // ─── Private helpers ───

  private getChannelWindow(channel: ChannelId): number[] {
    let window = this.channelWindows.get(channel);
    if (!window) {
      window = [];
      this.channelWindows.set(channel, window);
    }
    return window;
  }

  private pruneAll(now: number): void {
    const minuteThreshold = now - 60_000;
    const hourThreshold = now - 3_600_000;

    // Prune per-channel windows
    for (const [channel, ts] of this.channelWindows) {
      const pruned = ts.filter(t => t > minuteThreshold);
      if (pruned.length < ts.length) {
        this.channelWindows.set(channel, pruned);
      }
    }

    // Prune global windows
    this.globalMinuteWindow = this.globalMinuteWindow.filter(t => t > minuteThreshold);
    this.globalHourWindow = this.globalHourWindow.filter(t => t > hourThreshold);
  }
}

/**
 * Default governor instance, configured from env.
 */
let defaultGovernor: CadenceGovernor | null = null;

export function getCadenceGovernor(config?: CadenceConfig): CadenceGovernor {
  if (!defaultGovernor) {
    defaultGovernor = new CadenceGovernor(config ?? {
      globalMaxPerMinute: 60,
      globalMaxPerHour: 1000,
      perChannelMaxPerMinute: 20,
    });
  }
  return defaultGovernor;
}

export function resetCadenceGovernor(): void {
  defaultGovernor?.reset();
  defaultGovernor = null;
}