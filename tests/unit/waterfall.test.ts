import { describe, expect, it, vi } from 'vitest';
import { WaterfallEnrichmentService, type EnrichmentProvider, type EmailVerifier } from '../../src/core/enrichment/service.js';

function provider(name: string, result: { email: string } | null): EnrichmentProvider {
  return { name, credits: result ? 1 : 0, enrich: vi.fn().mockResolvedValue(result) };
}

describe('Waterfall enrichment', () => {
  it('uses the local verified email cache before external providers', async () => {
    const apollo = provider('APOLLO', { email: 'apollo@acme.io' });
    const service = new WaterfallEnrichmentService({
      getLead: vi.fn().mockResolvedValue({ id: 'lead-1', email: 'cached@acme.io', emailStatus: 'VERIFIED' }),
      findCachedLead: vi.fn().mockResolvedValue({ email: 'cached@acme.io', emailStatus: 'VERIFIED', provider: 'LOCAL_CACHE' }),
      saveResult: vi.fn(),
      updateLead: vi.fn(),
      providers: [apollo],
      verifier: { verify: vi.fn().mockResolvedValue('VERIFIED') },
    });

    const result = await service.enrichLead({ lead_id: 'lead-1' });

    expect(result.provider_used).toBe('LOCAL_CACHE');
    expect(result.email).toBe('cached@acme.io');
    expect(apollo.enrich).not.toHaveBeenCalled();
  });

  it('falls through providers and validates the first usable email', async () => {
    const apollo = provider('APOLLO', null);
    const dropcontact = provider('DROPCONTACT', { email: 'person@acme.io' });
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

    expect(result.email).toBe('person@acme.io');
    expect(result.email_status).toBe('VERIFIED');
    expect(result.provider_used).toBe('DROPCONTACT');
    expect(verifier.verify).toHaveBeenCalledWith('person@acme.io');
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

  it('skips a provider that returns a fake/placeholder email and caps a foreign domain at RISKY', async () => {
    const verifier: EmailVerifier = { verify: vi.fn().mockResolvedValue('VERIFIED') };
    const updateLead = vi.fn();
    const service = new WaterfallEnrichmentService({
      getLead: vi.fn().mockResolvedValue({ id: 'lead-1', email: null, emailStatus: 'UNVERIFIED', companyDomain: 'acme.io' }),
      findCachedLead: vi.fn().mockResolvedValue(null),
      saveResult: vi.fn(),
      updateLead,
      providers: [provider('APOLLO', { email: 'teste@mailinator.com' }), provider('DROPCONTACT', { email: 'ana@other.io' })],
      verifier,
    });

    const result = await service.enrichLead({ lead_id: 'lead-1' });

    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ email: 'ana@other.io', email_status: 'RISKY', provider_used: 'DROPCONTACT' });
  });
});
