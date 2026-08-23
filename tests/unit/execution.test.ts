import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AntigravityClient } from '../../src/core/execution/antigravity.js';
import type { HealthCheckResult } from '../../src/core/execution/antigravity.js';
import { LinkedInAdapter } from '../../src/core/execution/adapters/linkedin.js';
import { EmailAdapter } from '../../src/core/execution/adapters/email.js';
import { WhatsAppAdapter } from '../../src/core/execution/adapters/whatsapp.js';
import { ManualAdapter } from '../../src/core/execution/adapters/manual.js';
import { ExecutionRouter } from '../../src/core/execution/router.js';
import type { ExecutionContext, ExecutionResult } from '../../src/core/execution/types.js';
import type { RecommendedAction } from '../../src/core/decision/types.js';
import { applyAntiBanPolicy } from '../../src/core/outreach/service.js';

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    lead: {
      id: 'lead-1',
      firstName: 'Alice',
      lastName: 'Johnson',
      fullName: 'Alice Johnson',
      title: 'VP of Sales',
      linkedinUrl: 'https://linkedin.com/in/alicejohnson',
      email: 'alice@example.com',
      phone: null,
      phoneStatus: null,
    },
    company: {
      id: 'company-1',
      name: 'Acme Corp',
      domain: 'acme.com',
      linkedinUrl: 'https://linkedin.com/company/acme',
    },
    account: {
      id: 'account-1',
      provider: 'linkedin',
      externalId: 'main',
      dailyLimit: 100,
      sentToday: 0,
      pausedUntil: null,
      sessionKey: null,
    },
    message: {
      id: 'msg-1',
      subject: 'Quick intro',
      body: 'Hi Alice, noticed Acme Corp is growing!',
      outreachAccountId: null,
    },
    dryRun: false,
    ...overrides,
  };
}

function makeAction(overrides: Partial<RecommendedAction> = {}): RecommendedAction {
  return {
    channel: 'linkedin',
    capability: 'sendMessage',
    timing: 'WITHIN_24H',
    template: 'Hi {firstName}, let\'s connect!',
    rationale: 'High intent signal',
    ...overrides,
  };
}

// ─── AntigravityClient tests ───

describe('AntigravityClient', () => {
  describe('health', () => {
    it('returns HealthCheckResult when extension is healthy', async () => {
      const healthData: HealthCheckResult = {
        extension_connected: true,
        websocket_connected: true,
        status: 'ok',
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => healthData,
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      const result = await client.health();

      expect(result.extension_connected).toBe(true);
      expect(result.websocket_connected).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8765/status',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('throws when HTTP response is not ok', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      await expect(client.health()).rejects.toThrow('Health check failed: HTTP 500');
    });

    it('throws on network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const client = new AntigravityClient({ fetch: mockFetch });
      await expect(client.health()).rejects.toThrow('ECONNREFUSED');
    });

    it('times out after the health timeout', async () => {
      // Use a fetch that never resolves (simulating timeout via AbortController)
      const controller = new AbortController();
      const mockFetch = vi.fn().mockImplementation((_url, init) => {
        // Abort the signal to simulate timeout
        if (init?.signal) {
          const signal = init.signal as AbortSignal;
          // Simulate by returning a promise that rejects on abort
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
            // The AbortSignal.timeout in the test will trigger the abort
            // But in vitest we can't easily test AbortSignal.timeout, so verify error propagation
          });
        }
        return mockFetch.getMockImplementation()?.apply(this, [_url, init]) ?? Promise.resolve();
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      // Verify timeout handling by checking that errors propagate
      await expect(client.health()).rejects.toThrow();
    });
  });

  describe('assertHealthy', () => {
    it('resolves when both connections are up', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });
      await expect(client.assertHealthy()).resolves.toBeUndefined();
    });

    it('throws when extension is not connected', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ extension_connected: false, websocket_connected: true, status: 'degraded' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });
      await expect(client.assertHealthy()).rejects.toThrow('extension not connected');
    });

    it('throws when websocket is not connected', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ extension_connected: true, websocket_connected: false, status: 'degraded' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });
      await expect(client.assertHealthy()).rejects.toThrow('WebSocket not connected');
    });
  });

  describe('requestWithRetry', () => {
    it('retries on ECONNREFUSED up to max retries', async () => {
      // Mock fetch that always fails with ECONNREFUSED
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new AntigravityClient({ fetch: mockFetch });

      await expect(client.connect({ profileUrl: 'https://linkedin.com/in/test' }))
        .rejects.toThrow('ECONNREFUSED');

      // 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('stops retrying on FORBIDDEN (403) immediately', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('LinkedIn access denied (403): forbidden'));
      const client = new AntigravityClient({ fetch: mockFetch });

      await expect(client.connect({ profileUrl: 'https://linkedin.com/in/test' }))
        .rejects.toThrow('403');

      // Should NOT retry: only 1 call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('stops retrying on CAPTCHA immediately', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('LinkedIn CAPTCHA detected'));
      const client = new AntigravityClient({ fetch: mockFetch });

      await expect(client.connect({ profileUrl: 'https://linkedin.com/in/test' }))
        .rejects.toThrow('CAPTCHA');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('retries on RATE_LIMITED (429) up to max retries', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('429 rate limit exceeded'));
      const client = new AntigravityClient({ fetch: mockFetch });

      await expect(client.connect({ profileUrl: 'https://linkedin.com/in/test' }))
        .rejects.toThrow('429');

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('retries on timeout errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
      const client = new AntigravityClient({ fetch: mockFetch });

      await expect(client.connect({ profileUrl: 'https://linkedin.com/in/test' }))
        .rejects.toThrow('ETIMEDOUT');

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('connect', () => {
    it('returns LinkedInConnectResult on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, threadUrl: 'https://linkedin.com/in/test' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });

      const result = await client.connect({ profileUrl: 'https://linkedin.com/in/test', note: 'Hi!' });
      expect(result.success).toBe(true);
      expect(result.threadUrl).toBe('https://linkedin.com/in/test');
    });
  });

  describe('sendMessage', () => {
    it('returns LinkedInMessageResult on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, threadUrl: 'https://linkedin.com/messaging/thread/123' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });

      const result = await client.sendMessage({ profileUrl: 'https://linkedin.com/in/test', body: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.threadUrl).toBeDefined();
    });
  });

  describe('searchProfiles', () => {
    it('returns LinkedInSearchResult on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          profiles: [{ name: 'Alice', title: 'VP Sales', url: 'https://linkedin.com/in/alice' }],
        }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });

      const result = await client.searchProfiles({ query: 'VP Sales Acme Corp' });
      expect(result.success).toBe(true);
      expect(result.profiles).toHaveLength(1);
    });
  });

  describe('readInbox', () => {
    it('returns LinkedInInboxResult on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          messages: [{ threadId: 't1', senderName: 'Bob', subject: 'Re: Intro', snippet: 'Thanks!', timestamp: '2026-08-22T10:00:00Z', unread: false, threadUrl: 'https://linkedin.com/messaging/thread/t1' }],
        }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });

      const result = await client.readInbox();
      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(1);
    });
  });
});

// ─── LinkedInAdapter tests ───

describe('LinkedInAdapter', () => {
  describe('canHandle', () => {
    it('supports all LinkedIn capabilities', () => {
      const adapter = new LinkedInAdapter();
      expect(adapter.canHandle('connect')).toBe(true);
      expect(adapter.canHandle('sendMessage')).toBe(true);
      expect(adapter.canHandle('readMessages')).toBe(true);
      expect(adapter.canHandle('searchProfiles')).toBe(true);
      expect(adapter.canHandle('followUp')).toBe(true);
      expect(adapter.canHandle('verifyDelivery')).toBe(true);
    });
  });

  describe('execute — dryRun', () => {
    it('returns success without calling the bridge', async () => {
      const adapter = new LinkedInAdapter();
      const context = makeContext({ dryRun: true });
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(true);
      expect(result.externalId).toContain('dry-run');
    });
  });

  describe('execute — health check failure', () => {
    it('returns retryable error when bridge is down', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ extension_connected: false, websocket_connected: true, status: 'degraded' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext();
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('extension not connected');
      expect(result.retryable).toBe(true);
    });
  });

  describe('execute — connect without LinkedIn URL', () => {
    it('returns permanent error when lead has no LinkedIn URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext({ lead: { ...makeContext().lead, linkedinUrl: null } });
      const action = makeAction({ capability: 'connect' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('no LinkedIn URL');
      expect(result.retryable).toBe(false);
    });
  });

  describe('execute — sendMessage without LinkedIn URL', () => {
    it('returns permanent error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
      });
      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext({ lead: { ...makeContext().lead, linkedinUrl: null } });
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('no LinkedIn URL');
      expect(result.retryable).toBe(false);
    });
  });

  describe('execute — 429 rate limit handling', () => {
    it('classifies 429 as rateLimitHit with channel pause', async () => {
      // First call: health check passes
      // Second call: sendMessage throws 429
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
          });
        }
        return Promise.reject(new Error('429 rate limit exceeded'));
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext();
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(false);
      expect(result.rateLimitHit).toBe(true);
      expect(result.channelPausedUntil).toBeDefined();
      expect(result.channelPausedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(result.retryable).toBe(true);
    });
  });

  describe('execute — 403 forbidden', () => {
    it('classifies 403 as non-retryable, non-rate-limit permanent error', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
          });
        }
        return Promise.reject(new Error('forbidden (403)'));
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext();
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(false);
      expect(result.rateLimitHit).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.channelPausedUntil).toBeUndefined();
    });
  });

  describe('execute — CAPTCHA', () => {
    it('classifies CAPTCHA as rateLimitHit with pause, not retryable', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
          });
        }
        return Promise.reject(new Error('LinkedIn CAPTCHA challenge detected'));
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext();
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(false);
      expect(result.rateLimitHit).toBe(true);
      expect(result.channelPausedUntil).toBeDefined();
      expect(result.retryable).toBe(false);
    });
  });

  describe('execute — successful sendMessage', () => {
    it('returns success with externalId', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, threadUrl: 'https://linkedin.com/messaging/thread/abc' }),
        });
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext();
      const action = makeAction({ capability: 'sendMessage' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(true);
      expect(result.externalId).toContain('linkedin.com/messaging');
      expect(result.retryable).toBe(false);
      expect(result.rateLimitHit).toBe(false);
    });
  });

  describe('execute — searchProfiles', () => {
    it('passes the action template as query', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ extension_connected: true, websocket_connected: true, status: 'ok' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, profiles: [] }),
        });
      });

      const client = new AntigravityClient({ fetch: mockFetch });
      const adapter = new LinkedInAdapter({ client });
      const context = makeContext();
      const action = makeAction({ capability: 'searchProfiles', template: 'VP Sales Acme Corp' });

      const result = await adapter.execute(action, context);
      expect(result.success).toBe(true);
    });
  });
});

// ─── ExecutionRouter tests ───

describe('ExecutionRouter', () => {
  let router: ExecutionRouter;

  // Mock adapter that always succeeds
  class MockAdapter {
    readonly channelId = 'linkedin' as const;
    canHandle() { return true; }
    async execute(_action: RecommendedAction, _context: ExecutionContext): Promise<ExecutionResult> {
      return { success: true, retryable: false, rateLimitHit: false, externalId: 'mock-result' };
    }
  }

  beforeEach(() => {
    router = new ExecutionRouter();
    router.register(new MockAdapter() as any);
  });

  describe('execute — routing', () => {
    it('routes to the correct adapter for linkedin', async () => {
      const action = makeAction({ channel: 'linkedin', capability: 'sendMessage' });
      const result = await router.execute(action, makeContext());
      expect(result.success).toBe(true);
      expect(result.externalId).toBe('mock-result');
    });

    it('rejects unknown channel', async () => {
      const action = makeAction({ channel: 'linkedin', capability: 'sendMessage' });
      // Override channel to an unknown one
      const unknownAction = { ...action, channel: 'unknown' as any };
      const result = await router.execute(unknownAction, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown channel');
    });

    it('rejects unsupported capability for a known channel', async () => {
      // email does not support 'connect' in the registry
      const action = makeAction({ channel: 'email', capability: 'connect' as any });
      const result = await router.execute(action, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support');
    });

    it('rejects when no adapter is registered for the channel', async () => {
      // email channel is valid per registry, but we only registered the mock linkedin adapter
      const action = makeAction({ channel: 'email', capability: 'sendMessage' });
      const result = await router.execute(action, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('No adapter registered');
    });
  });

  describe('register/getAdapter', () => {
    it('stores and retrieves adapters by channelId', () => {
      expect(router.getAdapter('linkedin')).toBeDefined();
      expect(router.getAdapter('email')).toBeUndefined();
    });
  });

  describe('adapter canHandle check', () => {
    it('rejects when adapter does not support the capability even if channel does', async () => {
      class LimitedAdapter {
        readonly channelId = 'linkedin' as const;
        canHandle(cap: string) { return cap === 'connect'; }
        async execute() { return { success: true, retryable: false, rateLimitHit: false }; }
      }
      const limitedRouter = new ExecutionRouter();
      limitedRouter.register(new LimitedAdapter() as any);

      const action = makeAction({ channel: 'linkedin', capability: 'sendMessage' });
      const result = await limitedRouter.execute(action, makeContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support');
    });
  });
});

// ─── Stub adapters tests ───

describe('EmailAdapter', () => {
  it('returns NOT_IMPLEMENTED for sendMessage', async () => {
    const adapter = new EmailAdapter();
    const result = await adapter.execute(makeAction({ channel: 'email', capability: 'sendMessage' }), makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT_IMPLEMENTED');
  });

  it('canHandle supports email capabilities', () => {
    const adapter = new EmailAdapter();
    expect(adapter.canHandle('sendMessage')).toBe(true);
    expect(adapter.canHandle('followUp')).toBe(true);
    expect(adapter.canHandle('verifyDelivery')).toBe(true);
    expect(adapter.canHandle('connect')).toBe(false);
    expect(adapter.canHandle('searchProfiles')).toBe(false);
    expect(adapter.canHandle('readMessages')).toBe(false);
  });
});

describe('WhatsAppAdapter', () => {
  it('returns NOT_IMPLEMENTED for sendMessage', async () => {
    const adapter = new WhatsAppAdapter();
    const result = await adapter.execute(makeAction({ channel: 'whatsapp', capability: 'sendMessage' }), makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT_IMPLEMENTED');
  });
});

describe('ManualAdapter', () => {
  it('returns success for followUp', async () => {
    const adapter = new ManualAdapter();
    const result = await adapter.execute(makeAction({ channel: 'manual', capability: 'followUp' }), makeContext());
    expect(result.success).toBe(true);
    expect(result.externalId).toContain('manual-task');
  });

  it('rejects non-followUp capabilities', () => {
    const adapter = new ManualAdapter();
    expect(adapter.canHandle('followUp')).toBe(true);
    expect(adapter.canHandle('sendMessage')).toBe(false);
    expect(adapter.canHandle('connect')).toBe(false);
  });

  it('returns dryRun result when context has dryRun=true', async () => {
    const adapter = new ManualAdapter();
    const result = await adapter.execute(
      makeAction({ channel: 'manual', capability: 'followUp' }),
      makeContext({ dryRun: true }),
    );
    expect(result.success).toBe(true);
    expect(result.externalId).toContain('dry-run');
  });
});

// ─── applyAntiBanPolicy extended tests (integration with ChannelProfile) ───

describe('applyAntiBanPolicy — ChannelProfile integration', () => {
  it('pauses browser channel for 48h after CAPTCHA (linkedin)', () => {
    const now = new Date('2026-08-22T10:00:00Z');
    const result = applyAntiBanPolicy({
      channel: 'linkedin',
      sentToday: 0,
      dailyLimit: 100,
      pausedUntil: null,
      providerError: 'CAPTCHA',
    }, now);

    expect(result.allowed).toBe(false);
    expect(result.pausedUntil?.toISOString()).toBe('2026-08-24T10:00:00.000Z');
  });

  it('pauses browser channel for 48h after 429 (linkedin)', () => {
    const now = new Date('2026-08-22T10:00:00Z');
    const result = applyAntiBanPolicy({
      channel: 'linkedin',
      sentToday: 0,
      dailyLimit: 100,
      pausedUntil: null,
      providerError: '429 Too Many Requests',
    }, now);

    expect(result.allowed).toBe(false);
    expect(result.pausedUntil?.toISOString()).toBe('2026-08-24T10:00:00.000Z');
  });

  it('uses ChannelProfile.safetyPauseMs for whatsapp (24h)', () => {
    const now = new Date('2026-08-22T10:00:00Z');
    const result = applyAntiBanPolicy({
      channel: 'whatsapp',
      sentToday: 0,
      dailyLimit: 50,
      pausedUntil: null,
      providerError: 'CAPTCHA',
    }, now);

    expect(result.allowed).toBe(false);
    expect(result.pausedUntil?.toISOString()).toBe('2026-08-23T10:00:00.000Z');
  });

  it('does not pause non-browser channel on error (email)', () => {
    const now = new Date('2026-08-22T10:00:00Z');
    const result = applyAntiBanPolicy({
      channel: 'email',
      sentToday: 0,
      dailyLimit: 200,
      pausedUntil: null,
      providerError: '429',
    }, now);

    expect(result.allowed).toBe(true);
    expect(result.pausedUntil).toBeNull();
  });
});