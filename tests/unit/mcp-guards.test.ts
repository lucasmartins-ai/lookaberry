import { describe, expect, it, vi } from 'vitest';
import { whatsappBlockReason } from '../../src/mcp/tools/whatsapp.js';
import { buildServer } from '../../src/api/server.js';

function store(suppressed: boolean) {
  return {
    globalSuppressionList: { findUnique: vi.fn(async () => (suppressed ? { id: 's1' } : null)) },
  } as any;
}

const lead = { id: 'l1', status: 'READY', email: 'ana@acme.com', linkedinUrl: null, company: { domain: 'acme.com' } };

describe('gtm_send_whatsapp guard', () => {
  it('allows a ready, non-suppressed lead', async () => {
    expect(await whatsappBlockReason(store(false), lead)).toBeNull();
  });

  it('blocks unsubscribed / bounced / negative-reply leads', async () => {
    for (const status of ['UNSUBSCRIBED', 'BOUNCED', 'REPLIED_NEGATIVE']) {
      expect(await whatsappBlockReason(store(false), { ...lead, status })).toMatch(status);
    }
  });

  it('blocks leads in the global suppression list', async () => {
    expect(await whatsappBlockReason(store(true), lead)).toMatch(/suppression/);
  });
});

describe('MCP SSE access', () => {
  it('refuses /sse and /messages without an OPERATOR/ADMIN key', async () => {
    const app = await buildServer();
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/sse' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/messages?sessionId=x', payload: {} })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
