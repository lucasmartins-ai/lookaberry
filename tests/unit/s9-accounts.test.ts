import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  resolveAccount,
  recordSent,
  markAccountBlocked,
  markAccountExpired,
  markAccountPaused,
} from '../../src/core/execution/accountResolver.js';
import type { ResolvedAccount } from '../../src/core/execution/accountResolver.js';

// ─────────────────────────── Mock helpers ───────────────────────────

function makeMockPrisma(accounts: ResolvedAccount[] = []) {
  const update = vi.fn().mockResolvedValue({});

  return {
    outreachAccount: {
      findMany: vi.fn().mockResolvedValue(accounts),
      update,
    },
  };
}

function makeAccount(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    id: 'account-1',
    provider: 'linkedin',
    externalId: 'linkedin-main',
    dailyLimit: 100,
    sentToday: 0,
    quotaDate: new Date(),
    pausedUntil: null,
    sessionKey: 'session-abc',
    status: 'ACTIVE',
    ...overrides,
  };
}

// ─────────────────────────── resolveAccount ───────────────────────────

describe('resolveAccount', () => {
  it('returns an ACTIVE account with quota remaining', async () => {
    const prisma = makeMockPrisma([makeAccount({ sentToday: 10, dailyLimit: 100 })]);
    const account = await resolveAccount('linkedin', prisma);
    expect(account).toBeDefined();
    expect(account!.id).toBe('account-1');
    expect(prisma.outreachAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          channelId: 'linkedin',
        }),
        orderBy: [{ updatedAt: 'asc' }],
      }),
    );
  });

  it('filters out paused accounts (pausedUntil > NOW)', async () => {
    const future = new Date(Date.now() + 3600_000);
    const prisma = makeMockPrisma([makeAccount({ pausedUntil: future })]);
    const account = await resolveAccount('linkedin', prisma);
    // The DB query already filters paused until null or <= now,
    // so this account would not appear in the findMany results.
    // The test verifies the filter condition is present.
    expect(prisma.outreachAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { pausedUntil: null },
            { pausedUntil: { lte: expect.any(Date) } },
          ],
        }),
      }),
    );
  });

  it('filters out accounts that have exhausted quota', async () => {
    const account = makeAccount({ sentToday: 100, dailyLimit: 100 });
    const prisma = makeMockPrisma([account]);
    const result = await resolveAccount('linkedin', prisma);
    expect(result).toBeNull();
  });

  it('resets sentToday when quotaDate is from a previous day', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const account = makeAccount({ sentToday: 100, dailyLimit: 100, quotaDate: yesterday });
    const prisma = makeMockPrisma([account]);
    const result = await resolveAccount('linkedin', prisma);
    // sentToday is reset in-memory, so the account is available
    expect(result).toBeDefined();
    expect(result!.sentToday).toBe(0);
  });

  it('filters out BLOCKED accounts', async () => {
    const prisma = makeMockPrisma([makeAccount({ status: 'BLOCKED' })]);
    const account = await resolveAccount('linkedin', prisma);
    // BLOCKED accounts are filtered in the query (status = ACTIVE)
    expect(prisma.outreachAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('filters out EXPIRED accounts', async () => {
    const prisma = makeMockPrisma([makeAccount({ status: 'EXPIRED' })]);
    const account = await resolveAccount('linkedin', prisma);
    expect(prisma.outreachAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('returns null when no accounts are configured for the channel', async () => {
    const prisma = makeMockPrisma([]);
    const account = await resolveAccount('whatsapp', prisma);
    expect(account).toBeNull();
  });

  it('uses round-robin ordering (updatedAt asc — least recently used first)', async () => {
    const account1 = makeAccount({ id: 'acc-1', updatedAt: new Date('2026-08-20') });
    const account2 = makeAccount({ id: 'acc-2', updatedAt: new Date('2026-08-21') });
    const account3 = makeAccount({ id: 'acc-3', updatedAt: new Date('2026-08-19') });

    // Prisma already orders by updatedAt asc, so acc-3 (oldest) should be first
    const prisma = makeMockPrisma([account1, account2, account3]);
    // Note: findMany mock doesn't reorder, so we test the orderBy argument
    await resolveAccount('linkedin', prisma);
    expect(prisma.outreachAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: 'asc' }],
      }),
    );
  });

  it('picks the first available account when multiple are available but first is exhausted', async () => {
    const acc1 = makeAccount({ id: 'acc-1', sentToday: 100, dailyLimit: 100 });
    const acc2 = makeAccount({ id: 'acc-2', sentToday: 5, dailyLimit: 50 });
    const prisma = makeMockPrisma([acc1, acc2]);
    const result = await resolveAccount('linkedin', prisma);
    expect(result).toBeDefined();
    expect(result!.id).toBe('acc-2');
  });
});

// ─────────────────────────── recordSent ───────────────────────────

describe('recordSent', () => {
  it('calls update with increment on sentToday', async () => {
    const prisma = makeMockPrisma();
    await recordSent('account-1', prisma);
    expect(prisma.outreachAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'account-1' },
        data: expect.objectContaining({
          sentToday: { increment: 1 },
          quotaDate: expect.any(Date),
        }),
      }),
    );
  });

  it('does not throw when DB is unavailable', async () => {
    const prisma = makeMockPrisma();
    prisma.outreachAccount.update.mockRejectedValue(new Error('DB down'));
    await expect(recordSent('account-1', prisma)).resolves.toBeUndefined();
  });
});

// ─────────────────────────── markAccountBlocked ───────────────────────────

describe('markAccountBlocked', () => {
  it('updates account status to BLOCKED with a reason', async () => {
    const prisma = makeMockPrisma();
    await markAccountBlocked('account-1', 'CAPTCHA detected', prisma);
    expect(prisma.outreachAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'account-1' },
        data: expect.objectContaining({
          status: 'BLOCKED',
          lastError: 'CAPTCHA detected',
        }),
      }),
    );
  });
});

// ─────────────────────────── markAccountExpired ───────────────────────────

describe('markAccountExpired', () => {
  it('updates account status to EXPIRED and clears sessionKey', async () => {
    const prisma = makeMockPrisma();
    await markAccountExpired('account-1', 'Session expired', prisma);
    expect(prisma.outreachAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'account-1' },
        data: expect.objectContaining({
          status: 'EXPIRED',
          sessionKey: null,
          lastError: 'Session expired',
        }),
      }),
    );
  });
});

// ─────────────────────────── markAccountPaused ───────────────────────────

describe('markAccountPaused', () => {
  it('updates pausedUntil on the account', async () => {
    const prisma = makeMockPrisma();
    const until = new Date(Date.now() + 24 * 3600_000);
    await markAccountPaused('account-1', until, prisma);
    expect(prisma.outreachAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'account-1' },
        data: expect.objectContaining({
          pausedUntil: until,
        }),
      }),
    );
  });
});

// ─────────────────────────── Failover scenario (integrated) ───────────────────────────

describe('Account failover scenario', () => {
  it('blocks account A, then resolves account B as the next available', async () => {
    const accountA = makeAccount({ id: 'acc-a', status: 'ACTIVE' });
    const accountB = makeAccount({ id: 'acc-b', status: 'ACTIVE' });

    // Round 1: both are available, resolve returns A (first by updatedAt asc)
    const prisma1 = makeMockPrisma([accountA, accountB]);
    const result1 = await resolveAccount('linkedin', prisma1);
    expect(result1).toBeDefined();
    expect(result1!.id).toBe('acc-a');

    // Block A
    const prisma2 = makeMockPrisma();
    await markAccountBlocked('acc-a', '403 forbidden', prisma2);
    expect(prisma2.outreachAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'acc-a' },
        data: expect.objectContaining({ status: 'BLOCKED' }),
      }),
    );

    // Round 2: A is now BLOCKED (not returned by findMany), only B is available
    const prisma3 = makeMockPrisma([makeAccount({ id: 'acc-b', status: 'ACTIVE' })]);
    const result3 = await resolveAccount('linkedin', prisma3);
    expect(result3).toBeDefined();
    expect(result3!.id).toBe('acc-b');
  });

  it('returns null when all accounts are blocked', async () => {
    const prisma = makeMockPrisma([]);
    const result = await resolveAccount('linkedin', prisma);
    expect(result).toBeNull();
  });
});