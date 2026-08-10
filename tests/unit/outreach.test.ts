import { describe, expect, it, vi } from 'vitest';
import {
  OutreachService,
  applyAntiBanPolicy,
  advanceSequenceState,
  sampleHumanDelaySeconds,
  type OutreachRepository,
} from '../../src/core/outreach/service.js';

const sequenceInput = {
  campaign_id: '00000000-0000-0000-0000-000000000010',
  lead_ids: ['00000000-0000-0000-0000-000000000011'],
  steps: [
    { channel: 'LINKEDIN_CONNECT' as const, delay_hours: 0, prompt_template: 'Connect' },
    { channel: 'LINKEDIN_MESSAGE' as const, delay_hours: 24, prompt_template: 'Message' },
    { channel: 'EMAIL' as const, delay_hours: 48, prompt_template: 'Email' },
  ],
};

describe('Outreach dispatcher', () => {
  it('schedules a sequence with the expected state machine', async () => {
    const repository: OutreachRepository = {
      createSequence: vi.fn().mockResolvedValue({ id: 'sequence-1', status: 'ACTIVE', nextStep: 0 }),
    };
    const service = new OutreachService({ repository });

    const result = await service.scheduleSequence(sequenceInput);

    expect(result).toEqual(expect.objectContaining({ sequence_id: 'sequence-1', status: 'ACTIVE', next_step: 0 }));
    expect(repository.createSequence).toHaveBeenCalledWith(expect.objectContaining({ campaignId: sequenceInput.campaign_id }));
  });

  it('rejects a sequence without an email or LinkedIn step', async () => {
    const service = new OutreachService({ repository: { createSequence: vi.fn() } });

    await expect(service.scheduleSequence({ ...sequenceInput, steps: [
      { channel: 'EMAIL', delay_hours: 0, prompt_template: 'Email' },
      { channel: 'EMAIL', delay_hours: 24, prompt_template: 'Follow-up' },
    ] })).rejects.toThrow('LinkedIn');
  });

  it('blocks a channel when its daily quota is exhausted', () => {
    const result = applyAntiBanPolicy({ channel: 'LINKEDIN_MESSAGE', sentToday: 20, dailyLimit: 20, pausedUntil: null }, new Date('2026-08-11T10:00:00Z'));

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily quota');
  });

  it('pauses LinkedIn for 48 hours after CAPTCHA or 429', () => {
    const now = new Date('2026-08-11T10:00:00Z');
    const result = applyAntiBanPolicy({ channel: 'LINKEDIN_MESSAGE', sentToday: 0, dailyLimit: 20, pausedUntil: null, providerError: '429' }, now);

    expect(result.allowed).toBe(false);
    expect(result.pausedUntil?.toISOString()).toBe('2026-08-13T10:00:00.000Z');
  });

  it('advances, pauses, and completes the sequence state machine', () => {
    expect(advanceSequenceState({ status: 'ACTIVE', nextStep: 0 }, 'SENT', 3)).toEqual({ status: 'ACTIVE', nextStep: 1 });
    expect(advanceSequenceState({ status: 'ACTIVE', nextStep: 1 }, 'RETRYABLE_FAILURE', 3)).toEqual({ status: 'PAUSED', nextStep: 1 });
    expect(advanceSequenceState({ status: 'ACTIVE', nextStep: 2 }, 'SENT', 3)).toEqual({ status: 'COMPLETED', nextStep: 3 });
  });

  it('keeps LinkedIn humanized delay inside the safety bounds', () => {
    const values = Array.from({ length: 100 }, () => sampleHumanDelaySeconds(() => 0.5));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...values)).toBeLessThanOrEqual(210);
  });
});
