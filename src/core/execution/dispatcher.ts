import { Job, Worker, type WorkerOptions } from 'bullmq';
import { redisConnection } from '../queues/queue.js';
import { executionRouter } from './index.js';
import { applyAntiBanPolicy, sampleHumanDelaySeconds, advanceSequenceState } from '../outreach/service.js';
import { channelRegistry } from '../channels/registry.js';
import { handlePostSendFeedback } from './feedbackLoop.js';
import type { RecommendedAction } from '../decision/types.js';
import type { ExecutionContext, ExecutionResult } from './types.js';
import type { ChannelId } from '../channels/types.js';

export interface DispatcherJobData {
  sequenceId: string;
}

export interface DispatcherDependencies {
  prisma?: typeof import('../../db/client.js').prisma;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create the outreach dispatcher BullMQ worker.
 *
 * Graceful degradation: if Redis is unavailable, the worker creation will fail.
 * Callers should catch and log the error — the rest of the system continues working.
 */
export function createDispatcherWorker(
  deps: DispatcherDependencies = {},
  workerOptions?: Partial<WorkerOptions>,
): Worker<DispatcherJobData> {
  const prisma = deps.prisma ?? (globalThis as any).__prismaForDispatcher;

  const worker = new Worker<DispatcherJobData>(
    'outreach_dispatcher_queue',
    async (job: Job<DispatcherJobData>) => {
      const sequenceId = job.data.sequenceId;
      return processSequenceStep(sequenceId, executionRouter, prisma);
    },
    {
      connection: redisConnection,
      concurrency: 1,
      limiter: { max: 2, duration: 60_000 },
      ...workerOptions,
    },
  );

  worker.on('failed', (job, error) => {
    console.error(`[Dispatcher Worker] Job ${job?.id} (sequence=${job?.data.sequenceId}) failed: ${error.message}`);
  });

  worker.on('completed', job => {
    console.log(`[Dispatcher Worker] Job ${job.id} (sequence=${job.data.sequenceId}) completed.`);
  });

  return worker;
}

/**
 * Process the CURRENT pending step in an outreach sequence.
 *
 * S6 fix: Process ONE step at a time (the step at index `nextStep`).
 * After dispatching all leads for this step, advance `nextStep` and set
 * `nextRunAt = NOW() + delayHours` so the Sequence Scheduler picks up
 * the next step after the configured delay.
 */
async function processSequenceStep(
  sequenceId: string,
  router: typeof executionRouter,
  prisma: any,
): Promise<{ dispatched: number; errors: number; nextRunAt: string | null }> {
  const sequence = await prisma.outreachSequence.findUnique({
    where: { id: sequenceId },
    include: {
      campaign: true,
      leads: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          fullName: true,
          title: true,
          linkedinUrl: true,
          email: true,
          companyId: true,
          company: {
            select: {
              id: true,
              name: true,
              domain: true,
              linkedinUrl: true,
            },
          },
        },
      },
      steps: {
        orderBy: { stepOrder: 'asc' },
        include: {
          messages: {
            where: { status: 'QUEUED' },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  });

  if (!sequence) {
    throw new Error(`Sequence not found: ${sequenceId}`);
  }

  if (sequence.status !== 'ACTIVE') {
    return { dispatched: 0, errors: 0, nextRunAt: null };
  }

  // S6: Process ONLY the current step (at index = nextStep)
  const currentStep = sequence.steps[sequence.nextStep];
  if (!currentStep) {
    // All steps complete
    await prisma.outreachSequence.update({
      where: { id: sequenceId },
      data: { status: 'COMPLETED' },
    });
    return { dispatched: 0, errors: 0, nextRunAt: null };
  }

  const currentChannelId = currentStep.channelId as ChannelId;
  const profile = channelRegistry.getProfile(currentChannelId);
  const rateLimitWindowMs = profile?.rateLimitWindowMs ?? 3_000;

  let dispatched = 0;
  let errors = 0;

  // S6: Process all leads for this ONE step
  for (const lead of sequence.leads) {
    // Find queued message for this lead at this step
    const message = currentStep.messages.find((m: { leadId: string }) => m.leadId === lead.id);
    if (!message) continue;

    // Determine capability based on channel: LinkedIn uses 'connect' for LINKEDIN_CONNECT
    const capability = currentStep.channel === 'LINKEDIN_CONNECT' ? 'connect' as const : 'sendMessage' as const;

    // Build execution context
    const context: ExecutionContext = {
      lead: {
        id: lead.id,
        firstName: lead.firstName,
        lastName: lead.lastName,
        fullName: lead.fullName,
        title: lead.title,
        linkedinUrl: lead.linkedinUrl,
        email: lead.email,
      },
      company: {
        id: lead.company.id,
        name: lead.company.name,
        domain: lead.company.domain,
        linkedinUrl: lead.company.linkedinUrl,
      },
      account: {
        id: 'default',
        provider: currentChannelId,
        externalId: 'default',
        dailyLimit: profile?.defaultDailyLimit ?? 100,
        sentToday: 0,
        pausedUntil: null,
        sessionKey: null,
      },
      message: {
        id: message.id,
        subject: message.subject,
        body: message.body,
      },
      dryRun: false,
    };

    // Apply anti-ban policy
    const antiBan = applyAntiBanPolicy({
      channel: currentChannelId,
      sentToday: context.account.sentToday,
      dailyLimit: context.account.dailyLimit,
      pausedUntil: context.account.pausedUntil,
    });

    if (!antiBan.allowed) {
      if (antiBan.pausedUntil) {
        await prisma.outreachSequence.update({
          where: { id: sequenceId },
          data: { pausedUntil: antiBan.pausedUntil },
        });
      }
      return { dispatched, errors, nextRunAt: antiBan.pausedUntil?.toISOString() ?? null };
    }

    // Build recommended action from the step template
    const action: RecommendedAction = {
      channel: currentChannelId,
      capability,
      timing: 'WITHIN_24H',
      template: message.body,
      rationale: `Sequence ${sequenceId} step ${currentStep.stepOrder} for ${lead.firstName}`,
    };

    try {
      const result = await router.execute(action, context);
      await handleExecutionResult(prisma, message.id, result, sequenceId);
      if (result.success) {
        dispatched++;
        // S6: Schedule delivery verification for LinkedIn messages
        await handlePostSendFeedback(result, message.id, lead.id, currentChannelId)
          .catch(err => console.warn('[Dispatcher] Post-send feedback error:', err instanceof Error ? err.message : String(err)));
      } else {
        errors++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.outreachMessage.update({
        where: { id: message.id },
        data: {
          status: 'FAILED',
          errorReason: msg,
        },
      });
      errors++;
      continue;
    }

    // Humanized delay between actions
    const delayMs = sampleHumanDelaySeconds(() => Math.random()) * 1_000;
    await sleep(Math.max(rateLimitWindowMs, delayMs));
  }

  // S6: Advance the sequence by one step
  const outcome = errors > 0 && dispatched === 0 ? 'RETRYABLE_FAILURE' : 'SENT';
  const next = advanceSequenceState(
    { status: sequence.status, nextStep: sequence.nextStep },
    outcome,
    sequence.steps.length,
  );

  // S6: Set nextRunAt for the NEXT step based on delayHours
  const nextStepDelayHours = currentStep.delayHours ?? 24;
  const nextRunAt = next.status === 'ACTIVE'
    ? new Date(Date.now() + nextStepDelayHours * 3_600_000)
    : null;

  await prisma.outreachSequence.update({
    where: { id: sequenceId },
    data: {
      status: next.status,
      nextStep: next.nextStep,
      nextRunAt: nextRunAt ?? undefined,
    },
  });

  console.log(
    `[Dispatcher] Sequence ${sequenceId} step ${sequence.nextStep} → ${next.nextStep}. ` +
    `Dispatched: ${dispatched}, Errors: ${errors}, Next run: ${nextRunAt?.toISOString() ?? 'N/A'}`,
  );

  return { dispatched, errors, nextRunAt: nextRunAt?.toISOString() ?? null };
}

async function handleExecutionResult(
  prisma: any,
  messageId: string,
  result: ExecutionResult,
  sequenceId: string,
): Promise<void> {
  if (result.success) {
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'SENT',
        externalMessageId: result.externalId ?? null,
        sentAt: new Date(),
      },
    });
  } else if (result.retryable) {
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'QUEUED',
        errorReason: result.error ?? 'Retryable failure',
      },
    });
  } else {
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'FAILED',
        errorReason: result.error ?? 'Permanent failure',
      },
    });
  }

  // If rate limited or channel needs pause, update the sequence
  if (result.rateLimitHit && result.channelPausedUntil) {
    await prisma.outreachSequence.update({
      where: { id: sequenceId },
      data: { pausedUntil: result.channelPausedUntil },
    });
  }
}