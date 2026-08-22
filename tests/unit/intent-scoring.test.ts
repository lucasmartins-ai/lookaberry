import { describe, expect, it } from 'vitest';
import {
  rankLeadsDeterministically,
  scoreSignal,
  scoreSignals,
  signalRecencyFactor,
} from '../../src/core/intent/scoring.js';
import type { ScorableSignal } from '../../src/core/intent/scoring.js';

const now = new Date('2026-08-22T12:00:00.000Z');

function signal(overrides: Partial<ScorableSignal> = {}): ScorableSignal {
  return {
    id: 'signal-1',
    signalType: 'HIRING',
    intentWeight: 80,
    confidence: 1,
    sourceQuality: 1,
    observedAt: new Date('2026-08-22T00:00:00.000Z'),
    expiresAt: new Date('2026-09-21T00:00:00.000Z'),
    isActive: true,
    evidenceClassification: 'FACT',
    deduplicationKey: 'same-event',
    ...overrides,
  };
}

describe('Deterministic intent scoring', () => {
  it('applies recency and reaches zero after TTL', () => {
    expect(signalRecencyFactor(signal(), now)).toBeCloseTo(0.9833, 3);
    expect(scoreSignal(signal({ expiresAt: new Date('2026-08-22T11:00:00.000Z') }), now)).toBe(0);
  });

  it('weights confidence, source quality, classification, and signal type', () => {
    const fact = scoreSignal(signal(), now);
    const inference = scoreSignal(signal({ evidenceClassification: 'INFERENCE' }), now);
    const llmInference = scoreSignal(signal({ evidenceClassification: 'LLM_INFERENCE' }), now);
    const lowQuality = scoreSignal(signal({ sourceQuality: 0.5, confidence: 0.5 }), now);

    expect(fact).toBeGreaterThan(inference);
    expect(inference).toBeGreaterThan(llmInference);
    expect(fact).toBeGreaterThan(lowQuality);
    expect(scoreSignal(signal({ confidence: Number.NaN }), now)).toBe(0);
    expect(scoreSignal(signal(), now, {
      typeMultipliers: { HIRING: 2 },
      classificationMultipliers: {
        FACT: 1,
        USER_PROVIDED: 0.9,
        INFERENCE: 0.8,
        LLM_INFERENCE: 0.6,
        UNVERIFIED: 0.5,
      },
    })).toBeGreaterThan(fact);
  });

  it('deduplicates active signals and excludes expired or inactive rows', () => {
    const result = scoreSignals([
      signal({ id: 'best', intentWeight: 80 }),
      signal({ id: 'duplicate', intentWeight: 60 }),
      signal({ id: 'expired', expiresAt: new Date('2026-08-22T11:59:00.000Z') }),
      signal({ id: 'inactive', isActive: false }),
    ], now);

    expect(result.activeSignalCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.contributions[0].signal.id).toBe('best');
  });

  it('ranks ties by lead id for stable output', () => {
    const ranked = rankLeadsDeterministically([
      { leadId: 'lead-b', totalPriorityScore: 80 },
      { leadId: 'lead-a', totalPriorityScore: 80 },
      { leadId: 'lead-c', totalPriorityScore: 70 },
    ]);

    expect(ranked.map(lead => lead.leadId)).toEqual(['lead-a', 'lead-b', 'lead-c']);
  });
});
