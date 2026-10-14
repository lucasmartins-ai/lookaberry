import { describe, expect, it } from 'vitest';
import { applyMessageGuardrails, buildDynamicPrompt, HyperPersonalizationService, repeatsPreviousMessage } from '../../src/core/personalization/service.js';

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

  describe('lead memory', () => {
    const lead = { firstName: 'Ana', title: 'VP Sales', companyName: 'Acme' };
    const sent = { channel: 'EMAIL', sentAt: '2026-10-01T10:00:00Z', subject: 'Vaga de VP Sales', body: 'Ana, vi que a Acme abriu uma vaga de VP Sales e queria entender como vocês estruturam o time.' };

    it('a follow-up can run on conversation history when the signal expired', () => {
      const prompt = JSON.parse(buildDynamicPrompt({ lead, signal: null, memory: { previousMessages: [sent], replies: [], facts: [] } }, input));
      expect(prompt.conversation_history.sent_latest_first).toHaveLength(1);
      expect(prompt.instructions).toContain('follow-up');
    });

    it('answers the latest reply instead of restarting the pitch', () => {
      const memory = { previousMessages: [sent], replies: [{ at: '2026-10-02T09:00:00Z', sentiment: 'NEUTRAL', content: 'Qual o preço?' }], facts: [] };
      const prompt = JSON.parse(buildDynamicPrompt({ lead, signal: null, memory }, input));
      expect(prompt.conversation_history.replies_latest_first[0].content).toBe('Qual o preço?');
      expect(prompt.instructions).toContain('Answer their latest reply');
    });

    it('passes verified facts and still refuses a cold first touch without a signal', () => {
      const facts = [{ type: 'HIRING', observedAt: '2026-10-01T00:00:00Z', data: '{"role":"VP Sales"}' }];
      expect(JSON.parse(buildDynamicPrompt({ lead, signal: { summary: 's', title: 't', signalType: 'HIRING' }, memory: { previousMessages: [], replies: [], facts } }, input)).verified_facts).toEqual(facts);
      expect(() => buildDynamicPrompt({ lead, signal: null, memory: { previousMessages: [], replies: [], facts } }, input)).toThrow('active intent signal');
    });

    it('blocks a message that repeats one already sent, but not a short shared greeting', async () => {
      const memory = { previousMessages: [sent, { ...sent, body: 'Oi Ana' }], replies: [], facts: [] };
      expect(repeatsPreviousMessage(sent.body, memory)).toBe(true);
      expect(repeatsPreviousMessage('Oi Ana, uma ideia nova sobre o time de vendas.', memory)).toBe(false);
      const service = new HyperPersonalizationService({
        repository: { getContext: async () => ({ lead, signal: null, memory }) },
        generator: { generate: async () => ({ body: sent.body, hook_used: 'Vaga' }) },
      });
      await expect(service.generateMessage(input)).rejects.toThrow('repeats a message');
    });
  });
});
