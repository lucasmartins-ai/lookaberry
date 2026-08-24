/**
 * S14: Exponential Backoff with Jitter
 *
 * Configurable exponential backoff for dispatcher retries, webhook event
 * processing, and recovery after Redis/DB connectivity loss.
 *
 * Implements "Full Jitter" as described in AWS Architecture Blog:
 *   sleep = random_between(0, min(cap, base * 2^attempt))
 */

export interface BackoffConfig {
  /** Initial delay in ms (default: 1000 = 1s) */
  baseDelayMs: number;
  /** Maximum delay in ms (default: 300_000 = 5min) */
  maxDelayMs: number;
  /** Maximum number of retry attempts (default: 5) */
  maxAttempts: number;
  /** Multiplier factor (default: 2, standard exponential) */
  factor: number;
  /** Whether to use full jitter (default: true) */
  useJitter: boolean;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  maxAttempts: 5,
  factor: 2,
  useJitter: true,
};

/** Per-resource backoff state */
export interface BackoffState {
  attempt: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  /** Whether the backoff is exhausted (maxAttempts reached) */
  exhausted: boolean;
}

/**
 * Calculate the delay for a given attempt number.
 * Formula: min(maxDelay, baseDelay * factor^attempt)
 * With full jitter: random(0, delay)
 */
export function calculateDelay(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF_CONFIG): number {
  // 0-indexed attempt: attempt 0 = first retry
  const exponential = config.baseDelayMs * Math.pow(config.factor, attempt);
  const capped = Math.min(exponential, config.maxDelayMs);

  if (config.useJitter) {
    // Full jitter: random_between(0, capped)
    return Math.random() * capped;
  }

  return capped;
}

/**
 * Create initial backoff state (attempt = 0, not yet exhausted).
 */
export function createBackoffState(): BackoffState {
  const now = Date.now();
  return {
    attempt: 0,
    lastAttemptAt: 0,
    nextAttemptAt: now,
    exhausted: false,
  };
}

/**
 * Advance the backoff state after a failed attempt.
 * Returns the delay to wait before next attempt, or null if exhausted.
 */
export function advanceBackoff(state: BackoffState, config: BackoffConfig = DEFAULT_BACKOFF_CONFIG): number | null {
  if (state.exhausted) return null;

  state.attempt++;
  state.lastAttemptAt = Date.now();

  if (state.attempt >= config.maxAttempts) {
    state.exhausted = true;
    return null;
  }

  const delay = calculateDelay(state.attempt, config);
  state.nextAttemptAt = Date.now() + delay;
  return delay;
}

/**
 * Check whether the next retry is due (enough time has passed since last attempt).
 */
export function isRetryDue(state: BackoffState): boolean {
  if (state.exhausted) return false;
  return Date.now() >= state.nextAttemptAt;
}

/**
 * Reset backoff to initial state (e.g., after a successful send).
 */
export function resetBackoff(state: BackoffState): void {
  state.attempt = 0;
  state.lastAttemptAt = 0;
  state.nextAttemptAt = Date.now();
  state.exhausted = false;
}

/**
 * Get the remaining wait time in ms. Returns 0 if retry is due.
 */
export function remainingWaitMs(state: BackoffState): number {
  return Math.max(0, state.nextAttemptAt - Date.now());
}

/**
 * Backoff tracker — manages backoff state per-resource (message, lead, sequence).
 *
 * Used by the dispatcher to track retry state across worker restarts.
 */
export class BackoffTracker {
  private states = new Map<string, BackoffState>();
  private config: BackoffConfig;

  constructor(config: Partial<BackoffConfig> = {}) {
    this.config = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  }

  /** Get or create backoff state for a key */
  get(key: string): BackoffState {
    let state = this.states.get(key);
    if (!state) {
      state = createBackoffState();
      this.states.set(key, state);
    }
    return state;
  }

  /** Check if a key can be retried now */
  canRetry(key: string): boolean {
    const state = this.get(key);
    return isRetryDue(state);
  }

  /** Record a failure and get the delay before next attempt */
  recordFailure(key: string): number | null {
    const state = this.get(key);
    return advanceBackoff(state, this.config);
  }

  /** Record a success — resets backoff */
  recordSuccess(key: string): void {
    const state = this.states.get(key);
    if (state) resetBackoff(state);
  }

  /** Move a key to exhausted (DLQ) */
  markExhausted(key: string): void {
    const state = this.get(key);
    state.exhausted = true;
  }

  /** Check if a key is exhausted */
  isExhausted(key: string): boolean {
    return this.get(key).exhausted;
  }

  /** Remove a key (cleanup) */
  delete(key: string): void {
    this.states.delete(key);
  }

  /** Number of tracked backoffs */
  get size(): number {
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
  }
}

/** Singleton backoff tracker for dispatcher messages */
let defaultBackoffTracker: BackoffTracker | null = null;

export function getBackoffTracker(config?: Partial<BackoffConfig>): BackoffTracker {
  if (!defaultBackoffTracker) {
    defaultBackoffTracker = new BackoffTracker(config);
  }
  return defaultBackoffTracker;
}

export function resetBackoffTracker(): void {
  defaultBackoffTracker?.clear();
  defaultBackoffTracker = null;
}