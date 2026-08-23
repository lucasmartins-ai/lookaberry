import { describe, expect, it, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import fastify from 'fastify';
import crypto from 'node:crypto';
import { WhatsAppAdapter, WhatsAppProviderError } from '../../src/core/execution/adapters/whatsapp.js';
import { renderSimpleTemplate } from '../../src/core/whatsapp/template.js';
import { whatsappWebhookRoutes } from '../../src/api/routes/whatsappWebhooks.js';
import type { ExecutionContext } from '../../src/core/execution/types.js';
import type { RecommendedAction } from '../../src/core/decision/types.js';

// ─────────────────────────── Helpers ───────────────────────────

const WHATSAPP_ENV_KEYS = [
  'WHATSAPP_API_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_API_VERSION',
  'WHATSAPP_TEMPLATE_NAME',
  'WHATSAPP_TEMPLATE_LANGUAGE',
  'WHATSAPP_FOLLOWUP_TEMPLATE_NAME',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_COUNTRY_CODE',
];

function setWhatsAppEnv(overrides: Record<string, string> = {}) {
  process.env.WHATSAPP_API_TOKEN = overrides.WHATSAPP_API_TOKEN ?? 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = overrides.WHATSAPP_PHONE_NUMBER_ID ?? '123456789';
  process.env.WHATSAPP_API_VERSION = overrides.WHATSAPP_API_VERSION ?? 'v21.0';
  process.env.WHATSAPP_TEMPLATE_NAME = overrides.WHATSAPP_TEMPLATE_NAME ?? 'outreach_intro';
  process.env.WHATSAPP_TEMPLATE_LANGUAGE = overrides.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en';
  process.env.WHATSAPP_COUNTRY_CODE = overrides.WHATSAPP_COUNTRY_CODE ?? '55';
  if (overrides.WHATSAPP_FOLLOWUP_TEMPLATE_NAME !== undefined) {
    process.env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME = overrides.WHATSAPP_FOLLOWUP_TEMPLATE_NAME;
  }
}

afterEach(() => {
  for (const key of WHATSAPP_ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
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
      phone: '+5511987654321',
      phoneStatus: 'UNVERIFIED',
    },
    company: {
      id: 'company-1',
      name: 'Acme Corp',
      domain: 'acme.com',
      linkedinUrl: null,
    },
    account: {
      id: 'account-1',
      provider: 'whatsapp',
      externalId: 'main',
      dailyLimit: 50,
      sentToday: 0,
      pausedUntil: null,
      sessionKey: null,
    },
    message: {
      id: 'msg-1',
      subject: null,
      body: 'Hi {{firstName}}, from {{companyName}}!',
      outreachAccountId: null,
    },
    dryRun: false,
    ...overrides,
  };
}

function makeAction(overrides: Partial<RecommendedAction> = {}): RecommendedAction {
  return {
    channel: 'whatsapp',
    capability: 'sendMessage',
    timing: 'WITHIN_24H',
    template: 'Hi {{firstName}}',
    rationale: 'S9 test',
    ...overrides,
  };
}

function okResponse(json: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return { ok: true, json: async () => json };
}

function errorResponse(status: number, body: string): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: false, status, text: async () => body };
}

// ─────────────────────────── Template rendering ───────────────────────────

describe('renderSimpleTemplate', () => {
  it('substitutes firstName and companyName', () => {
    const result = renderSimpleTemplate('Hi {{firstName}} from {{companyName}}', {
      firstName: 'Alice',
      companyName: 'Acme Corp',
    });
    expect(result).toBe('Hi Alice from Acme Corp');
  });

  it('leaves unknown variables untouched', () => {
    const result = renderSimpleTemplate('{{unknown}} stays', { firstName: 'Alice' });
    expect(result).toBe('{{unknown}} stays');
  });
});

// ─────────────────────────── canHandle ───────────────────────────

describe('WhatsAppAdapter.canHandle', () => {
  it('accepts sendMessage, followUp, verifyDelivery, readMessages', () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter.canHandle('sendMessage')).toBe(true);
    expect(adapter.canHandle('followUp')).toBe(true);
    expect(adapter.canHandle('verifyDelivery')).toBe(true);
    expect(adapter.canHandle('readMessages')).toBe(true);
  });

  it('rejects connect and searchProfiles', () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter.canHandle('connect')).toBe(false);
    expect(adapter.canHandle('searchProfiles')).toBe(false);
  });
});

// ─────────────────────────── Stub fallback ───────────────────────────

describe('WhatsAppAdapter stub fallback', () => {
  it('returns NOT_IMPLEMENTED when WHATSAPP_API_TOKEN is empty', async () => {
    delete process.env.WHATSAPP_API_TOKEN;
    const adapter = new WhatsAppAdapter();
    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT_IMPLEMENTED');
    expect(result.retryable).toBe(false);
  });
});

// ─────────────────────────── dryRun ───────────────────────────

describe('WhatsAppAdapter.execute — dryRun', () => {
  it('returns success without calling the API', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn();
    const adapter = new WhatsAppAdapter({ fetchImpl });
    const result = await adapter.execute(makeAction(), makeContext({ dryRun: true }));
    expect(result.success).toBe(true);
    expect(result.externalId).toContain('dry-run:whatsapp:sendMessage:lead-1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── sendMessage — success ───────────────────────────

describe('WhatsAppAdapter.execute — sendMessage', () => {
  it('sends a template message and returns wamid as externalId', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-123' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('wamid-123');
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/123456789/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+5511987654321');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('outreach_intro');
    expect(body.template.language).toEqual({ code: 'en' });
    expect(body.template.components[0].parameters[0]).toEqual({
      type: 'text',
      text: 'Hi Alice, from Acme Corp!',
    });
  });

  it('normalizes a bare national number to E.164 with WHATSAPP_COUNTRY_CODE', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-456' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    await adapter.execute(makeAction(), makeContext({
      lead: { ...makeContext().lead, phone: '11987654321' },
    }));

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toBe('+5511987654321');
  });

  it('keeps an E.164 number as-is', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-789' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    await adapter.execute(makeAction(), makeContext({
      lead: { ...makeContext().lead, phone: '+14155552671' },
    }));

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toBe('+14155552671');
  });

  it('fails fast when the lead has no phone number', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn();
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext({
      lead: { ...makeContext().lead, phone: null },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no phone');
    expect(result.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails fast when no template name is configured', async () => {
    setWhatsAppEnv({ WHATSAPP_TEMPLATE_NAME: '' });
    const fetchImpl = vi.fn();
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('template');
    expect(result.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('followUp uses the followup template name with fallback to main', async () => {
    setWhatsAppEnv({ WHATSAPP_FOLLOWUP_TEMPLATE_NAME: 'outreach_followup' });
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-fu' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    await adapter.execute(makeAction({ capability: 'followUp' }), makeContext());
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.template.name).toBe('outreach_followup');
  });

  it('followUp falls back to the main template when no followup template is set', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-fu2' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    await adapter.execute(makeAction({ capability: 'followUp' }), makeContext());
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.template.name).toBe('outreach_intro');
  });

  it('readMessages returns success with an empty list', async () => {
    setWhatsAppEnv();
    const adapter = new WhatsAppAdapter({});
    const result = await adapter.execute(makeAction({ capability: 'readMessages' }), makeContext());
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────── Error classification ───────────────────────────

describe('WhatsAppAdapter error classification', () => {
  it('classifies network errors as retryable', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.rateLimitHit).toBe(false);
  });

  it('classifies 429 as rateLimitHit with a 24h channel pause', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(429, 'Rate limit exceeded'));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.rateLimitHit).toBe(true);
    expect(result.channelPausedUntil).toBeDefined();
    // WhatsApp profile safetyPauseMs = 24h
    expect(result.channelPausedUntil!.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1_000);
    expect(result.retryable).toBe(true);
  });

  it('marks invalid phone numbers (code 131026) as non-retryable and sets phoneStatus INVALID', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(
      400,
      JSON.stringify({ error: { code: 131026, message: 'Message Undeliverable' } }),
    ));
    const markLeadPhoneInvalid = vi.fn().mockResolvedValue(undefined);
    const adapter = new WhatsAppAdapter({ fetchImpl, markLeadPhoneInvalid });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);
    expect(markLeadPhoneInvalid).toHaveBeenCalledWith('lead-1');
  });

  it('marks invalid phone numbers (code 131047) as non-retryable', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(
      400,
      JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }),
    ));
    const markLeadPhoneInvalid = vi.fn().mockResolvedValue(undefined);
    const adapter = new WhatsAppAdapter({ fetchImpl, markLeadPhoneInvalid });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(markLeadPhoneInvalid).toHaveBeenCalledWith('lead-1');
  });

  it('classifies auth errors (401) as non-retryable config errors', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(401, 'Unauthorized'));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);
  });

  it('classifies template errors (code 131030) as non-retryable', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(
      400,
      JSON.stringify({ error: { code: 131030, message: 'Recipient phone number not in allowed list' } }),
    ));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    const result = await adapter.execute(makeAction(), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.rateLimitHit).toBe(false);
  });

  it('does not flag the lead phone on success', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-ok' }] }));
    const markLeadPhoneInvalid = vi.fn().mockResolvedValue(undefined);
    const adapter = new WhatsAppAdapter({ fetchImpl, markLeadPhoneInvalid });

    await adapter.execute(makeAction(), makeContext());
    expect(markLeadPhoneInvalid).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── verifyDelivery ───────────────────────────

describe('WhatsAppAdapter verifyDelivery', () => {
  it('returns success when the status is delivered', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'delivered' }));
    const adapter = new WhatsAppAdapter({
      fetchImpl,
      findExternalWamid: async () => 'wamid-123',
    });

    const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
    expect(result.success).toBe(true);
    expect(result.externalId).toBe('wamid-123');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/wamid-123?fields=status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('accepts read and sent as success', async () => {
    setWhatsAppEnv();
    for (const status of ['read', 'sent']) {
      const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status }));
      const adapter = new WhatsAppAdapter({ fetchImpl, findExternalWamid: async () => 'wamid-x' });
      const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
      expect(result.success).toBe(true);
    }
  });

  it('returns non-retryable failure for status failed', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'failed' }));
    const adapter = new WhatsAppAdapter({ fetchImpl, findExternalWamid: async () => 'wamid-f' });

    const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('failed');
  });

  it('returns retryable failure for unknown status', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ status: 'pending' }));
    const adapter = new WhatsAppAdapter({ fetchImpl, findExternalWamid: async () => 'wamid-p' });

    const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('fails when no wamid is found for the message', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn();
    const adapter = new WhatsAppAdapter({ fetchImpl, findExternalWamid: async () => null });

    const result = await adapter.execute(makeAction({ capability: 'verifyDelivery' }), makeContext());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── WhatsAppProviderError ───────────────────────────

describe('WhatsAppProviderError', () => {
  it('carries status and metaErrorCode', () => {
    const err = new WhatsAppProviderError('bad', 400, 131026);
    expect(err.status).toBe(400);
    expect(err.metaErrorCode).toBe(131026);
    expect(err.name).toBe('WhatsAppProviderError');
  });
});

// ─────────────────────────── E.164 normalization (exported helper) ───────────────────────────

describe('E.164 normalization', () => {
  it('normalizes digits without + using country code', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'w' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    await adapter.execute(makeAction(), makeContext({
      lead: { ...makeContext().lead, phone: '(11) 98765-4321' },
    }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toBe('+5511987654321');
  });

  it('handles a number already containing +55', async () => {
    setWhatsAppEnv();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'w' }] }));
    const adapter = new WhatsAppAdapter({ fetchImpl });

    await adapter.execute(makeAction(), makeContext({
      lead: { ...makeContext().lead, phone: '+55 11 98765-4321' },
    }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.to).toBe('+55 11 98765-4321');
  });
});

// ─────────────────────────── Webhook route (handshake + POST) ───────────────────────────

describe('WhatsApp webhook route', () => {
  const MSG_ID = '00000000-0000-0000-0000-000000000003';

  async function buildWebhookApp() {
    const app = fastify();
    await app.register(whatsappWebhookRoutes);
    await app.ready();
    return app;
  }

  describe('POST — signature validation (via webhookAuth, tested at unit level here)', () => {
    it('acks with 200 and ok for a valid messages event', async () => {
      const app = await buildWebhookApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/whatsapp',
          headers: { 'content-type': 'application/json' },
          payload: {
            object: 'whatsapp_business_account',
            entry: [{
              id: 'entry-1',
              changes: [{
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '5511987654321', phone_number_id: '123' },
                  messages: [{ from: '5511987654321', id: 'wamid-in', timestamp: '123', type: 'text', text: { body: 'Thanks!' } }],
                },
              }],
            }],
          },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('ok');
      } finally {
        await app.close();
      }
    });

    it('acks with 200 even for an empty/unknown object', async () => {
      const app = await buildWebhookApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/whatsapp',
          headers: { 'content-type': 'application/json' },
          payload: { object: 'unknown', entry: [] },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('acks with 200 for status updates', async () => {
      const app = await buildWebhookApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/whatsapp',
          headers: { 'content-type': 'application/json' },
          payload: {
            object: 'whatsapp_business_account',
            entry: [{
              id: 'entry-2',
              changes: [{
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '5511987654321', phone_number_id: '123' },
                  statuses: [{ id: 'wamid-out', status: 'delivered', timestamp: '123', recipient_id: '5511987654321' }],
                },
              }],
            }],
          },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });
});

// ─────────────────────────── X-Hub-Signature-256 (full server) ───────────────────────────

describe('WhatsApp webhook signature validation (full server)', () => {
  let app: Awaited<ReturnType<typeof import('../../src/api/server.js').buildServer>>;
  const APP_SECRET = 'test-app-secret';
  const ORIGINAL_ENV: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    API_KEYS: process.env.API_KEYS,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = 'sk_test_abc123';
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function signBody(body: string): string {
    return crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
  }

  it('accepts a validly signed webhook (200)', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'e1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '5511', phone_number_id: '123' },
            messages: [{ from: '5511', id: 'w1', timestamp: '1', type: 'text', text: { body: 'hi' } }],
          },
        }],
      }],
    });

    const res = await app.inject({
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/v1/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signBody(body)}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a webhook with an invalid signature (401)', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await app.inject({
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/v1/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a webhook without the signature header (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/v1/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered payload (401)', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const tampered = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'evil' }] });
    const res = await app.inject({
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/v1/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signBody(body)}`,
      },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
  });

  it('handles the GET verification handshake with a valid verify token', async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-token-123';
    const res = await app.inject({
      method: 'GET',
      url: 'http://127.0.0.1:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-123&hub.challenge=challenge-abc',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('challenge-abc');
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  });

  it('rejects the GET handshake with a wrong verify token (403)', async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-token-123';
    const res = await app.inject({
      method: 'GET',
      url: 'http://127.0.0.1:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-abc',
    });
    expect(res.statusCode).toBe(403);
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  });
});
