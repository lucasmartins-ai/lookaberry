import { describe, expect, it, beforeEach, vi } from 'vitest';

const findUnique = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  prisma: { apiKey: { findUnique, update: vi.fn().mockResolvedValue({}) } },
}));

const { validateKey, clearKeyCache, isTotpProtected } = await import('../../src/api/plugins/auth.js');

const viewerKey = {
  id: 'key-viewer',
  key: 'sk_db_viewer',
  name: 'viewer',
  permission: 'VIEWER',
  userId: null,
  teamId: null,
  campaignIds: [],
  active: true,
  expiresAt: null,
  lastUsedAt: null,
  requireTotp: true,
  version: 1,
  createdAt: new Date(),
};

describe('API key cache', () => {
  beforeEach(() => {
    process.env.API_KEYS = '';
    clearKeyCache();
    findUnique.mockReset();
  });

  it('keeps the real permission and TOTP flag on a cache hit', async () => {
    findUnique.mockResolvedValue(viewerKey);
    await validateKey('sk_db_viewer'); // fills the cache
    const cached = await validateKey('sk_db_viewer');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(cached?.permission).toBe('VIEWER');
    expect(cached?.requireTotp).toBe(true);
  });

  it('re-reads the DB after clearKeyCache (revoked key is rejected)', async () => {
    findUnique.mockResolvedValueOnce(viewerKey).mockResolvedValueOnce({ ...viewerKey, active: false });
    expect(await validateKey('sk_db_viewer')).not.toBeNull();
    clearKeyCache();
    expect(await validateKey('sk_db_viewer')).toBeNull();
  });
});

describe('TOTP-protected routes', () => {
  it('covers admin and event ingestion (both can write suppression), not ordinary routes', () => {
    expect(isTotpProtected('/api/v1/admin/api-keys')).toBe(true);
    expect(isTotpProtected('/api/v1/events')).toBe(true);
    expect(isTotpProtected('/api/v1/eventsX')).toBe(false);
    expect(isTotpProtected('/api/v1/campaigns')).toBe(false);
  });
});
