// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';
import { isAllowedPath } from '../lib/proxyAllowlist';

const req = (auth?: string) =>
  new NextRequest('http://localhost:3001/api/v1/campaigns', auth ? { headers: { authorization: auth } } : undefined);

describe('dashboard basic auth', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects missing or wrong credentials when configured', () => {
    vi.stubEnv('DASHBOARD_USER', 'ops');
    vi.stubEnv('DASHBOARD_PASSWORD', 's3cret');
    expect(middleware(req()).status).toBe(401);
    expect(middleware(req(`Basic ${btoa('ops:wrong')}`)).status).toBe(401);
  });

  it('lets valid credentials through', () => {
    vi.stubEnv('DASHBOARD_USER', 'ops');
    vi.stubEnv('DASHBOARD_PASSWORD', 's3cret');
    expect(middleware(req(`Basic ${btoa('ops:s3cret')}`)).headers.get('x-middleware-next')).toBe('1');
  });

  it('fails closed in production when credentials are not set', () => {
    vi.stubEnv('DASHBOARD_USER', '');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(middleware(req()).status).toBe(503);
  });
});

describe('dashboard proxy allowlist', () => {
  it('forwards only the routes the dashboard uses', () => {
    expect(isAllowedPath('/api/v1/campaigns')).toBe(true);
    expect(isAllowedPath('/api/v1/campaigns/c1/ab-tests/g%201/promote')).toBe(true);
    expect(isAllowedPath('/api/v1/health/sync')).toBe(true);
  });

  it('refuses admin and traversal attempts', () => {
    for (const p of ['/api/v1/admin/api-keys', '/api/v1/campaigns/x/../../admin', '/api/v1/campaigns/./x', '/api/v1/health/db', '/sse']) {
      expect(isAllowedPath(p), p).toBe(false);
    }
  });
});
