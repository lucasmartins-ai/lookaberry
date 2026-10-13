/**
 * SSRF guard for outbound fetches of user/lead-supplied URLs.
 *
 * - assertPublicUrl(): http(s) only, no credentials, and every resolved address must be public.
 * - safeHttpOptions: axios options whose agents re-check each connection (redirects, DNS rebinding).
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [range, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) blocked.addSubnet(range, prefix, 'ipv4');
for (const [range, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
] as const) blocked.addSubnet(range, prefix, 'ipv6');

export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = net.isIP(bare);
  if (family === 4) return blocked.check(bare, 'ipv4');
  if (family === 6) return blocked.check(bare, 'ipv6');
  return true; // not an IP at all — refuse
}

function assertPublicHost(hostname: string): void {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) && isBlockedIp(bare)) throw new Error(`Blocked non-public address: ${hostname}`);
}

/** Parse and validate a URL, resolving its host; throws if it points anywhere non-public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Blocked URL scheme: ${url.protocol}`);
  if (url.username || url.password) throw new Error('Blocked URL with credentials');
  assertPublicHost(url.hostname);
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(bare)) {
    const addrs = await dns.promises.lookup(bare, { all: true });
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad) throw new Error(`Blocked non-public address for ${url.hostname}: ${bad.address}`);
  }
  return url;
}

/** dns.lookup replacement that refuses non-public results, so every connection (incl. redirects) is checked. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, '', 4);
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad) return callback(new Error(`Blocked non-public address for ${hostname}: ${bad.address}`), '', 4);
    if ((options as dns.LookupOptions).all) return (callback as any)(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
};

export const safeHttpOptions = {
  httpAgent: new http.Agent({ lookup: guardedLookup }),
  httpsAgent: new https.Agent({ lookup: guardedLookup }),
  maxRedirects: 5,
  maxContentLength: 5 * 1024 * 1024,
  // IP-literal redirect targets skip DNS lookup, so check them here
  beforeRedirect: (options: { hostname?: string }) => assertPublicHost(options.hostname ?? ''),
};
