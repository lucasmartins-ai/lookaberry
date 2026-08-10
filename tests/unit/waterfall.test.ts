import { describe, expect, it, vi } from 'vitest';
import { WaterfallEnrichmentService, type EnrichmentProvider, type EmailVerifier } from '../../src/core/enrichment/service.js';

function provider(name: string, result: { email: string } | null): EnrichmentProvider {
  return { name, credits: result ? 1 : 0, enrich: vi.fn().mockResolvedValue(result) };
}

describe('Waterfall enrichment', () => {
  it('uses the local verified email cache before external providers', async () => {
    const apollo = provider('APOLLO', { email: 'apollo@example.com' });
    const service = new WaterfallEnrichmentService({
      getLead: vi.fn().mockResolvedValue({ id: 'lead-1', email: 'cached@example.com', emailStatus: 'VERIFIED' }),
      findCachedLead: vi.fn().mockResolvedValue({ email: 'cached@example.com', emailStatus: 'VERIFIED', provider: 'LOCAL_CACHE' }),
      saveResult: vi.fn(),
      updateLead: vi.fn(),
      providers: [apollo],
      verifier: { verify: vi.fn().mockResolvedValue('VERIFIED') },
    });

    const result = await service.enrichLead({ lead_id: 'lead-1' });

    expect(result.provider_used).toBe('LOCAL_CACHE');
    expect(result.email).toBe('cached@example.com');
    expect(apollo.enrich).not.toHaveBeenCalled();
  });

  it('falls through providers and validates the first usable email', async () => {
    const apollo = provider('APOLLO', null);
    const dropcontact = provider('DROPCONTACT', { email: 'person@example.com' });
    const verifier: EmailVerifier = { verify: vi.fn().mockResolvedValue('VERIFIED') };
    const saveResult = vi.fn();
    const service = new WaterfallEnrichmentService({
      getLead: vi.fn().mockResolvedValue({ id: 'lead-1', email: null, emailStatus: 'UNVERIFIED' }),
      findCachedLead: vi.fn().mockResolvedValue(null),
      saveResult,
      updateLead: vi.fn(),
      providers: [apollo, dropcontact],
      verifier,
    });

    const result = await service.enrichLead({ lead_id: 'lead-1' });

    expect(result.email).toBe('person@example.com');
    expect(result.email_status).toBe('VERIFIED');
    expect(result.provider_used).toBe('DROPCONTACT');
    expect(verifier.verify).toHaveBeenCalledWith('person@example.com');
    expect(saveResult).toHaveBeenCalledWith(expect.objectContaining({ provider: 'APOLLO', status: 'NOT_FOUND' }));
    expect(saveResult).toHaveBeenCalledWith(expect.objectContaining({ provider: 'DROPCONTACT', status: 'FOUND' }));
    expect(saveResult).toHaveBeenCalledWith(expect.objectContaining({ provider: 'SMTP_VALIDATOR', status: 'VERIFIED' }));
  });

  it('returns NOT_FOUND and audits a lead when no provider finds an email', async () => {
    const saveResult = vi.fn();
    const service = new WaterfallEnrichmentService({
      getLead: vi.fn().mockResolvedValue({ id: 'lead-1', email: null, emailStatus: 'UNVERIFIED' }),
      findCachedLead: vi.fn().mockResolvedValue(null),
      saveResult,
      updateLead: vi.fn(),
      providers: [provider('APOLLO', null), provider('DROPCONTACT', null)],
      verifier: { verify: vi.fn() },
    });

    const result = await service.enrichLead({ lead_id: 'lead-1' });

    expect(result.email_status).toBe('NOT_FOUND');
    expect(result.credits_consumed).toBe(0);
    expect(saveResult).toHaveBeenCalledTimes(2);
  });
});
