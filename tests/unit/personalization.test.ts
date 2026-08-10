import { describe, expect, it } from 'vitest';
import { applyMessageGuardrails, HyperPersonalizationService } from '../../src/core/personalization/service.js';

const input = { lead_id: '00000000-0000-0000-0000-000000000001', channel: 'LINKEDIN_MESSAGE' as const, tone: 'DIRECT_PEER' as const };

describe('Hyper-personalization', () => {
  it('rejects generic or spam language', () => {
    expect(() => applyMessageGuardrails({ body: 'Unlock a seamless workflow.', hook_used: 'Unlock', subject: null }, 'EMAIL')).toThrow('blocked');
  });

  it('generates a guarded message from the active signal context', async () => {
    const service = new HyperPersonalizationService({
      repository: { getContext: async () => ({ lead: { firstName: 'Ana', title: 'VP Sales', companyName: 'Acme' }, signal: { summary: 'Acme abriu uma vaga de VP Sales', title: 'Nova vaga', signalType: 'HIRING' } }) },
      generator: { generate: async ({ prompt }) => ({ body: `Ana, vi o sinal: ${JSON.parse(prompt).active_signal.summary}`, hook_used: 'Nova vaga de VP Sales' }) },
    });

    const result = await service.generateMessage(input);
    expect(result.body).toContain('Acme abriu');
    expect(result.hook_used).toContain('Nova vaga');
    expect(result.estimated_tokens_used).toBeGreaterThan(0);
  });

  it('does not generate without an active signal', async () => {
    const service = new HyperPersonalizationService({ repository: { getContext: async () => ({ lead: { firstName: 'Ana', title: 'VP Sales', companyName: 'Acme' }, signal: null }) } });
    await expect(service.generateMessage(input)).rejects.toThrow('active intent signal');
  });
});
