import type { ChannelId } from '../channels/types.js';

export interface ResolvedAccount {
  id: string;
  provider: string;
  externalId: string;
  dailyLimit: number;
  sentToday: number;
  quotaDate: Date | string;
  pausedUntil: Date | string | null;
  sessionKey: string | null;
  status: string;
  updatedAt?: Date | string;
}

interface PrismaLike {
  outreachAccount: {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>[];
      take?: number;
    }) => Promise<ResolvedAccount[]>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

/**
 * Resolve the best available account for a given channel.
 *
 * Rules:
 * 1. Filter: status = ACTIVE, pausedUntil is null or <= NOW, quotaDate reset logic,
 *    sentToday < dailyLimit
 * 2. Sort: least-recently-used first (round-robin via updatedAt asc)
 * 3. Return the first available, or null
 */
export async function resolveAccount(
  channel: ChannelId,
  prisma: PrismaLike,
): Promise<ResolvedAccount | null> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const accounts = await prisma.outreachAccount.findMany({
    where: {
      status: 'ACTIVE',
      channelId: channel,
      OR: [
        { pausedUntil: null },
        { pausedUntil: { lte: now } },
      ],
    },
    orderBy: [{ updatedAt: 'asc' }],
  });

  // Filter by quota in-memory (quotaDate logic)
  for (const account of accounts) {
    const quotaDate = account.quotaDate ? new Date(account.quotaDate) : null;
    const isNewDay = !quotaDate || quotaDate < today;

    if (isNewDay) {
      // Reset quota for a new day
      account.sentToday = 0;
    }

    if (account.sentToday < account.dailyLimit) {
      return account;
    }
  }

  return null;
}

/**
 * Record a successful send for an account (increment sentToday).
 */
export async function recordSent(
  accountId: string,
  prisma: PrismaLike,
): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    await prisma.outreachAccount.update({
      where: { id: accountId },
      data: {
        sentToday: { increment: 1 },
        quotaDate: today,
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn(`[AccountResolver] Could not record sent for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Mark an account as BLOCKED after a permanent failure signal.
 */
export async function markAccountBlocked(
  accountId: string,
  reason: string,
  prisma: PrismaLike,
): Promise<void> {
  try {
    await prisma.outreachAccount.update({
      where: { id: accountId },
      data: {
        status: 'BLOCKED',
        lastError: reason,
        updatedAt: new Date(),
      },
    });
    console.warn(`[AccountResolver] Account ${accountId} marked BLOCKED: ${reason}`);
  } catch (err) {
    console.warn(`[AccountResolver] Could not block account ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Mark an account as EXPIRED (session expired — LinkedIn).
 */
export async function markAccountExpired(
  accountId: string,
  reason: string,
  prisma: PrismaLike,
): Promise<void> {
  try {
    await prisma.outreachAccount.update({
      where: { id: accountId },
      data: {
        status: 'EXPIRED',
        sessionKey: null,
        lastError: reason,
        updatedAt: new Date(),
      },
    });
    console.warn(`[AccountResolver] Account ${accountId} marked EXPIRED: ${reason}`);
  } catch (err) {
    console.warn(`[AccountResolver] Could not expire account ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Pause an account until a specific timestamp (e.g. after rate limit).
 */
export async function markAccountPaused(
  accountId: string,
  until: Date,
  prisma: PrismaLike,
): Promise<void> {
  try {
    await prisma.outreachAccount.update({
      where: { id: accountId },
      data: {
        pausedUntil: until,
        updatedAt: new Date(),
      },
    });
    console.warn(`[AccountResolver] Account ${accountId} paused until ${until.toISOString()}`);
  } catch (err) {
    console.warn(`[AccountResolver] Could not pause account ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}