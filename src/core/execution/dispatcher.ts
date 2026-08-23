import { Job, Worker, type WorkerOptions } from 'bullmq';
import { redisConnection } from '../queues/queue.js';
import { executionRouter } from './index.js';
import { applyAntiBanPolicy, sampleHumanDelaySeconds, advanceSequenceState } from '../outreach/service.js';
import { channelRegistry } from '../channels/registry.js';
import { handlePostSendFeedback } from './feedbackLoop.js';
import {
  resolveAccount,
  recordSent,
  markAccountBlocked,
  markAccountPaused,
  markAccountExpired,
} from './accountResolver.js';
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
 * S9 update: Uses Account Resolver for real multi-account failover.
 * If an account is blocked, the next available account is tried (one retry).
 * Rate limits pause individual accounts, not the entire sequence.
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
          phone: true,
          phoneStatus: true,
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

  const currentStep = sequence.steps[sequence.nextStep];
  if (!currentStep) {
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

  for (const lead of sequence.leads) {
    const message = currentStep.messages.find((m: { leadId: string }) => m.leadId === lead.id);
    if (!message) continue;

    const capability = currentStep.channel === 'LINKEDIN_CONNECT' ? 'connect' as const : 'sendMessage' as const;

    // S9: Resolve a real account for this channel
    let resolved = await resolveAccount(currentChannelId, prisma);

    // S9: If no accounts configured, fall back to default (backward compat)
    if (!resolved) {
      resolved = {
        id: 'default',
        provider: currentChannelId,
        externalId: 'default',
        dailyLimit: profile?.defaultDailyLimit ?? 100,
        sentToday: 0,
        quotaDate: new Date(),
        pausedUntil: null,
        sessionKey: null,
        status: 'ACTIVE',
      };
    }

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
        phone: lead.phone,
        phoneStatus: lead.phoneStatus,
      },
      company: {
        id: lead.company.id,
        name: lead.company.name,
        domain: lead.company.domain,
        linkedinUrl: lead.company.linkedinUrl,
      },
      account: {
        id: resolved.id,
        provider: resolved.provider,
        externalId: resolved.externalId,
        dailyLimit: resolved.dailyLimit,
        sentToday: resolved.sentToday,
        pausedUntil: resolved.pausedUntil instanceof Date ? resolved.pausedUntil : resolved.pausedUntil ? new Date(resolved.pausedUntil) : null,
        sessionKey: resolved.sessionKey,
      },
      message: {
        id: message.id,
        subject: message.subject,
        body: message.body,
        outreachAccountId: resolved.id,
      },
      dryRun: false,
    };

    // Apply anti-ban policy with real account values
    const antiBan = applyAntiBanPolicy({
      channel: currentChannelId,
      sentToday: context.account.sentToday,
      dailyLimit: context.account.dailyLimit,
      pausedUntil: context.account.pausedUntil,
    });

    if (!antiBan.allowed) {
      // S9: Pause the account, not the whole sequence (unless no accounts are available)
      if (antiBan.pausedUntil && resolved.id !== 'default') {
        await markAccountPaused(resolved.id, antiBan.pausedUntil, prisma);
      }
      // Check if ANY account is still available for this channel
      const altAccount = resolved.id !== 'default'
        ? await resolveAccount(currentChannelId, prisma)
        : null;
      if (!altAccount) {
        // No accounts left — pause the sequence
        await prisma.outreachSequence.update({
          where: { id: sequenceId },
          data: { pausedUntil: antiBan.pausedUntil },
        });
        return { dispatched, errors, nextRunAt: antiBan.pausedUntil?.toISOString() ?? null };
      }
      // There is another account — just mark this lead for the next account
      continue;
    }

    const action: RecommendedAction = {
      channel: currentChannelId,
      capability,
      timing: 'WITHIN_24H',
      template: message.body,
      rationale: `Sequence ${sequenceId} step ${currentStep.stepOrder} for ${lead.firstName}`,
    };

    try {
      let result = await router.execute(action, context);

      // S9: Failover on permanent account failure
      if (!result.success && !result.retryable && resolved.id !== 'default') {
        // Classify the failure reason
        const errorMsg = (result.error ?? '').toUpperCase();
        const isSessionExpired = errorMsg.includes('SESSION_EXPIRED') || errorMsg.includes('401');
        const isBlocked = errorMsg.includes('403') || errorMsg.includes('FORBIDDEN') || errorMsg.includes('CAPTCHA');

        if (isSessionExpired) {
          await markAccountExpired(resolved.id, result.error ?? 'Session expired', prisma);
        } else if (isBlocked) {
          await markAccountBlocked(resolved.id, result.error ?? 'Account blocked', prisma);
        }

        // Try the next available account
        const nextAccount = await resolveAccount(currentChannelId, prisma);
        if (nextAccount) {
          console.log(`[Dispatcher] Failover: account ${resolved.id} blocked, retrying with ${nextAccount.id}`);

          // Rebuild context with new account
          const retryContext: ExecutionContext = {
            ...context,
            account: {
              id: nextAccount.id,
              provider: nextAccount.provider,
              externalId: nextAccount.externalId,
              dailyLimit: nextAccount.dailyLimit,
              sentToday: nextAccount.sentToday,
              pausedUntil: nextAccount.pausedUntil instanceof Date ? nextAccount.pausedUntil : nextAccount.pausedUntil ? new Date(nextAccount.pausedUntil) : null,
              sessionKey: nextAccount.sessionKey,
            },
            message: {
              ...context.message,
              outreachAccountId: nextAccount.id,
            },
          };

          result = await router.execute(action, retryContext);
        }
      }

      await handleExecutionResult(prisma, message.id, result, sequenceId, resolved.id);

      if (result.success) {
        dispatched++;
        // Record the send on the account that succeeded
        if (context.message.outreachAccountId && context.message.outreachAccountId !== 'default') {
          await recordSent(context.message.outreachAccountId, prisma);
        }
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

    const delayMs = sampleHumanDelaySeconds(() => Math.random()) * 1_000;
    await sleep(Math.max(rateLimitWindowMs, delayMs));
  }

  const outcome = errors > 0 && dispatched === 0 ? 'RETRYABLE_FAILURE' : 'SENT';
  const next = advanceSequenceState(
    { status: sequence.status, nextStep: sequence.nextStep },
    outcome,
    sequence.steps.length,
  );

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
  accountId: string,
): Promise<void> {
  const accountData = accountId !== 'default' ? { outreachAccountId: accountId } : {};

  if (result.success) {
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'SENT',
        externalMessageId: result.externalId ?? null,
        sentAt: new Date(),
        ...accountData,
      },
    });
  } else if (result.retryable) {
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'QUEUED',
        errorReason: result.error ?? 'Retryable failure',
        ...accountData,
      },
    });
  } else {
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: {
        status: 'FAILED',
        errorReason: result.error ?? 'Permanent failure',
        ...accountData,
      },
    });
  }

  // S9: Rate limit pauses the ACCOUNT, not the sequence
  if (result.rateLimitHit && result.channelPausedUntil && accountId !== 'default') {
    await markAccountPaused(accountId, result.channelPausedUntil, prisma);
  }
}