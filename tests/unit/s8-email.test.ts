import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fastify from 'fastify';
import crypto from 'node:crypto';
import { EmailAdapter } from '../../src/core/execution/adapters/email.js';
import { renderEmailTemplate } from '../../src/core/email/template.js';
import { emailTrackingRoutes } from '../../src/api/routes/emailTracking.js';
import { emailWebhookRoutes } from '../../src/api/routes/emailWebhooks.js';
import { processWebhookEvent as processWebhookEventImpl } from '../../src/core/execution/webhookIdempotency.js';
import { computeSvixSignature } from '../../src/api/plugins/webhookAuth.js';
import { buildServer } from '../../src/api/server.js';
import type { ExecutionContext } from '../../src/core/execution/types.js';
import type { RecommendedAction } from '../../src/core/decision/types.js';

// ─────────────────────────── Helpers ───────────────────────────

const EMAIL_ENV_KEYS = [
  'EMAIL_PROVIDER',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'EMAIL_REPLY_TO',
  'EMAIL_FROM_NAME',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_TRACKING_ENABLED',
  'PUBLIC_BASE_URL',
];

afterEach(() => {
  for (const key of EMAIL_ENV_KEYS) delete process.env[key];
});

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    lead: {
      id: 'lead-1',
      firstName: 'Alice',
      lastName: 'Johnson',
      fullName: 'Alice Johnson',
      title: 'VP of Sales',
      linkedinUrl: null,
      email: 'alice@example.com',
      phone: null,
      phoneStatus: null,
    },
    company: {
      id: 'company-1',
      name: 'Acme Corp',
      domain: 'acme.com',
      linkedinUrl: null,
    },
    account: {
      id: 'account-1',
      provider: 'email',
      externalId: 'main',
      dailyLimit: 200,
      sentToday: 0,
      pausedUntil: null,
      sessionKey: null,
    },
    message: {
      id: 'msg-1',
      subject: 'Quick intro',
      body: 'Hi {{firstName}}, Acme Corp here.',
      outreachAccountId: null,
    },
    dryRun: false,
    ...overrides,
  };
}

function makeAction(overrides: Partial<RecommendedAction> = {}): RecommendedAction {
  return {
    channel: 'email',
    capability: 'sendMessage',
    timing: 'WITHIN_24H',
    template: 'Hi {{firstName}}',
    rationale: 'S8 test',
    ...overrides,
  };
}

function resendOkResponse(id: string): { ok: boolean; json: () => Promise<{ id: string }> } {
  return { ok: true, json: async () => ({ id }) };
}

// ─────────────────────────── canHandle ───────────────────────────

describe('EmailAdapter.canHandle', () => {
  it('supports sendMessage, followUp and verifyDelivery', () => {
    const adapter = new EmailAdapter();
    expect(adapter.canHandle('sendMessage')).toBe(true);
    expect(adapter.canHandle('followUp')).toBe(true);
    expect(adapter.canHandle('verifyDelivery')).toBe(true);
  });

  it('rejects connect, searchProfiles and readMessages', () => {
    const adapter = new EmailAdapter();
    expect(adapter.canHandle('connect')).toBe(false);
    expect(adapter.canHandle('searchProfiles')).toBe(false);
    expect(adapter.canHandle('readMessages')).toBe(false);
  });
});

// ─────────────────────────── Provider fallback ───────────────────────────

describe('EmailAdapter provider fallback', () => {
  it('returns NOT_IMPLEMENTED stub when EMAIL_PROVIDER is unset (none)', async () => {
    delete process.env.EMAIL_PROVIDER;
    const adapter = new EmailAdapter();
    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT_IMPLEMENTED');
    expect(result.retryable).toBe(false);
  });

  it('returns NOT_IMPLEMENTED stub when EMAIL_PROVIDER=none', async () => {
    process.env.EMAIL_PROVIDER = 'none';
    const adapter = new EmailAdapter();
    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT_IMPLEMENTED');
  });

  it('logs a warning and returns stub for an unknown EMAIL_PROVIDER', async () => {
    process.env.EMAIL_PROVIDER = 'gmail';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new EmailAdapter();
      const result = await adapter.execute(makeAction(), makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('NOT_IMPLEMENTED');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gmail'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────── dryRun ───────────────────────────

describe('EmailAdapter.execute — dryRun', () => {
  it('returns success without calling the provider', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    const fetchImpl = vi.fn();
    const adapter = new EmailAdapter({ fetchImpl });
    const result = await adapter.execute(makeAction(), makeContext({ dryRun: true }));
    expect(result.success).toBe(true);
    expect(result.externalId).toContain('dry-run');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Resend backend ───────────────────────────

describe('EmailAdapter.execute — Resend', () => {
  it('sends successfully and returns the provider email id', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_NAME = 'Sales Team';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';
    process.env.EMAIL_REPLY_TO = 'reply@example.com';
    process.env.PUBLIC_BASE_URL = 'https://app.example.com';

    const fetchImpl = vi.fn().mockResolvedValue(resendOkResponse('resend-email-1'));
    const adapter = new EmailAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction({ capability: 'followUp' }), makeContext());

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('resend-email-1');
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer re_123',
          'X-Message-ID': 'msg-1',
        }),
      }),
    );

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toEqual(['alice@example.com']);
    // followUp prefixes subject with Re:
    expect(body.subject).toMatch(/^Re: Quick intro/);
    expect(body.from).toContain('Sales Team');
    expect(body.from).toContain('sales@example.com');
    expect(body.reply_to).toBe('reply@example.com');
    expect(body.headers).toEqual({ 'X-Message-ID': 'msg-1' });
    // tracking pixel + click rewriting point at the public base URL
    expect(body.html).toContain('https://app.example.com/api/v1/email/track/open/msg-1');
    expect(body.text).toContain('Hi Alice, Acme Corp here.');
  });

  it('classifies network errors as retryable', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const adapter = new EmailAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.rateLimitHit).toBe(false);
  });

  it('classifies 429 as rateLimitHit with a channel pause', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    });
    const adapter = new EmailAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.rateLimitHit).toBe(true);
    expect(result.channelPausedUntil).toBeDefined();
    // email profile safetyPauseMs = 24h — pause must be far in the future
    expect(result.channelPausedUntil!.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1_000);
    expect(result.retryable).toBe(true);
  });

  it('classifies a hard bounce as non-retryable and flags the lead email INVALID', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: 'Invalid email address' }),
    });
    const markLeadEmailInvalid = vi.fn().mockResolvedValue(undefined);
    const adapter = new EmailAdapter({ fetchImpl, markLeadEmailInvalid });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);
    expect(markLeadEmailInvalid).toHaveBeenCalledWith('lead-1');
  });

  it('does not flag the lead on success', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const fetchImpl = vi.fn().mockResolvedValue(resendOkResponse('resend-email-ok'));
    const markLeadEmailInvalid = vi.fn().mockResolvedValue(undefined);
    const adapter = new EmailAdapter({ fetchImpl, markLeadEmailInvalid });

    await adapter.execute(makeAction(), makeContext());
    expect(markLeadEmailInvalid).not.toHaveBeenCalled();
  });

  it('fails fast when the lead has no email', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_123';
    const fetchImpl = vi.fn();
    const adapter = new EmailAdapter({ fetchImpl });
    const result = await adapter.execute(makeAction(), makeContext({ lead: { ...makeContext().lead, email: null } }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no email');
    expect(result.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('verifyDelivery', () => {
    it('returns success when the provider reports delivered', async () => {
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_123';
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_event: 'delivered' }) });
      const adapter = new EmailAdapter({ fetchImpl, findExternalEmailId: async () => 'resend-email-1' });

      const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
      expect(result.success).toBe(true);
      expect(result.externalId).toBe('resend-email-1');
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.resend.com/emails/resend-email-1',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns non-retryable failure for a bounce', async () => {
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_123';
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ last_event: 'bounced' }) });
      const adapter = new EmailAdapter({ fetchImpl, findExternalEmailId: async () => 'resend-email-1' });

      const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('bounced');
    });

    it('returns retryable failure while the email is still in transit', async () => {
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_123';
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'scheduled' }) });
      const adapter = new EmailAdapter({ fetchImpl, findExternalEmailId: async () => 'resend-email-1' });

      const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
    });
  });
});

// ─────────────────────────── SMTP backend ───────────────────────────

describe('EmailAdapter.execute — SMTP', () => {
  function mockTransport(sendMailImpl: () => Promise<{ messageId?: string }>) {
    const sendMail = vi.fn().mockImplementation(sendMailImpl);
    const close = vi.fn().mockResolvedValue(undefined);
    const createTransport = vi.fn().mockReturnValue({ sendMail, close });
    return { sendMail, close, createTransport };
  }

  it('sends successfully via a mocked transport', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const { sendMail, createTransport } = mockTransport(async () => ({ messageId: '<abc@example.com>' }));
    const adapter = new EmailAdapter({ createTransport });

    const result = await adapter.execute(makeAction(), makeContext());

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('<abc@example.com>');
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587, secure: false }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Quick intro',
        from: 'sales@example.com',
        headers: { 'X-Message-ID': 'msg-1' },
      }),
    );
  });

  it('classifies SMTP auth errors as non-retryable', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'wrong';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const { createTransport } = mockTransport(
      () => Promise.reject(new Error('535 5.7.8 Authentication credentials invalid')),
    );
    const adapter = new EmailAdapter({ createTransport });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);
  });

  it('classifies SMTP timeouts as retryable', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const { createTransport } = mockTransport(() => Promise.reject(new Error('ETIMEDOUT')));
    const adapter = new EmailAdapter({ createTransport });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('classifies hard bounce (550) as non-retryable', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_FROM_ADDRESS = 'sales@example.com';

    const { createTransport } = mockTransport(
      () => Promise.reject(new Error('550 5.1.1 User unknown — address rejected')),
    );
    const markLeadEmailInvalid = vi.fn().mockResolvedValue(undefined);
    const adapter = new EmailAdapter({ createTransport, markLeadEmailInvalid });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('returns success for verifyDelivery (SMTP accepted at send time)', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    const adapter = new EmailAdapter({});

    const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
    expect(result.success).toBe(true);
    expect(result.rateLimitHit).toBe(false);
  });
});

// ─────────────────────────── Template rendering ───────────────────────────

describe('renderEmailTemplate', () => {
  it('substitutes variables and produces HTML + text', () => {
    const rendered = renderEmailTemplate(
      'Subject: Hi {{firstName}} from {{companyName}}\n\nHello {{firstName}}, this is a note from {{companyName}}.',
      { firstName: 'Alice', companyName: 'Acme Corp' },
    );

    expect(rendered.subject).toBe('Hi Alice from Acme Corp');
    expect(rendered.text).toContain('Hello Alice, this is a note from Acme Corp.');
    expect(rendered.html).toContain('Hello Alice, this is a note from Acme Corp.');
    expect(rendered.html).toMatch(/<html><body>/);
    expect(rendered.text).not.toContain('<html>');
  });

  it('truncates subjects longer than 100 chars', () => {
    const longSubject = `Subject: ${'x'.repeat(150)}\n\nBody text`;
    const rendered = renderEmailTemplate(longSubject, {});
    expect(rendered.subject.length).toBe(100);
  });

  it('leaves missing variables as placeholders', () => {
    const rendered = renderEmailTemplate(
      'Subject: Hi {{firstName}}\n\n{{unknownVar}} stays untouched',
      { firstName: 'Bob' },
    );
    expect(rendered.subject).toBe('Hi Bob');
    expect(rendered.text).toContain('{{unknownVar}} stays untouched');
  });

  it('supports the default variable set', () => {
    const rendered = renderEmailTemplate(
      'Subject: {{senderName}} @ {{senderCompany}}\n\n{{signalTitle}}: {{personalizedBody}}',
      {
        senderName: 'Sales',
        senderCompany: 'Acme',
        signalTitle: 'New funding',
        personalizedBody: 'Saw the news!',
      },
    );
    expect(rendered.subject).toBe('Sales @ Acme');
    expect(rendered.text).toContain('New funding: Saw the news!');
  });

  describe('with tracking enabled', () => {
    it('includes a tracking pixel and rewrites links through the redirect proxy', () => {
      const rendered = renderEmailTemplate(
        'Subject: Test\n\nVisit https://example.com/page?ref=1 for details',
        {},
        { trackingEnabled: true, messageId: 'msg-1', baseUrl: 'https://app.example.com' },
      );

      expect(rendered.html).toContain(
        '<img src="https://app.example.com/api/v1/email/track/open/msg-1"',
      );
      expect(rendered.html).toContain(
        'https://app.example.com/api/v1/email/track/click/msg-1?url=',
      );
      expect(rendered.html).toContain(encodeURIComponent('https://example.com/page?ref=1'));
      // plain text must stay clean
      expect(rendered.text).not.toContain('<img');
      expect(rendered.text).not.toContain('/api/v1/email/track/');
    });

    it('omits the pixel and keeps direct links when tracking is disabled', () => {
      const rendered = renderEmailTemplate(
        'Subject: Test\n\nVisit https://example.com/page for details',
        {},
        { trackingEnabled: false, messageId: 'msg-1', baseUrl: 'https://app.example.com' },
      );

      expect(rendered.html).not.toContain('<img');
      expect(rendered.html).not.toContain('/api/v1/email/track/');
      expect(rendered.html).toContain('href="https://example.com/page"');
    });
  });
});

// ─────────────────────────── Tracking endpoints ───────────────────────────

describe('Email tracking endpoints', () => {
  const CAMPAIGN_ID = '00000000-0000-0000-0000-000000000001';
  const LEAD_ID = '00000000-0000-0000-0000-000000000002';
  const MSG_ID = '00000000-0000-0000-0000-000000000003';

  async function buildTrackingApp(recordFeedback = vi.fn(), findMessage = vi.fn(), markEngagement = vi.fn().mockResolvedValue(undefined)) {
    const app = fastify();
    // S14: Inject a no-op idempotency processor so tests don't depend on real DB
    const noopTrackEvent = () =>
      Promise.resolve({ alreadyProcessed: false, invalidTransition: false });
    await app.register(emailTrackingRoutes, {
      analytics: { recordFeedback },
      findMessage,
      markEngagement,
      processTrackingEvent: noopTrackEvent,
    });
    await app.ready();
    return app;
  }

  it('open pixel returns a GIF and records OPEN feedback', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const markEngagement = vi.fn().mockResolvedValue(undefined);
    const app = await buildTrackingApp(recordFeedback, findMessage, markEngagement);
    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/email/track/open/${MSG_ID}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/gif');
      expect(res.headers['cache-control']).toContain('no-store');
      expect((res.rawPayload as Buffer).length).toBeGreaterThan(0);
      expect(recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          campaign_id: CAMPAIGN_ID,
          lead_id: LEAD_ID,
          message_id: MSG_ID,
          interaction_type: 'OPEN',
          provider: 'email',
        }),
      );
      expect(markEngagement).toHaveBeenCalledWith(MSG_ID, 'OPEN');
    } finally {
      await app.close();
    }
  });

  it('click redirect 302s to the original URL and records CLICK feedback', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const markEngagement = vi.fn().mockResolvedValue(undefined);
    const app = await buildTrackingApp(recordFeedback, findMessage, markEngagement);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/email/track/click/${MSG_ID}?url=${encodeURIComponent('https://example.com/target')}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.com/target');
      expect(res.headers['cache-control']).toContain('no-store');
      expect(recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: MSG_ID, interaction_type: 'CLICK' }),
      );
      expect(markEngagement).toHaveBeenCalledWith(MSG_ID, 'CLICK');
    } finally {
      await app.close();
    }
  });

  it('rejects non-http redirect targets', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const app = await buildTrackingApp(recordFeedback, vi.fn());
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/email/track/click/${MSG_ID}?url=${encodeURIComponent('javascript:alert(1)')}`,
      });
      expect(res.statusCode).toBe(400);
      expect(recordFeedback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('still returns the pixel when the message is not found (no feedback recorded)', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const app = await buildTrackingApp(recordFeedback, vi.fn().mockResolvedValue(null));
    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/email/track/open/${MSG_ID}` });
      expect(res.statusCode).toBe(200);
      expect(recordFeedback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('never breaks the pixel when feedback recording fails', async () => {
    const recordFeedback = vi.fn().mockRejectedValue(new Error('DB down'));
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const app = await buildTrackingApp(recordFeedback, findMessage);
    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/email/track/open/${MSG_ID}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/gif');
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────── Resend webhook route ───────────────────────────

describe('Resend email webhook route', () => {
  const CAMPAIGN_ID = '00000000-0000-0000-0000-000000000001';
  const LEAD_ID = '00000000-0000-0000-0000-000000000002';
  const MSG_ID = '00000000-0000-0000-0000-000000000003';

  async function buildWebhookApp(recordFeedback = vi.fn(), findMessage = vi.fn()) {
    const app = fastify();
    // S14: Inject a no-op idempotency processor so tests don't depend on real DB
    const noopProcessEvent = (_payload: any) =>
      Promise.resolve({ alreadyProcessed: false, invalidTransition: false, idempotencyKey: 'test' });
    await app.register(emailWebhookRoutes, {
      analytics: { recordFeedback },
      findMessage,
      processWebhookEvent: noopProcessEvent,
    });
    await app.ready();
    return app;
  }

  function webhookRequest(eventType: string, headers: Record<string, string> = {}) {
    return {
      method: 'POST' as const,
      url: '/api/v1/email/webhooks/resend',
      headers: { 'content-type': 'application/json', 'x-message-id': MSG_ID, ...headers },
      payload: { type: eventType, data: { email_id: 'e1' } },
    };
  }

  it('maps email.delivered to OPEN feedback', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const app = await buildWebhookApp(recordFeedback, findMessage);
    try {
      const res = await app.inject(webhookRequest('email.delivered'));
      expect(res.statusCode).toBe(202);
      expect(recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          campaign_id: CAMPAIGN_ID,
          lead_id: LEAD_ID,
          message_id: MSG_ID,
          interaction_type: 'OPEN',
          provider: 'resend',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('maps email.opened to OPEN and email.clicked to CLICK', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const app = await buildWebhookApp(recordFeedback, findMessage);
    try {
      await app.inject(webhookRequest('email.opened'));
      expect(recordFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ interaction_type: 'OPEN' }));

      await app.inject(webhookRequest('email.clicked'));
      expect(recordFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ interaction_type: 'CLICK' }));
    } finally {
      await app.close();
    }
  });

  it('maps email.bounced to BOUNCE feedback', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const app = await buildWebhookApp(recordFeedback, findMessage);
    try {
      const res = await app.inject(webhookRequest('email.bounced'));
      expect(res.statusCode).toBe(202);
      expect(recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ interaction_type: 'BOUNCE', content: 'bounced' }),
      );
    } finally {
      await app.close();
    }
  });

  it('maps email.complained to OPEN flagged for human review', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const findMessage = vi.fn().mockResolvedValue({ campaignId: CAMPAIGN_ID, leadId: LEAD_ID });
    const app = await buildWebhookApp(recordFeedback, findMessage);
    try {
      const res = await app.inject(webhookRequest('email.complained'));
      expect(res.statusCode).toBe(202);
      expect(recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          interaction_type: 'OPEN',
          sentiment: 'AMBIGUOUS',
          confidence: 0,
          content: expect.stringContaining('SPAM complaint'),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('acknowledges unknown event types without recording feedback', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const app = await buildWebhookApp(recordFeedback, vi.fn());
    try {
      const res = await app.inject(webhookRequest('email.something_else'));
      expect(res.statusCode).toBe(202);
      expect(res.json().ignored).toBe('email.something_else');
      expect(recordFeedback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('acknowledges events with a missing X-Message-ID', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const app = await buildWebhookApp(recordFeedback, vi.fn());
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/email/webhooks/resend',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'email.delivered', data: { email_id: 'e1' } },
      });
      expect(res.statusCode).toBe(202);
      expect(recordFeedback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('acknowledges events for unknown messages without recording feedback', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({ feedbackId: 'f1', requiresHumanReview: false });
    const app = await buildWebhookApp(recordFeedback, vi.fn().mockResolvedValue(null));
    try {
      const res = await app.inject(webhookRequest('email.delivered'));
      expect(res.statusCode).toBe(202);
      expect(recordFeedback).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

// ─────────────────────────── Svix signature validation ───────────────────────────

describe('computeSvixSignature', () => {
  it('is deterministic for the same input', () => {
    expect(computeSvixSignature('msg-1.1234567890.{"a":1}', 'whsec_secret')).toBe(
      computeSvixSignature('msg-1.1234567890.{"a":1}', 'whsec_secret'),
    );
  });

  it('differs for different payloads', () => {
    const a = computeSvixSignature('msg-1.1234567890.payload-a', 'whsec_secret');
    const b = computeSvixSignature('msg-1.1234567890.payload-b', 'whsec_secret');
    expect(a).not.toBe(b);
  });

  it('handles secrets without the whsec_ prefix', () => {
    expect(() => computeSvixSignature('x.y.z', 'plain-secret')).not.toThrow();
  });
});

describe('Resend webhook Svix validation (full server)', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const RESEND_SECRET = 'whsec_test_secret_key_12345';
  const MSG_ID = '00000000-0000-0000-0000-000000000003';
  const ORIGINAL_ENV: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    API_KEYS: process.env.API_KEYS,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = 'sk_test_abc123';
    process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
    app = await buildServer();
    await app.ready();
  });

  beforeEach(() => {
    // The module-level afterEach clears EMAIL_ENV_KEYS after every test — re-seed
    // the webhook secret so signature validation stays active for each test.
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = 'sk_test_abc123';
    process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function signedRequest(body: string) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const id = crypto.randomUUID();
    const sig = computeSvixSignature(`${id}.${ts}.${body}`, RESEND_SECRET);
    return {
      method: 'POST' as const,
      url: 'http://127.0.0.1:3000/api/v1/email/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'x-message-id': MSG_ID,
        'svix-id': id,
        'svix-timestamp': ts,
        'svix-signature': `v1,${sig}`,
      },
      payload: body,
    };
  }

  it('accepts a validly signed webhook (202, not 401)', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } });
    const res = await app.inject(signedRequest(body));
    expect(res.statusCode).toBe(202);
  });

  it('rejects a webhook without Svix headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/v1/email/webhooks/resend',
      headers: { 'content-type': 'application/json', 'x-message-id': MSG_ID },
      payload: JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered signature', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } });
    const request = signedRequest(body);
    // Sign over a different body than the one sent
    const tamperedBody = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e1' } });
    const res = await app.inject({ ...request, payload: tamperedBody });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e1' } });
    const oldTs = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString();
    const id = crypto.randomUUID();
    const sig = computeSvixSignature(`${id}.${oldTs}.${body}`, RESEND_SECRET);
    const res = await app.inject({
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/v1/email/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'x-message-id': MSG_ID,
        'svix-id': id,
        'svix-timestamp': oldTs,
        'svix-signature': `v1,${sig}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});
