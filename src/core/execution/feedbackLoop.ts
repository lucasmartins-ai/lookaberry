import { outreachQueue } from '../queues/queue.js';
import { prisma } from '../../db/client.js';
import { executionRouter } from './index.js';
import type { ExecutionResult } from './types.js';
import type { RecommendedAction } from '../decision/types.js';
import type { ChannelId } from '../channels/types.js';

export interface FeedbackLoopDependencies {
  _prisma?: typeof prisma;
}

/**
 * Schedule a delivery verification job after a message is sent.
 *
 * Called by the dispatcher after a successful SEND.
 * Schedules a check 24h later to verify the connection was accepted.
 */
export async function scheduleDeliveryVerification(
  messageId: string,
  leadId: string,
  channel: ChannelId,
  deps: FeedbackLoopDependencies = {},
): Promise<void> {
  const db = deps._prisma ?? prisma;

  // LinkedIn and WhatsApp support verifyDelivery
  if (channel !== 'linkedin' && channel !== 'whatsapp') {
    return;
  }

  try {
    // Fetch the lead to build the verification context
    const lead = await db.lead.findUnique({
      where: { id: leadId },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            domain: true,
            linkedinUrl: true,
          },
        },
      },
    });

    if (!lead) {
      console.warn(`[FeedbackLoop] Lead ${leadId} not found for delivery verification`);
      return;
    }

    // Enqueue a delayed job for delivery verification
    // The delay is 24h (in ms)
    const delayMs = 24 * 60 * 60 * 1_000;

    await Promise.race([
      outreachQueue.add(
        'verifyDelivery',
        {
          messageId,
          leadId,
          leadName: lead.fullName,
          companyName: lead.company.name,
          linkedinUrl: lead.linkedinUrl,
        },
        { delay: delayMs },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Queue add timed out')), 3000),
      ),
    ]);

    console.log(`[FeedbackLoop] Scheduled delivery verification for message ${messageId} in 24h`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[FeedbackLoop] Could not schedule delivery verification for message ${messageId}: ${msg}`);
  }
}

/**
 * Execute delivery verification for a previously sent message.
 *
 * Called when the delayed BullMQ job fires (24h after send).
 */
export async function executeDeliveryVerification(
  messageId: string,
  leadId: string,
  linkedinUrl: string | null,
  deps: FeedbackLoopDependencies = {},
): Promise<void> {
  const db = deps._prisma ?? prisma;

  if (!linkedinUrl) {
    console.warn(`[FeedbackLoop] Cannot verify delivery: no LinkedIn URL for lead ${leadId}`);
    return;
  }

  const action: RecommendedAction = {
    channel: 'linkedin',
    capability: 'verifyDelivery',
    timing: 'WITHIN_24H',
    template: `Verify delivery for message ${messageId}`,
    rationale: 'Post-send delivery verification',
  };

  const context = {
    lead: {
      id: leadId,
      firstName: '',
      lastName: null,
      fullName: '',
      title: '',
      linkedinUrl,
      email: null,
      phone: null,
      phoneStatus: null,
    },
    company: {
      id: '',
      name: '',
      domain: '',
      linkedinUrl: null,
    },
    account: {
      id: 'feedback-loop',
      provider: 'linkedin',
      externalId: 'feedback-loop',
      dailyLimit: 100,
      sentToday: 0,
      pausedUntil: null,
      sessionKey: null,
    },
    message: {
      id: messageId,
      subject: null,
      body: '',
      outreachAccountId: null,
    },
    dryRun: false,
  };

  try {
    const result = await executionRouter.execute(action, context);

    if (result.success) {
      // Connection still active — mark as delivered
      await db.outreachMessage.update({
        where: { id: messageId },
        data: { status: 'DELIVERED' },
      });
      console.log(`[FeedbackLoop] Delivery verified for message ${messageId}`);
    } else {
      // Profile might be blocked or restricted
      console.warn(`[FeedbackLoop] Delivery verification failed for message ${messageId}: ${result.error ?? 'unknown'}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[FeedbackLoop] Error during delivery verification for message ${messageId}: ${msg}`);
  }
}

/**
 * Adjust intent signal weights based on reply sentiment.
 *
 * Called by the inbox worker after a reply is detected.
 * Weight adjustment: ±5 points based on sentiment.
 */
export function adjustIntentWeight(
  currentWeight: number,
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS',
): number {
  const delta = sentiment === 'POSITIVE' ? 5 : sentiment === 'NEGATIVE' ? -5 : 0;
  return Math.max(0, Math.min(100, currentWeight + delta));
}

/**
 * Handle the execution result from the dispatcher.
 * Extends handleExecutionResult to schedule delivery verification.
 *
 * This is called by the dispatcher after each message send.
 */
export async function handlePostSendFeedback(
  result: ExecutionResult,
  messageId: string,
  leadId: string,
  channel: ChannelId,
  deps: FeedbackLoopDependencies = {},
): Promise<void> {
  if (!result.success) return;

  // Schedule delivery verification for LinkedIn messages
  await scheduleDeliveryVerification(messageId, leadId, channel, deps);
}