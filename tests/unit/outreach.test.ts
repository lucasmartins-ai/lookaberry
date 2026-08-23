import { describe, expect, it, vi } from 'vitest';
import {
  OutreachService,
  applyAntiBanPolicy,
  advanceSequenceState,
  sampleHumanDelaySeconds,
  type OutreachRepository,
  createPrismaOutreachRepository,
} from '../../src/core/outreach/service.js';
import type { ChannelId } from '../../src/core/channels/types.js';

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
    expect(repository.createSequence).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: sequenceInput.campaign_id,
      initialVersion: {
        version: 1,
        steps: [
          { stepOrder: 0, channel: 'LINKEDIN_CONNECT', delayHours: 0, promptTemplate: 'Connect' },
          { stepOrder: 1, channel: 'LINKEDIN_MESSAGE', delayHours: 24, promptTemplate: 'Message' },
          { stepOrder: 2, channel: 'EMAIL', delayHours: 48, promptTemplate: 'Email' },
        ],
      },
      leadStates: [{ leadId: sequenceInput.lead_ids[0], currentStepIndex: 0, status: 'ACTIVE' }],
    }));
  });

  it('passes a version snapshot and an ACTIVE state for every lead', async () => {
    const repository: OutreachRepository = {
      createSequence: vi.fn().mockResolvedValue({ id: 'sequence-2', status: 'ACTIVE', nextStep: 0 }),
    };
    const service = new OutreachService({ repository });
    const input = { ...sequenceInput, lead_ids: ['00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012'] };

    await service.scheduleSequence(input);

    const call = vi.mocked(repository.createSequence).mock.calls[0]?.[0];
    expect(call?.initialVersion.version).toBe(1);
    expect(call?.initialVersion.steps).toEqual(call?.steps);
    expect(call?.leadStates).toEqual([
      { leadId: input.lead_ids[0], currentStepIndex: 0, status: 'ACTIVE' },
      { leadId: input.lead_ids[1], currentStepIndex: 0, status: 'ACTIVE' },
    ]);
  });

  it('creates the initial version, points the sequence at it, and seeds lead states atomically', async () => {
    const transaction = {
      outreachSequence: {
        create: vi.fn().mockResolvedValue({ id: 'sequence-db', status: 'ACTIVE', nextStep: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      outreachSequenceVersion: {
        create: vi.fn().mockResolvedValue({ id: 'version-db' }),
      },
      leadSequenceState: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const db = {
      $transaction: vi.fn().mockImplementation(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    const repository = createPrismaOutreachRepository(db as any);
    const steps = [
      { stepOrder: 0, channel: 'LINKEDIN_CONNECT' as const, delayHours: 0, promptTemplate: 'Connect' },
      { stepOrder: 1, channel: 'EMAIL' as const, delayHours: 24, promptTemplate: 'Email' },
    ];

    await repository.createSequence({
      campaignId: sequenceInput.campaign_id,
      leadIds: sequenceInput.lead_ids,
      steps,
      nextRunAt: new Date('2026-08-23T10:00:00Z'),
      initialVersion: { version: 1, steps },
      leadStates: [{ leadId: sequenceInput.lead_ids[0], currentStepIndex: 0, status: 'ACTIVE' }],
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.outreachSequenceVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sequenceId: 'sequence-db', version: 1, steps }),
    }));
    expect(transaction.outreachSequence.update).toHaveBeenCalledWith({
      where: { id: 'sequence-db' },
      data: { currentVersionId: 'version-db' },
    });
    expect(transaction.leadSequenceState.createMany).toHaveBeenCalledWith({
      data: [{ leadId: sequenceInput.lead_ids[0], sequenceId: 'sequence-db', currentStepIndex: 0, status: 'ACTIVE' }],
    });
  });

  it('rejects a sequence without an email or LinkedIn step', async () => {
    const service = new OutreachService({ repository: { createSequence: vi.fn() } });

    await expect(service.scheduleSequence({ ...sequenceInput, steps: [
      { channel: 'EMAIL', delay_hours: 0, prompt_template: 'Email' },
      { channel: 'EMAIL', delay_hours: 24, prompt_template: 'Follow-up' },
    ] })).rejects.toThrow('LinkedIn');
  });

  it('blocks a channel when its daily quota is exhausted', () => {
    const result = applyAntiBanPolicy({ channel: 'linkedin', sentToday: 20, dailyLimit: 20, pausedUntil: null }, new Date('2026-08-11T10:00:00Z'));

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily quota');
  });

  it('pauses browser channel for safety window after CAPTCHA or 429', () => {
    const now = new Date('2026-08-11T10:00:00Z');
    const result = applyAntiBanPolicy({ channel: 'linkedin', sentToday: 0, dailyLimit: 20, pausedUntil: null, providerError: '429' }, now);

    expect(result.allowed).toBe(false);
    // LinkedIn safety window is 48h
    expect(result.pausedUntil?.toISOString()).toBe('2026-08-13T10:00:00.000Z');
  });

  it('does not trigger safety pause for non-browser channel on error', () => {
    const now = new Date('2026-08-11T10:00:00Z');
    // email is not a browser channel — 429 should NOT trigger safety pause
    const result = applyAntiBanPolicy({ channel: 'email', sentToday: 5, dailyLimit: 200, pausedUntil: null, providerError: '429' }, now);
    expect(result.allowed).toBe(true);
  });

  it('uses ChannelProfile.safetyPauseMs from registry instead of hardcoded constant', () => {
    const now = new Date('2026-08-11T10:00:00Z');
    // whatsapp has safetyPauseMs = 24h (vs LinkedIn 48h)
    const result = applyAntiBanPolicy({ channel: 'whatsapp', sentToday: 0, dailyLimit: 50, pausedUntil: null, providerError: 'CAPTCHA' }, now);
    expect(result.allowed).toBe(false);
    expect(result.pausedUntil?.toISOString()).toBe('2026-08-12T10:00:00.000Z');
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
