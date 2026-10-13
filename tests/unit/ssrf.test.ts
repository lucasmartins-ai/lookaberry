import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { assertPublicUrl, isBlockedIp, safeHttpOptions } from '../../src/core/security/ssrf.js';

describe('SSRF guard', () => {
  it('classifies private, loopback, link-local and mapped addresses as blocked', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('rejects internal targets, non-http schemes and credentials', async () => {
    for (const url of ['http://127.0.0.1/', 'http://localhost:3001/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'file:///etc/passwd', 'https://user:pw@example.com/']) {
      await expect(assertPublicUrl(url), url).rejects.toThrow();
    }
  });

  it('refuses IP-literal redirect targets', () => {
    expect(() => safeHttpOptions.beforeRedirect({ hostname: '169.254.169.254' })).toThrow();
    expect(() => safeHttpOptions.beforeRedirect({ hostname: 'example.com' })).not.toThrow();
  });

  describe('guarded agents', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_req, res) => res.end('internal'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('blocks a hostname that resolves to loopback at connect time', async () => {
      // sanity: reachable without the guard
      expect((await axios.get(`http://localhost:${port}/`)).data).toBe('internal');
      await expect(axios.get(`http://localhost:${port}/`, safeHttpOptions)).rejects.toThrow(/Blocked non-public/);
    });
  });
});
