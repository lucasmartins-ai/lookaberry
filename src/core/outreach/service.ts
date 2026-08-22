import { prisma } from '../../db/client.js';
import { outreachQueue } from '../queues/queue.js';
import {
  ScheduleOutreachSequenceInputSchema,
  type ScheduleOutreachSequenceInput,
  type ScheduleOutreachSequenceOutput,
} from '../../mcp/schemas/outreach.js';
import { channelRegistry } from '../channels/registry.js';
import { legacyChannelToChannelId } from '../channels/types.js';
import type { ChannelId } from '../channels/types.js';
import type { ExecutionContext, ExecutionResult } from '../execution/types.js';
import type { RecommendedAction } from '../decision/types.js';

type Channel = 'LINKEDIN_CONNECT' | 'LINKEDIN_MESSAGE' | 'EMAIL';

/** Map ChannelId back to the legacy ChannelType enum for Prisma compatibility */
function channelIdToLegacy(channelId: ChannelId): Channel {
  switch (channelId) {
    case 'linkedin':
      return 'LINKEDIN_MESSAGE';
    case 'email':
      return 'EMAIL';
    case 'whatsapp':
    case 'manual':
      return 'MANUAL_TASK' as Channel;
  }
}

export interface OutreachRepository {
  createSequence(input: {
    campaignId: string;
    leadIds: string[];
    steps: Array<{ channel: ChannelId; delayHours: number; promptTemplate: string }>;
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
            channel: channelIdToLegacy(step.channel),
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
  channel: ChannelId;
  sentToday: number;
  dailyLimit: number;
  pausedUntil: Date | null;
  providerError?: string;
}

export function applyAntiBanPolicy(input: AntiBanInput, now = new Date()) {
  const profile = channelRegistry.getProfile(input.channel);
  const safetyPauseMs = profile?.safetyPauseMs ?? 24 * 60 * 60 * 1_000;
  const isBrowserChannel = profile?.requiresBrowser ?? false;

  const providerError = input.providerError?.toUpperCase() ?? '';
  if (isBrowserChannel && (providerError.includes('CAPTCHA') || providerError.includes('429'))) {
    const pausedUntil = new Date(now.getTime() + safetyPauseMs);
    return { allowed: false, reason: `${input.channel} account paused after provider safety signal`, pausedUntil };
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

    // Convert legacy channel values to ChannelId
    const normalizedSteps = input.steps.map(step => ({
      ...step,
      channel: legacyChannelToChannelId(step.channel) as ChannelId,
    }));

    // Validate: at least one LinkedIn step and one Email step
    if (!normalizedSteps.some(step => step.channel === 'linkedin')) {
      throw new Error('Sequence must contain a LinkedIn step');
    }
    if (!normalizedSteps.some(step => step.channel === 'email')) {
      throw new Error('Sequence must contain an Email step');
    }

    // Validate each step's channel is known to the registry
    for (const step of normalizedSteps) {
      if (!channelRegistry.isKnown(step.channel)) {
        throw new Error(`Unknown channel: ${step.channel}`);
      }
      // Validate the channel supports at least sendMessage or connect capabilities
      if (!channelRegistry.can(step.channel, 'sendMessage') && !channelRegistry.can(step.channel, 'connect')) {
        throw new Error(`Channel ${step.channel} does not support outreach actions`);
      }
    }

    const runAt = nextRunAt(input.start_at);
    const sequence = await this.repository.createSequence({
      campaignId: input.campaign_id,
      leadIds: input.lead_ids,
      steps: normalizedSteps.map(step => ({
        channel: step.channel,
        delayHours: step.delay_hours,
        promptTemplate: step.prompt_template,
      })),
      nextRunAt: runAt,
    });
    // Enqueue the first step in the BullMQ dispatcher queue
    try {
      await Promise.race([
        outreachQueue.add('dispatch', { sequenceId: sequence.id }, { delay: 0 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Queue add timed out')), 3000)),
      ]);
    } catch (err) {
      // Graceful degradation: if Redis is down, scheduling succeeds but dispatch is deferred
      console.warn('[OutreachService] Could not enqueue dispatch job — Redis may be unavailable:', err instanceof Error ? err.message : String(err));
    }

    return {
      sequence_id: sequence.id,
      status: sequence.status,
      next_step: sequence.nextStep,
      lead_count: input.lead_ids.length,
      next_run_at: runAt.toISOString(),
    };
  }

  /**
   * Execute a single action via the execution router.
   * This is a convenience method for immediate execution (MCP tools, manual triggers).
   */
  async executeAction(
    action: RecommendedAction,
    context: ExecutionContext,
    router: { execute(action: RecommendedAction, context: ExecutionContext): Promise<ExecutionResult> },
  ): Promise<ExecutionResult> {
    return router.execute(action, context);
  }
}

export const outreachService = new OutreachService();
