/** Type-safe HTTP client for the Antigravity Chrome extension bridge (http://127.0.0.1:8765) */

export interface HealthCheckResult {
  extension_connected: boolean;
  websocket_connected: boolean;
  status: string;
  timestamp?: string;
}

export interface LinkedInConnectInput {
  profileUrl: string;
  note?: string;
  /** Account session key for multi-account support */
  sessionKey?: string;
}

export interface LinkedInConnectResult {
  success: boolean;
  threadUrl?: string;
  error?: string;
}

export interface LinkedInMessageInput {
  profileUrl: string;
  body: string;
  /** Account session key for multi-account support */
  sessionKey?: string;
}

export interface LinkedInMessageResult {
  success: boolean;
  threadUrl?: string;
  externalId?: string;
  error?: string;
}

export interface LinkedInSearchInput {
  query: string;
  /** Maximum number of results to retrieve */
  limit?: number;
  /** Account session key for multi-account support */
  sessionKey?: string;
}

export interface LinkedInSearchResult {
  success: boolean;
  profiles: Array<{ name: string; title: string; url: string; snippet?: string }>;
  error?: string;
}

export interface LinkedInInboxResult {
  success: boolean;
  messages: Array<{
    threadId: string;
    senderName: string;
    subject: string;
    snippet: string;
    timestamp: string;
    unread: boolean;
    threadUrl: string;
  }>;
  error?: string;
}

export type AntigravityErrorCode = 'ECONNREFUSED' | 'TIMEOUT' | 'RATE_LIMITED' | 'CAPTCHA' | 'FORBIDDEN' | 'UNKNOWN';

export interface AntigravityError {
  code: AntigravityErrorCode;
  message: string;
  retryable: boolean;
  rateLimitHit: boolean;
  channelPausedUntil?: Date;
}

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

function classifyError(err: unknown): AntigravityError {
  if (err instanceof Error) {
    const msg = err.message;

    if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
      return { code: 'ECONNREFUSED', message: 'Antigravity bridge not reachable — extension may not be running.', retryable: true, rateLimitHit: false };
    }

    if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('ETIMEDOUT') || msg.includes('aborted')) {
      return { code: 'TIMEOUT', message: 'Request to Antigravity bridge timed out.', retryable: true, rateLimitHit: false };
    }

    if (msg.includes('429') || msg.includes('rate')) {
      const pausedUntil = new Date(Date.now() + 48 * 60 * 60 * 1_000);
      return { code: 'RATE_LIMITED', message: `LinkedIn rate limit: ${msg}`, retryable: true, rateLimitHit: true, channelPausedUntil: pausedUntil };
    }

    if (msg.includes('CAPTCHA') || msg.includes('captcha') || msg.includes('challenge')) {
      const pausedUntil = new Date(Date.now() + 48 * 60 * 60 * 1_000);
      return { code: 'CAPTCHA', message: `LinkedIn CAPTCHA detected: ${msg}`, retryable: false, rateLimitHit: true, channelPausedUntil: pausedUntil };
    }

    if (msg.includes('403') || msg.includes('forbidden')) {
      return { code: 'FORBIDDEN', message: `LinkedIn access denied (403): ${msg}`, retryable: false, rateLimitHit: false };
    }
  }

  return { code: 'UNKNOWN', message: `Unexpected Antigravity error: ${String(err)}`, retryable: true, rateLimitHit: false };
}

export interface AntigravityClientDependencies {
  fetch?: typeof globalThis.fetch;
  /** Base URL of the Antigravity bridge (default: http://127.0.0.1:8765) */
  baseUrl?: string;
}

export class AntigravityClient {
  private readonly baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(deps: AntigravityClientDependencies = {}) {
    this.baseUrl = deps.baseUrl ?? 'http://127.0.0.1:8765';
    this._fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Health check: verifies both extension and websocket are connected */
  async health(): Promise<HealthCheckResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    try {
      const res = await this._fetch(`${this.baseUrl}/status`, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Health check failed: HTTP ${res.status}`);
      }
      const data = await res.json() as HealthCheckResult;
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Assert extension is healthy before proceeding */
  async assertHealthy(): Promise<void> {
    const health = await this.health();
    if (!health.extension_connected) {
      throw new Error('Antigravity extension not connected. Reload the Chrome extension and re-check.');
    }
    if (!health.websocket_connected) {
      throw new Error('Antigravity WebSocket not connected. Reload the Chrome extension tab and re-check.');
    }
  }

  /** Execute a LinkedIn connect request via the bridge */
  async connect(input: LinkedInConnectInput): Promise<LinkedInConnectResult> {
    return this.requestWithRetry<LinkedInConnectResult>(async () => {
      const res = await this.postJson('/linkedin/connect', input);
      const data = await res.json() as LinkedInConnectResult;
      if (!res.ok) throw new Error(`LinkedIn connect failed: HTTP ${res.status} — ${data.error ?? 'unknown'}`);
      return data;
    });
  }

  /** Execute a LinkedIn sendMessage request via the bridge */
  async sendMessage(input: LinkedInMessageInput): Promise<LinkedInMessageResult> {
    return this.requestWithRetry<LinkedInMessageResult>(async () => {
      const res = await this.postJson('/linkedin/message', input);
      const data = await res.json() as LinkedInMessageResult;
      if (!res.ok) throw new Error(`LinkedIn sendMessage failed: HTTP ${res.status} — ${data.error ?? 'unknown'}`);
      return data;
    });
  }

  /** Execute a LinkedIn search request via the bridge */
  async searchProfiles(input: LinkedInSearchInput): Promise<LinkedInSearchResult> {
    return this.requestWithRetry<LinkedInSearchResult>(async () => {
      const res = await this.postJson('/linkedin/search', input);
      const data = await res.json() as LinkedInSearchResult;
      if (!res.ok) throw new Error(`LinkedIn search failed: HTTP ${res.status} — ${data.error ?? 'unknown'}`);
      return data;
    });
  }

  /** Read LinkedIn inbox messages via the bridge */
  async readInbox(): Promise<LinkedInInboxResult> {
    return this.requestWithRetry<LinkedInInboxResult>(async () => {
      const res = await this._fetch(`${this.baseUrl}/linkedin/inbox`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: this.timeoutSignal(),
      });
      const data = await res.json() as LinkedInInboxResult;
      if (!res.ok) throw new Error(`LinkedIn inbox read failed: HTTP ${res.status} — ${data.error ?? 'unknown'}`);
      return data;
    });
  }

  // ─── Private helpers ───

  private timeoutSignal(timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
    return AbortSignal.timeout(timeoutMs);
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    return this._fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.timeoutSignal(),
    });
  }

  private async requestWithRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const classified = classifyError(err);
        // Don't retry permanent errors (FORBIDDEN, CAPTCHA)
        if (!classified.retryable && classified.code !== 'RATE_LIMITED') {
          throw err;
        }
        if (attempt < retries) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }
    throw lastError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}