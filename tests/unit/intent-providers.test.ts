import { describe, expect, it } from 'vitest';
import {
  credentialedFundingProvider,
  hiringProvider,
  publicAnnouncementsProvider,
  websiteChangesProvider,
  collectAndNormalizeProvider,
} from '../../src/core/intent/providers/index.js';
import type { SignalCollectionInput, SignalProvider } from '../../src/core/intent/providers/types.js';

const baseInput: SignalCollectionInput = {
  company_domain: 'acme.example',
  company_name: 'Acme Example',
  company_website_url: 'https://acme.example',
};

describe('Intent signal providers', () => {
  it('collects and normalizes hiring postings as FACT with TTL and provenance', async () => {
    const result = await collectAndNormalizeProvider(hiringProvider, [{
      ...baseInput,
      job_postings: [{
        title: 'VP Sales',
        url: 'https://acme.example/careers/vp-sales?session_token=do-not-store',
        description: 'Build the revenue team.',
      }],
    }]);

    expect(result.status).toBe('IMPLEMENTED');
    expect(result.cost).toBe(0);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      signalType: 'HIRING',
      evidenceClassification: 'FACT',
      confidence: 0.95,
      ttlDays: 30,
      sourceUrl: 'https://acme.example/careers/vp-sales',
    });
    expect(result.signals[0].expiresAt.getTime()).toBeGreaterThan(result.signals[0].observedAt.getTime());
  });

  it('returns NOT_AVAILABLE when a provider has no usable input or no comparison baseline', async () => {
    const result = await collectAndNormalizeProvider(websiteChangesProvider, [{
      company_domain: baseInput.company_domain,
      company_name: baseInput.company_name,
    }]);
    const noBaseline = await collectAndNormalizeProvider(websiteChangesProvider, [baseInput]);

    expect(result.status).toBe('NOT_AVAILABLE');
    expect(result.signals).toHaveLength(0);
    expect(result.errors[0]).toContain('website URL or crawl snapshot');
    expect(noBaseline.status).toBe('NOT_AVAILABLE');
    expect(noBaseline.errors[0]).toContain('previous website snapshot');
  });

  it('keeps agent-reported website changes UNVERIFIED and distinguishes snapshot FACTs', async () => {
    const reported = await collectAndNormalizeProvider(websiteChangesProvider, [{
      ...baseInput,
      website_content: 'Updated pricing page',
      website_changed: true,
    }]);
    const compared = await collectAndNormalizeProvider(websiteChangesProvider, [{
      ...baseInput,
      website_content: '<main>New pricing page</main>',
      previous_website_content: '<main>Old pricing page</main>',
    }]);

    expect(reported.signals[0].evidenceClassification).toBe('UNVERIFIED');
    expect(compared.signals[0].evidenceClassification).toBe('FACT');
    expect(compared.signals[0].normalizedData).toMatchObject({ comparison: 'snapshot_hash' });
  });

  it('normalizes public funding announcements without treating them as LLM inference', async () => {
    const result = await collectAndNormalizeProvider(publicAnnouncementsProvider, [{
      ...baseInput,
      announcement_items: [{
        title: 'Acme raises Series A funding',
        url: 'https://news.example/acme-series-a',
        summary: 'The round will expand the sales team.',
      }],
    }]);

    expect(result.status).toBe('IMPLEMENTED');
    expect(result.signals[0]).toMatchObject({
      signalType: 'FUNDING',
      evidenceClassification: 'FACT',
      ttlDays: 60,
      intentWeight: 85,
    });
    expect(result.signals[0].evidenceClassification).not.toBe('LLM_INFERENCE');
  });

  it('reports credential requirements explicitly', async () => {
    const availability = credentialedFundingProvider.getAvailability(baseInput);
    const result = await collectAndNormalizeProvider(credentialedFundingProvider, [baseInput]);

    expect(availability.status).toBe('REQUIRES_CREDENTIALS');
    expect(result.status).toBe('REQUIRES_CREDENTIALS');
    expect(result.errors[0]).toContain('credentials');
  });

  it('reports provider failure, timeout, partial failure, and cost deterministically', async () => {
    const failingProvider: SignalProvider = {
      id: 'failing',
      type: 'test',
      source: 'TEST',
      cost: 2,
      ttlDays: 1,
      getAvailability: () => ({ status: 'IMPLEMENTED' }),
      collect: async () => { throw new Error('upstream unavailable'); },
      normalize: () => [],
    };
    const timeoutProvider: SignalProvider = {
      id: 'timeout',
      type: 'test',
      source: 'TEST',
      cost: 2,
      ttlDays: 1,
      getAvailability: () => ({ status: 'IMPLEMENTED' }),
      collect: async () => await new Promise(() => undefined),
      normalize: () => [],
    };
    const partialProvider: SignalProvider = {
      id: 'partial',
      type: 'test',
      source: 'TEST',
      cost: 0.25,
      ttlDays: 1,
      getAvailability: (input) => input.metadata ? { status: 'IMPLEMENTED' } : { status: 'NOT_AVAILABLE', reason: 'missing input' },
      collect: async () => [{
        ...baseInput,
        providerId: 'partial',
        companyDomain: baseInput.company_domain,
        companyName: baseInput.company_name,
        signalType: 'HIRING',
        source: 'TEST',
        title: 'Test signal',
        summary: 'Observed test signal',
        rawData: { authorization: 'secret' },
        cost: 0.25,
      }],
      normalize: signal => [{
        providerId: signal.providerId,
        companyDomain: signal.companyDomain,
        companyName: signal.companyName,
        signalType: signal.signalType,
        source: signal.source,
        title: signal.title,
        summary: signal.summary,
        observedAt: new Date('2026-08-22T00:00:00Z'),
        expiresAt: new Date('2026-08-23T00:00:00Z'),
        ttlDays: 1,
        confidence: 1,
        sourceQuality: 1,
        intentWeight: 50,
        evidenceClassification: 'FACT',
        normalizedData: {},
        rawData: { authorization: '[REDACTED]' },
        metadata: {},
        cost: 0.25,
        contentHash: 'hash',
        deduplicationKey: 'dedup',
      }],
    };

    expect((await collectAndNormalizeProvider(failingProvider, [baseInput])).status).toBe('FAILED');
    expect((await collectAndNormalizeProvider(timeoutProvider, [baseInput], 5)).status).toBe('TIMEOUT');
    const partial = await collectAndNormalizeProvider(partialProvider, [baseInput, { ...baseInput, metadata: { supplied: true } }]);
    expect(partial.status).toBe('PARTIALLY_IMPLEMENTED');
    expect(partial.cost).toBe(0.25);
    expect(partial.signals[0].rawData).toEqual({ authorization: '[REDACTED]' });
  });
});
