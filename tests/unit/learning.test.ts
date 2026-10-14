import { describe, expect, it } from 'vitest';
import { applyChannelPriors, computeInsights, wilsonLowerBound, type LearningEvent } from '../../src/core/learning/service.js';
import { normalizeSegment } from '../../src/core/learning/segments.js';

const day = (n: number, hour = 10) => new Date(Date.UTC(2026, 8, n, hour));
function ev(partial: Partial<LearningEvent> & Pick<LearningEvent, 'eventType' | 'occurredAt'>): LearningEvent {
  return { channel: 'email', personHash: null, externalLeadId: null, segment: null, campaign: null, variant: null, intent: null, ...partial };
}

describe('segment normalization', () => {
  it('maps orchestrator and LookaBerry industries to one bucket', () => {
    expect(normalizeSegment('Odontologia / Saúde Privada')).toBe('dental');
    expect(normalizeSegment('dental')).toBe('dental');
    expect(normalizeSegment('Clínica de Fisioterapia')).toBe('physio');
    expect(normalizeSegment('veterinary')).toBe('vet');
    expect(normalizeSegment('B2B SaaS')).toBe('saas');
    expect(normalizeSegment('')).toBe('unknown');
  });
});

describe('Wilson lower bound', () => {
  it('ranks a large proven arm above a tiny lucky one', () => {
    expect(wilsonLowerBound(20, 400)).toBeGreaterThan(wilsonLowerBound(1, 2) - 0.1);
    expect(wilsonLowerBound(0, 100)).toBe(0);
    expect(wilsonLowerBound(1, 2)).toBeLessThan(0.5);
  });
});

describe('computeInsights (last-touch attribution)', () => {
  const events: LearningEvent[] = [
    // person A: email then whatsapp; positive reply after the whatsapp → credit whatsapp
    ev({ eventType: 'SENT', occurredAt: day(1), personHash: 'A', channel: 'email', segment: 'dental' }),
    ev({ eventType: 'SENT', occurredAt: day(3), personHash: 'A', channel: 'whatsapp', segment: 'dental' }),
    ev({ eventType: 'REPLIED', occurredAt: day(4), personHash: 'A', channel: 'whatsapp', intent: 'INTERESTED' }),
    // person B: email, auto-reply only → not a human reply
    ev({ eventType: 'SENT', occurredAt: day(1), personHash: 'B', channel: 'email', segment: 'dental' }),
    ev({ eventType: 'REPLIED', occurredAt: day(1, 11), personHash: 'B', channel: 'email', intent: 'AUTO_REPLY' }),
    // person C: matched by external lead id (reply hashed by email, send by phone)
    ev({ eventType: 'SENT', occurredAt: day(2), personHash: 'phoneC', externalLeadId: 'ld_c', channel: 'whatsapp', segment: 'physio' }),
    ev({ eventType: 'REPLIED', occurredAt: day(5), personHash: 'emailC', externalLeadId: 'ld_c', channel: 'email', intent: 'NOT_INTERESTED' }),
    // person D: reply 40 days later → outside the window → inbound
    ev({ eventType: 'SENT', occurredAt: day(1), personHash: 'D', channel: 'email', segment: 'vet' }),
    ev({ eventType: 'REPLIED', occurredAt: new Date(Date.UTC(2026, 9, 15)), personHash: 'D', channel: 'email', intent: 'INTERESTED' }),
    // inbound diagnostic with payment, no send at all
    ev({ eventType: 'PAID', occurredAt: day(6), personHash: 'E', channel: 'web' }),
  ];

  it('credits the last touch and keeps auto-replies and late replies out', () => {
    const byChannel = computeInsights(events, 'channel', 1);
    const whatsapp = byChannel.arms.find(a => a.key === 'whatsapp')!;
    const email = byChannel.arms.find(a => a.key === 'email')!;
    expect(whatsapp).toMatchObject({ sent: 2, positive: 1, negative: 1, replied: 2 });
    expect(email).toMatchObject({ sent: 3, positive: 0, replied: 0 });
    expect(byChannel.totals.sent).toBe(5);
  });

  it('reports outcomes without a prior send as inbound demand', () => {
    const { inbound } = computeInsights(events, 'segment', 1);
    expect(inbound.find(i => i.channel === 'web')).toMatchObject({ paid: 1, positive: 1 });
    expect(inbound.find(i => i.channel === 'email')).toMatchObject({ positive: 1 }); // the late reply
  });

  it('groups by normalized segment x channel and flags thin arms', () => {
    const r = computeInsights(events, 'segment_channel', 2);
    expect(r.arms.map(a => a.key)).toEqual(expect.arrayContaining(['dental|whatsapp', 'dental|email', 'physio|whatsapp']));
    expect(r.arms.find(a => a.key === 'dental|email')!.enoughData).toBe(true);
    expect(r.arms.find(a => a.key === 'physio|whatsapp')!.enoughData).toBe(false);
  });
});

describe('applyChannelPriors', () => {
  const score: any = {
    whyNow: ['Hiring signal'],
    recommendedActions: [
      { channel: 'linkedin', capability: 'connect' },
      { channel: 'email', capability: 'sendMessage' },
      { channel: 'whatsapp', capability: 'sendMessage' },
    ],
  };
  const priors: any = [
    { key: 'dental|whatsapp', sent: 150, positiveRate: 0.052 },
    { key: 'dental|email', sent: 400, positiveRate: 0.008 },
  ];

  it('puts the best learned channel first and explains it', () => {
    const out = applyChannelPriors(score, priors, 'Odontologia');
    expect(out.recommendedActions.map((a: any) => a.channel)).toEqual(['whatsapp', 'email', 'linkedin']);
    expect(out.whyNow.at(-1)).toContain('whatsapp gets 5.2% positive replies in dental (n=150)');
  });

  it('leaves the order alone when nothing has been learned', () => {
    expect(applyChannelPriors(score, [], 'dental')).toBe(score);
  });
});
