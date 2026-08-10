import { prisma } from '../../db/client.js';
import {
  ScheduleOutreachSequenceInputSchema,
  type ScheduleOutreachSequenceInput,
  type ScheduleOutreachSequenceOutput,
} from '../../mcp/schemas/outreach.js';

type Channel = 'LINKEDIN_CONNECT' | 'LINKEDIN_MESSAGE' | 'EMAIL';

export interface OutreachRepository {
  createSequence(input: {
    campaignId: string;
    leadIds: string[];
    steps: Array<{ channel: Channel; delayHours: number; promptTemplate: string }>;
    nextRunAt: Date;
  }): Promise<{ id: string; status: 'ACTIVE' | 'PAUSED' | 'COMPLETED'; nextStep: number }>;
}

const prismaRepository: OutreachRepository = {
  async createSequence(input) {
    const sequence = await prisma.outreachSequence.create({
      data: {
        campaignId: input.campaignId,
        nextRunAt: input.nextRunAt,
        leads: { connect: input.leadIds.map(id => ({ id })) },
        steps: {
          create: input.steps.map((step, index) => ({
            campaign: { connect: { id: input.campaignId } },
            stepOrder: index,
            channel: step.channel,
            delayHours: step.delayHours,
            promptTemplate: step.promptTemplate,
          })),
        },
      },
      select: { id: true, status: true, nextStep: true },
    });
    return sequence;
  },
};

export interface AntiBanInput {
  channel: Channel;
  sentToday: number;
  dailyLimit: number;
  pausedUntil: Date | null;
  providerError?: string;
}

export function applyAntiBanPolicy(input: AntiBanInput, now = new Date()) {
  const isLinkedIn = input.channel !== 'EMAIL';
  const providerError = input.providerError?.toUpperCase() ?? '';
  if (isLinkedIn && (providerError.includes('CAPTCHA') || providerError.includes('429'))) {
    const pausedUntil = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    return { allowed: false, reason: 'LinkedIn account paused after provider safety signal', pausedUntil };
  }
  if (input.pausedUntil && input.pausedUntil > now) {
    return { allowed: false, reason: 'Account is paused', pausedUntil: input.pausedUntil };
  }
  if (input.sentToday >= input.dailyLimit) {
    return { allowed: false, reason: `Account daily quota exhausted for ${input.channel}`, pausedUntil: null };
  }
  return { allowed: true, reason: null, pausedUntil: null };
}

export function sampleHumanDelaySeconds(random = Math.random): number {
  const safeRandom = () => Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, random()));
  const gaussian = Math.sqrt(-2 * Math.log(safeRandom())) * Math.cos(2 * Math.PI * safeRandom());
  return Math.round(Math.min(210, Math.max(45, 127.5 + gaussian * 32)));
}

export function advanceSequenceState(
  current: { status: 'ACTIVE' | 'PAUSED' | 'COMPLETED'; nextStep: number },
  outcome: 'SENT' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE',
  totalSteps: number,
) {
  if (outcome === 'RETRYABLE_FAILURE') return { status: 'PAUSED' as const, nextStep: current.nextStep };
  if (outcome === 'PERMANENT_FAILURE' || current.nextStep + 1 >= totalSteps) {
    return { status: 'COMPLETED' as const, nextStep: Math.min(totalSteps, current.nextStep + 1) };
  }
  return { status: 'ACTIVE' as const, nextStep: current.nextStep + 1 };
}

function nextRunAt(startAt: Date | undefined): Date {
  const value = startAt ?? new Date();
  if (value.getTime() < Date.now()) return new Date();
  return value;
}

export interface OutreachDependencies { repository?: OutreachRepository; }

export class OutreachService {
  private readonly repository: OutreachRepository;

  constructor(dependencies: OutreachDependencies = {}) {
    this.repository = dependencies.repository ?? prismaRepository;
  }

  async scheduleSequence(rawInput: ScheduleOutreachSequenceInput): Promise<ScheduleOutreachSequenceOutput> {
    const input = ScheduleOutreachSequenceInputSchema.parse(rawInput);
    if (!input.steps.some(step => step.channel !== 'EMAIL')) throw new Error('Sequence must contain a LinkedIn step');
    if (!input.steps.some(step => step.channel === 'EMAIL')) throw new Error('Sequence must contain an Email step');

    const runAt = nextRunAt(input.start_at);
    const sequence = await this.repository.createSequence({
      campaignId: input.campaign_id,
      leadIds: input.lead_ids,
      steps: input.steps.map(step => ({
        channel: step.channel,
        delayHours: step.delay_hours,
        promptTemplate: step.prompt_template,
      })),
      nextRunAt: runAt,
    });
    return {
      sequence_id: sequence.id,
      status: sequence.status,
      next_step: sequence.nextStep,
      lead_count: input.lead_ids.length,
      next_run_at: runAt.toISOString(),
    };
  }
}

export const outreachService = new OutreachService();
