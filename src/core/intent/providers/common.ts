import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { buildEvidenceContentHash, normalizeConfidence, sanitizeEvidenceData } from '../../evidence/service.js';
import type { NormalizedSignal, RawSignal, SignalProviderError } from './types.js';
import { SignalProviderError as ProviderError } from './types.js';

const MAX_SOURCE_URL_LENGTH = 1_000;
const MAX_TITLE_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 10_000;
const MAX_FETCH_BYTES = 2_000_000;
const SENSITIVE_QUERY_KEY = /(token|secret|key|auth|credential|password|cookie|session)/i;

export function clampWeight(value: number | undefined, fallback = 50): number {
  if (value === undefined || !Number.isFinite(value)) return Math.max(0, Math.min(100, fallback));
  return Math.max(0, Math.min(100, Number(value)));
}

export function clampDays(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.min(3_650, Math.floor(value)));
}

export function sanitizeSignalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().slice(0, MAX_SOURCE_URL_LENGTH);
  } catch {
    return value.trim().slice(0, MAX_SOURCE_URL_LENGTH);
  }
}

export function resolveUrl(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    return sanitizeSignalUrl(baseUrl ? new URL(value, baseUrl).toString() : value);
  } catch {
    return sanitizeSignalUrl(value);
  }
}

export function normalizeDate(value: Date | string | undefined, fallback = new Date()): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

export function canonicalizeContent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/<[a-z][\s\S]*>/i.test(trimmed)) return trimmed.replace(/\s+/g, ' ');

  const $ = cheerio.load(trimmed);
  $('script, style, noscript, svg, template').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

export function hashContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isOfficialCompanyUrl(sourceUrl: string | undefined, companyDomain: string): boolean {
  if (!sourceUrl) return false;
  try {
    const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
    const companyCandidate = companyDomain.includes('://') ? companyDomain : `https://${companyDomain}`;
    const companyHost = new URL(companyCandidate).hostname.replace(/^www\./, '').toLowerCase();
    return sourceHost === companyHost || sourceHost.endsWith(`.${companyHost}`);
  } catch {
    return false;
  }
}

export async function fetchPublicUrl(url: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
        'user-agent': 'LookaBerry/0.1 public-signal-provider',
      },
    });
    if (!response.ok) {
      throw new ProviderError('FAILED', `Public URL returned HTTP ${response.status}: ${url}`);
    }
    return (await response.text()).slice(0, MAX_FETCH_BYTES);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError('TIMEOUT', `Timed out fetching public URL: ${url}`);
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('FAILED', error instanceof Error ? error.message : `Failed to fetch public URL: ${url}`);
  } finally {
    clearTimeout(timeout);
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildDeduplicationKey(signal: Pick<RawSignal, 'providerId' | 'companyDomain' | 'signalType' | 'sourceUrl' | 'title'> & { identity?: unknown }): string {
  return createHash('sha256')
    .update(stableSerialize({
      providerId: signal.providerId,
      companyDomain: signal.companyDomain,
      signalType: signal.signalType,
      sourceUrl: sanitizeSignalUrl(signal.sourceUrl),
      title: signal.title.trim().toLowerCase(),
      identity: signal.identity ?? null,
    }))
    .digest('hex');
}

export function normalizeProviderSignal(signal: RawSignal): NormalizedSignal {
  const observedAt = normalizeDate(signal.observedAt);
  const ttlDays = clampDays(signal.ttlDays, 30);
  const normalizedData = sanitizeEvidenceData(signal.normalizedData ?? {}) as NormalizedSignal['normalizedData'];
  const rawData = sanitizeEvidenceData(signal.rawData) as NormalizedSignal['rawData'];
  const metadata = sanitizeEvidenceData(signal.metadata ?? {}) as NormalizedSignal['metadata'];
  const sourceUrl = sanitizeSignalUrl(signal.sourceUrl);
  const deduplicationKey = signal.deduplicationKey ?? buildDeduplicationKey({ ...signal, sourceUrl });

  return {
    providerId: signal.providerId.trim().slice(0, 100),
    companyDomain: signal.companyDomain.trim().toLowerCase(),
    companyName: signal.companyName.trim().slice(0, 255),
    companyIndustry: signal.companyIndustry?.trim(),
    companyDescription: signal.companyDescription?.trim(),
    companyTechStack: signal.companyTechStack,
    signalType: signal.signalType.trim().toUpperCase(),
    source: signal.source.trim().slice(0, 100),
    sourceUrl,
    title: signal.title.trim().slice(0, MAX_TITLE_LENGTH),
    summary: signal.summary.trim().slice(0, MAX_SUMMARY_LENGTH),
    observedAt,
    expiresAt: new Date(observedAt.getTime() + ttlDays * 24 * 60 * 60 * 1_000),
    ttlDays,
    confidence: normalizeConfidence(signal.confidence),
    sourceQuality: normalizeConfidence(signal.sourceQuality ?? 0.5),
    intentWeight: clampWeight(signal.intentWeight),
    evidenceClassification: signal.evidenceClassification ?? 'UNVERIFIED',
    normalizedData,
    rawData,
    metadata,
    cost: Math.max(0, Number.isFinite(signal.cost) ? Number(signal.cost) : 0),
    contentHash: buildEvidenceContentHash(normalizedData, rawData),
    deduplicationKey: deduplicationKey.slice(0, 255),
  };
}

export function extractVisibleText(html: string): string {
  return canonicalizeContent(html);
}

export function parseJsonLd(html: string): unknown[] {
  const $ = cheerio.load(html);
  const values: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      if (Array.isArray(parsed)) values.push(...parsed);
      else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { '@graph'?: unknown[] })['@graph'])) {
        values.push(...((parsed as { '@graph': unknown[] })['@graph']));
      } else values.push(parsed);
    } catch {
      // Public pages commonly contain malformed or non-JSON script blocks.
    }
  });
  return values;
}

export function isProviderError(error: unknown): error is SignalProviderError {
  return error instanceof ProviderError;
}
