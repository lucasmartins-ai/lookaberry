import { describe, expect, it } from 'vitest';
import { normalizeIntentSignal } from '../../src/core/intent/service.js';

describe('Intent signal normalization', () => {
  it('applies the default weight and TTL for a hiring signal', () => {
    const signal = normalizeIntentSignal({
      signal_type: 'HIRING',
      source: 'jobs.example.com',
      title: 'Hiring a VP of Sales',
      summary: 'The company opened a VP of Sales role.',
    });

    expect(signal.signalType).toBe('HIRING');
    expect(signal.intentWeight).toBe(75);
    expect(signal.evidenceClassification).toBe('USER_PROVIDED');
    expect(signal.sourceQuality).toBe(1);
    expect(signal.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('clamps supplied weights to the 0 to 100 range', () => {
    expect(normalizeIntentSignal({
      signal_type: 'FUNDING',
      source: 'news',
      title: 'Series A',
      summary: 'Funding announced.',
      weight: 150,
    }).intentWeight).toBe(100);

    expect(normalizeIntentSignal({
      signal_type: 'TECH_INSTALL',
      source: 'technographics',
      title: 'Installed platform',
      summary: 'New technology detected.',
      weight: -10,
    }).intentWeight).toBe(0);
  });
});
