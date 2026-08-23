import { Job, Worker, type WorkerOptions } from 'bullmq';
import { redisConnection } from '../queues/queue.js';
import { executionRouter } from './index.js';
import { applyAntiBanPolicy, sampleHumanDelaySeconds } from '../outreach/service.js';
import { channelRegistry } from '../channels/registry.js';
import { handlePostSendFeedback } from './feedbackLoop.js';
import {
  resolveAccount,
  recordSent,
  markAccountBlocked,
  markAccountPaused,
  markAccountExpired,
} from './accountResolver.js';
import { enrichLeadBeforeSend } from './enricher.js';
import { shouldSendNow, nextAvailableSlot, detectTimezone } from './smartScheduler.js';
import { evaluateBranch } from './branching.js';
import { selectVariant, buildImpressionDelta } from './abTesting.js';
import { getCadenceGovernor } from './cadenceGovernor.js';
import { ScheduleWorker } from './scheduleWorker.js';
import { config as envConfig } from '../../config/env.js';
import { legacyChannelToChannelId } from '../channels/types.js';
import type { ChannelId } from '../channels/types.js';
import type { RecommendedAction } from '../decision/types.js';
import type { ExecutionContext, ExecutionResult } from './types.js';
import type { ScheduleConfig } from './smartScheduler.js';
import type { TestVariant } from './abTesting.js';

export interface DispatcherJobData {
  sequenceId: string;
}

export interface DispatcherDependencies {
  prisma?: typeof import('../../db/client.js').prisma;
}

/** Build the schedule config from env vars */
function buildScheduleConfig(): ScheduleConfig {
  return {
    businessHoursStart: envConfig.SCHEDULE_BUSINESS_HOURS_START,
    businessHoursEnd: envConfig.SCHEDULE_BUSINESS_HOURS_END,
    daysOfWeek: envConfig.SCHEDULE_DAYS_OF_WEEK.split(',').map(Number),
    respectLeadTimezone: envConfig.SCHEDULE_RESPECT_LEAD_TIMEZONE,
    defaultTimezone: envConfig.SCHEDULE_DEFAULT_TIMEZONE,
    whatsappBusinessHoursStart: envConfig.WHATSAPP_BUSINESS_HOURS_START,
    whatsappBusinessHoursEnd: envConfig.WHATSAPP_BUSINESS_HOURS_END,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create the outreach dispatcher BullMQ worker.
 *
 * S10: Integrated with Smart Scheduler, Branching, A/B Testing,
 * Cadence Governor, and Lead Enricher.
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
 * S10: Process the current step(s) in an outreach sequence.
 *
 * Per-lead aware: each lead may be at a different step due to branching.
 * Integrates:
 * - Lead Enricher (timezone detection, contact validation)
 * - Smart Scheduler (business hours check)
 * - Cadence Governor (global throttling)
 * - A/B Testing (variant selection, impression recording)
 * - Conditional Branching (per-lead step advancement)
 * - Account Resolver (multi-account failover, from S9)
 */
async function processSequenceStep(
  sequenceId: string,
  router: typeof executionRouter,
  prisma: any,
): Promise<{ dispatched: number; errors: number; skipped: number; nextRunAt: string | null }> {
  const scheduleCfg = buildScheduleConfig();
  const cadenceGov = getCadenceGovernor();
  const scheduleWorker = new ScheduleWorker({ prisma });

  // Load sequence with steps, leads, and lead-specific progress
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
          emailStatus: true,
          phone: true,
          phoneStatus: true,
          timezone: true,
          location: true,
          companyId: true,
          company: {
            select: {
              id: true,
              name: true,
              domain: true,
              linkedinUrl: true,
            },
          },
          sequenceStates: {
            where: { sequenceId },
            select: { currentStepIndex: true, status: true, pausedUntil: true },
          },
        },
      },
      steps: {
        orderBy: { stepOrder: 'asc' },
        include: {
          messages: {
            where: {
              OR: [
                { status: 'QUEUED' },
                { status: 'SCHEDULED' },
              ],
            },
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
    return { dispatched: 0, errors: 0, skipped: 0, nextRunAt: null };
  }

  let dispatched = 0;
  let errors = 0;
  let skipped = 0;

  for (const lead of sequence.leads) {
    // ── S10: Determine which step this lead is on ──
    const leadState = lead.sequenceStates?.[0];
    const leadStepIndex = leadState?.currentStepIndex ?? sequence.nextStep;

    // Check if lead's sequence state is paused
    if (leadState?.status === 'PAUSED') {
      if (leadState.pausedUntil && new Date(leadState.pausedUntil) > new Date()) {
        continue; // Still paused
      }
    }

    // Check if lead's sequence state is completed
    if (leadState?.status === 'COMPLETED') continue;

    const currentStep = sequence.steps[leadStepIndex];
    if (!currentStep || !currentStep.active) {
      // No more steps for this lead — mark as completed
      if (leadState) {
        await prisma.leadSequenceState.update({
          where: { id: leadState.id ?? undefined },
          data: { status: 'COMPLETED' },
        }).catch(() => {});
      }
      continue;
    }

    const channelId = legacyChannelToChannelId(currentStep.channel) as ChannelId;
    const profile = channelRegistry.getProfile(channelId);

    // ── S10: Lead Enrichment ──
    const enriched = await enrichLeadBeforeSend(
      {
        id: lead.id,
        email: lead.email,
        emailStatus: lead.emailStatus,
        phone: lead.phone,
        phoneStatus: lead.phoneStatus,
        timezone: lead.timezone,
        location: lead.location,
      },
      channelId,
      { prisma, config: { defaultTimezone: scheduleCfg.defaultTimezone } },
    );

    if (enriched.skipped) {
      console.log(`[Dispatcher] Skipping lead ${lead.id}: ${enriched.skipReason}`);
      skipped++;
      continue;
    }

    // Persist detected timezone if found
    if (enriched.detectedTimezone && !lead.timezone) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { timezone: enriched.detectedTimezone },
      }).catch(() => {});
      lead.timezone = enriched.detectedTimezone;
    }

    // Update email/phone status if validated
    if (enriched.emailValidation) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { emailStatus: enriched.emailValidation },
      }).catch(() => {});
    }
    if (enriched.phoneValidation) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { phoneStatus: enriched.phoneValidation },
      }).catch(() => {});
    }

    // ── S10: Smart Scheduler — business hours check ──
    const schedulableLead = {
      timezone: lead.timezone ?? enriched.detectedTimezone,
      phone: lead.phone,
      location: lead.location,
    };

    if (!shouldSendNow(schedulableLead, channelId, scheduleCfg)) {
      const nextSlot = nextAvailableSlot(schedulableLead, channelId, scheduleCfg);
      // Find or create the QUEUED message for this lead/step
      const message = currentStep.messages.find((m: { leadId: string }) => m.leadId === lead.id);
      if (message) {
        await scheduleWorker.enqueueScheduled(prisma, message.id, nextSlot);
      }
      skipped++;
      continue;
    }

    // ── S10: Cadence Governor — acquire send slot ──
    let slotResult = cadenceGov.acquireSendSlot(channelId);
    let backoffAttempts = 0;

    while (!slotResult.allowed && backoffAttempts < 3) {
      const backoffMs = Math.min(
        (slotResult.retryAfterMs ?? 1000) + Math.random() * 500,
        30_000,
      );
      await sleep(backoffMs);
      slotResult = cadenceGov.acquireSendSlot(channelId);
      backoffAttempts++;
    }

    if (!slotResult.allowed) {
      // Cadence exhausted — pause batch, return early
      cadenceGov.releaseSendSlot(channelId);
      return {
        dispatched,
        errors,
        skipped,
        nextRunAt: new Date(Date.now() + (slotResult.retryAfterMs ?? 60_000)).toISOString(),
      };
    }

    // Find the QUEUED message for this lead/step (skip SCHEDULED messages)
    const message = currentStep.messages.find(
      (m: { leadId: string; status: string }) => m.leadId === lead.id && m.status === 'QUEUED',
    );
    if (!message) {
      cadenceGov.releaseSendSlot(channelId);
      continue;
    }

    // ── S9: Account Resolution ──
    let resolved = await resolveAccount(channelId, prisma);
    if (!resolved) {
      resolved = {
        id: 'default',
        provider: channelId,
        externalId: 'default',
        dailyLimit: profile?.defaultDailyLimit ?? 100,
        sentToday: 0,
        quotaDate: new Date(),
        pausedUntil: null,
        sessionKey: null,
        status: 'ACTIVE',
      };
    }

    // ── S10: A/B Variant Selection ──
    // Find all steps that are variants of this one (same variantGroup, sorted by stepOrder)
    const variantGroup = currentStep.variantGroup;
    let selectedStep = currentStep;

    if (variantGroup) {
      const variants: TestVariant[] = sequence.steps
        .filter((s: any) => s.variantGroup === variantGroup && s.active)
        .map((s: any) => ({
          id: s.id,
          stepOrder: s.stepOrder,
          variantGroup: s.variantGroup ?? '',
          variantWeight: s.variantWeight ?? 1.0,
          impressions: s.impressions ?? 0,
          opens: s.opens ?? 0,
          replies: s.replies ?? 0,
          clicks: s.clicks ?? 0,
        }));

      if (variants.length > 0) {
        const chosen = selectVariant(variants, { leadId: lead.id });
        selectedStep = sequence.steps.find((s: any) => s.id === chosen.id) ?? currentStep;

        // Find the QUEUED message for the selected variant step
        const variantMessage = selectedStep.messages?.find(
          (m: { leadId: string; status: string }) => m.leadId === lead.id && m.status === 'QUEUED',
        );
        if (!variantMessage) {
          cadenceGov.releaseSendSlot(channelId);
          continue;
        }
        // Use the variant message instead
        // Actually, we need to use the original message from the selectedStep
        // Since the message is linked to a specific stepId, we use the variant step's message
        const msgForStep = selectedStep.messages?.find(
          (m: { leadId: string; status: string }) => m.leadId === lead.id && m.status === 'QUEUED',
        );
        if (msgForStep) {
          // message = msgForStep — handled inline below
        }
      }
    }

    const messageToSend = selectedStep !== currentStep
      ? selectedStep.messages?.find((m: { leadId: string; status: string }) => m.leadId === lead.id && m.status === 'QUEUED')
      : message;

    if (!messageToSend) {
      cadenceGov.releaseSendSlot(channelId);
      continue;
    }

    const capability = selectedStep.channel === 'LINKEDIN_CONNECT' ? 'connect' as const : 'sendMessage' as const;

    // Apply anti-ban policy
    const antiBan = applyAntiBanPolicy({
      channel: channelId,
      sentToday: resolved.sentToday,
      dailyLimit: resolved.dailyLimit,
      pausedUntil: resolved.pausedUntil instanceof Date ? resolved.pausedUntil : resolved.pausedUntil ? new Date(resolved.pausedUntil) : null,
    });

    if (!antiBan.allowed) {
      if (antiBan.pausedUntil && resolved.id !== 'default') {
        await markAccountPaused(resolved.id, antiBan.pausedUntil, prisma);
      }
      const altAccount = resolved.id !== 'default'
        ? await resolveAccount(channelId, prisma)
        : null;
      if (!altAccount) {
        await prisma.outreachSequence.update({
          where: { id: sequenceId },
          data: { pausedUntil: antiBan.pausedUntil },
        });
        cadenceGov.releaseSendSlot(channelId);
        return { dispatched, errors, skipped, nextRunAt: antiBan.pausedUntil?.toISOString() ?? null };
      }
      cadenceGov.releaseSendSlot(channelId);
      continue;
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
        id: messageToSend.id,
        subject: messageToSend.subject,
        body: messageToSend.body,
        outreachAccountId: resolved.id,
      },
      dryRun: false,
    };

    const action: RecommendedAction = {
      channel: channelId,
      capability,
      timing: 'WITHIN_24H',
      template: messageToSend.body,
      rationale: `Sequence ${sequenceId} step ${selectedStep.stepOrder} for ${lead.firstName}`,
    };

    try {
      let result = await router.execute(action, context);

      // S9: Failover on permanent account failure
      if (!result.success && !result.retryable && resolved.id !== 'default') {
        const errorMsg = (result.error ?? '').toUpperCase();
        const isSessionExpired = errorMsg.includes('SESSION_EXPIRED') || errorMsg.includes('401');
        const isBlocked = errorMsg.includes('403') || errorMsg.includes('FORBIDDEN') || errorMsg.includes('CAPTCHA');

        if (isSessionExpired) {
          await markAccountExpired(resolved.id, result.error ?? 'Session expired', prisma);
        } else if (isBlocked) {
          await markAccountBlocked(resolved.id, result.error ?? 'Account blocked', prisma);
        }

        const nextAccount = await resolveAccount(channelId, prisma);
        if (nextAccount) {
          console.log(`[Dispatcher] Failover: account ${resolved.id} blocked, retrying with ${nextAccount.id}`);
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

      // Persist result
      await handleExecutionResult(prisma, messageToSend.id, result, sequenceId, resolved.id);

      if (result.success) {
        dispatched++;

        // Record on account
        if (context.message.outreachAccountId && context.message.outreachAccountId !== 'default') {
          await recordSent(context.message.outreachAccountId, prisma);
        }

        // ── S10: Record A/B impression ──
        if (variantGroup) {
          const delta = buildImpressionDelta(
            {
              id: selectedStep.id,
              stepOrder: selectedStep.stepOrder,
              variantGroup: selectedStep.variantGroup ?? '',
              variantWeight: selectedStep.variantWeight ?? 1.0,
              impressions: selectedStep.impressions ?? 0,
              opens: selectedStep.opens ?? 0,
              replies: selectedStep.replies ?? 0,
              clicks: selectedStep.clicks ?? 0,
            },
            lead.id,
          );
          await prisma.sequenceStep.update({
            where: { id: selectedStep.id },
            data: {
              impressions: { increment: delta.impressionsIncrement },
              opens: { increment: delta.opensIncrement },
              replies: { increment: delta.repliesIncrement },
              clicks: { increment: delta.clicksIncrement },
            },
          }).catch(() => {});
        }

        // Schedule delivery verification
        await handlePostSendFeedback(result, messageToSend.id, lead.id, channelId)
          .catch(err => console.warn('[Dispatcher] Post-send feedback error:', err instanceof Error ? err.message : String(err)));

        // ── S10: Evaluate branching for next step ──
        const lastMsg = await prisma.outreachMessage.findFirst({
          where: { leadId: lead.id, status: { notIn: ['QUEUED', 'SCHEDULED'] } },
          orderBy: { createdAt: 'desc' },
          select: { status: true, sentAt: true, openedAt: true, clickedAt: true, repliedAt: true },
        }).catch(() => null);

        const branchResult = evaluateBranch({
          lastMessage: lastMsg ?? null,
          currentStep: {
            branchOn: selectedStep.branchOn ?? 'NONE',
            branchStepIndex: selectedStep.branchStepIndex ?? null,
            stepOrder: selectedStep.stepOrder,
            delayHours: selectedStep.delayHours ?? 24,
          },
        });

        const nextStepIndex = branchResult ?? leadStepIndex + 1;

        // Advance per-lead state
        if (leadState) {
          const totalSteps = sequence.steps.length;
          const nextStatus = nextStepIndex >= totalSteps ? 'COMPLETED' : 'ACTIVE';
          await prisma.leadSequenceState.update({
            where: { id: leadState.id },
            data: {
              currentStepIndex: Math.min(nextStepIndex, totalSteps),
              status: nextStatus,
            },
          }).catch(() => {});
        }
      } else {
        errors++;
        // Sten retryable errors (re-queue), retryable keep as QUEUED
        cadenceGov.releaseSendSlot(channelId);
      }

      // Commit the cadence slot on success
      if (result.success) {
        cadenceGov.commitSendSlot(channelId);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.outreachMessage.update({
        where: { id: messageToSend.id },
        data: { status: 'FAILED', errorReason: msg },
      }).catch(() => {});
      errors++;
      cadenceGov.releaseSendSlot(channelId);
      continue;
    }

    // Human-like delay between sends
    const delayMs = sampleHumanDelaySeconds(() => Math.random()) * 1_000;
    const rateLimitWindowMs = profile?.rateLimitWindowMs ?? 3_000;
    await sleep(Math.max(rateLimitWindowMs, delayMs));
  }

  // ── Update sequence-level next run time ──
  // Use the shortest delay among remaining active steps
  const activeLeads = sequence.leads.filter((l: any) => {
    const ls = l.sequenceStates?.[0];
    return !ls || ls.status === 'ACTIVE';
  });

  const nextRunAt = activeLeads.length > 0
    ? new Date(Date.now() + 60_000) // Check again in 1 minute for per-lead based dispatch
    : null;

  if (nextRunAt) {
    await prisma.outreachSequence.update({
      where: { id: sequenceId },
      data: { nextRunAt },
    }).catch(() => {});
  } else {
    // All leads completed — mark sequence as completed
    await prisma.outreachSequence.update({
      where: { id: sequenceId },
      data: { status: 'COMPLETED' },
    }).catch(() => {});
  }

  console.log(
    `[Dispatcher] Sequence ${sequenceId}: dispatched=${dispatched}, errors=${errors}, skipped=${skipped}, nextRunAt=${nextRunAt?.toISOString() ?? 'N/A'}`,
  );

  return { dispatched, errors, skipped, nextRunAt: nextRunAt?.toISOString() ?? null };
}

async function handleExecutionResult(
  prisma: any,
  messageId: string,
  result: ExecutionResult,
  _sequenceId: string,
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