import { describe, expect, it, vi } from 'vitest';
import { ingestEvents, isOptOut, personHash, IngestEventsSchema } from '../../src/core/events/service.js';

// Never call the real LLM from tests, even when ANTHROPIC_API_KEY is configured.
vi.mock('../../src/core/analytics/replyClassifier.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/analytics/replyClassifier.js')>();
  return { ...actual, classifyReply: async (text: string) => actual.classifyReplyHeuristic(text) };
});

function fakeDb(existingLeads: Array<{ id: string; email: string }> = []) {
  const suppression: Array<{ suppressionType: string; value: string }> = [];
  const db = {
    lead: { findMany: vi.fn(async () => existingLeads) },
    outreachEvent: { createMany: vi.fn(async ({ data }: any) => ({ count: data.length })) },
    globalSuppressionList: {
      create: vi.fn(async ({ data }: any) => {
        suppression.push({ suppressionType: data.suppressionType, value: data.value });
        return { id: 'x', ...data };
      }),
    },
  };
  return { db: db as any, suppression };
}

const base = { channel: 'email', occurred_at: '2026-10-01T10:00:00Z' };

describe('event ingestion', () => {
  it('stores a pseudonymous person hash, never the raw email or reply text', async () => {
    const { db } = fakeDb();
    await ingestEvents(IngestEventsSchema.parse({
      source: 'lookaorchestrator',
      events: [{ ...base, external_id: 'send_log:1', type: 'SENT', lead: { email: 'Ana@Clinic.co.uk', segment: 'dental' } }],
    }), db);
    const row = db.outreachEvent.createMany.mock.calls[0][0].data[0];
    expect(row.personHash).toBe(personHash({ email: 'ana@clinic.co.uk' }));
    expect(JSON.stringify(row)).not.toContain('Ana@Clinic');
    expect(row.companyDomain).toBe('clinic.co.uk');
    expect(row.segment).toBe('dental');
    expect(db.outreachEvent.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('classifies replies without an intent and drops the text', async () => {
    const { db } = fakeDb();
    await ingestEvents(IngestEventsSchema.parse({
      source: 'lookaorchestrator',
      events: [{ ...base, external_id: 'int:1', type: 'REPLIED', content: 'Maybe next quarter, thanks', lead: { email: 'a@b.com' } }],
    }), db);
    const row = db.outreachEvent.createMany.mock.calls[0][0].data[0];
    expect(row.intent).toBe('NOT_NOW');
    expect(JSON.stringify(row)).not.toContain('next quarter');
  });

  it('turns opt-outs into person-level suppression (email, LinkedIn, phone — never domain)', async () => {
    const { db, suppression } = fakeDb();
    const result = await ingestEvents(IngestEventsSchema.parse({
      source: 'lookaorchestrator',
      events: [
        { ...base, external_id: 'int:2', type: 'OPT_OUT', channel: 'whatsapp', lead: { phone: '+44 7700 900123', email: 'x@gmail.com' } },
        { ...base, external_id: 'int:3', type: 'REPLIED', intent: 'INTERESTED', lead: { email: 'keep@acme.com' } },
      ],
    }), db);
    expect(result.optOuts).toBe(1);
    expect(suppression).toEqual(expect.arrayContaining([
      { suppressionType: 'EMAIL', value: 'x@gmail.com' },
      { suppressionType: 'PHONE', value: '447700900123' },
    ]));
    expect(suppression.some(s => s.suppressionType === 'DOMAIN')).toBe(false);
    expect(suppression.some(s => s.value === 'keep@acme.com')).toBe(false);
  });

  it('links events to an existing LookaBerry lead by email', async () => {
    const { db } = fakeDb([{ id: 'lead-uuid', email: 'ana@clinic.co.uk' }]);
    await ingestEvents(IngestEventsSchema.parse({
      source: 'lookaorchestrator',
      events: [{ ...base, external_id: 'send_log:9', type: 'SENT', lead: { email: 'ANA@clinic.co.uk' } }],
    }), db);
    expect(db.outreachEvent.createMany.mock.calls[0][0].data[0].leadId).toBe('lead-uuid');
  });

  it('opt-out rule: OPT_OUT and refusing replies, not other replies', () => {
    expect(isOptOut('OPT_OUT')).toBe(true);
    expect(isOptOut('REPLIED', 'UNSUBSCRIBE')).toBe(true);
    expect(isOptOut('REPLIED', 'NOT_INTERESTED')).toBe(true);
    expect(isOptOut('REPLIED', 'NOT_NOW')).toBe(false);
    expect(isOptOut('SENT')).toBe(false);
  });

  it('rejects malformed batches', () => {
    expect(() => IngestEventsSchema.parse({ source: 'Bad Source!', events: [] })).toThrow();
    expect(() => IngestEventsSchema.parse({ source: 'x', events: [{ ...base, external_id: 'a', type: 'CLICKED' }] })).toThrow();
  });
});
