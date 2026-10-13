import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../src/db/client.js';
import { buildServer } from '../../src/api/server.js';

const SOURCE = 'vitest-events';

describe('POST /api/v1/events (real DB)', () => {
  afterAll(async () => {
    await prisma.outreachEvent.deleteMany({ where: { source: SOURCE } });
    await prisma.globalSuppressionList.deleteMany({ where: { addedBy: SOURCE } });
  });

  it('is idempotent per (source, external_id) and suppresses opt-outs', async () => {
    const app = await buildServer();
    await app.ready();
    try {
      const payload = {
        source: SOURCE,
        events: [
          { external_id: 'e1', type: 'SENT', channel: 'email', occurred_at: '2026-10-01T09:00:00Z', lead: { email: 'vitest-sent@example.org', segment: 'dental' } },
          { external_id: 'e2', type: 'OPT_OUT', channel: 'whatsapp', occurred_at: '2026-10-02T09:00:00Z', lead: { phone: '+55 11 90000-0001' } },
        ],
      };
      const first = await app.inject({ method: 'POST', url: '/api/v1/events', payload });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ received: 2, inserted: 2, duplicates: 0, optOuts: 1 });

      const again = await app.inject({ method: 'POST', url: '/api/v1/events', payload });
      expect(again.json()).toMatchObject({ inserted: 0, duplicates: 2 });

      const phone = await prisma.globalSuppressionList.findFirst({ where: { suppressionType: 'PHONE', value: '5511900000001' } });
      expect(phone?.addedBy).toBe(SOURCE);
    } finally {
      await app.close();
    }
  });
});
