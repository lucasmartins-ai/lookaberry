import * as cheerio from 'cheerio';
import { buildDeduplicationKey, fetchPublicUrl, isOfficialCompanyUrl, normalizeDate, normalizeProviderSignal, resolveUrl, sanitizeSignalUrl } from './common.js';
import type { AnnouncementInput, RawSignal, SignalCollectionInput, SignalProvider } from './types.js';
import { SignalProviderError } from './types.js';

const PROVIDER_ID = 'public-announcements';
const DEFAULT_TTL_DAYS = 45;
const FUNDING_PATTERN = /\b(series\s+[a-z]|funding|funded|investment|invested|raises?|raised|capital|acqui(?:re|red|sition)|merger|ipo)\b/i;
const NOISE_TITLE = /^(home|news|blog|press|read more|learn more)$/i;

function announcementsUrl(input: SignalCollectionInput): string | undefined {
  return sanitizeSignalUrl(input.announcements_url ?? input.company_website_url);
}

function signalTypeFor(title: string, kind?: string): 'FUNDING' | 'PUBLIC_ANNOUNCEMENT' {
  return FUNDING_PATTERN.test(`${kind ?? ''} ${title}`) ? 'FUNDING' : 'PUBLIC_ANNOUNCEMENT';
}

function buildRawSignal(input: SignalCollectionInput, item: AnnouncementInput, fallbackUrl?: string): RawSignal | undefined {
  const title = item.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length < 5 || NOISE_TITLE.test(title)) return undefined;
  const sourceUrl = resolveUrl(item.url, fallbackUrl) ?? fallbackUrl;
  const official = isOfficialCompanyUrl(sourceUrl, input.company_domain);
  const signalType = signalTypeFor(title, item.kind);
  const ttlDays = signalType === 'FUNDING' ? 60 : DEFAULT_TTL_DAYS;
  return {
    providerId: PROVIDER_ID,
    companyDomain: input.company_domain,
    companyName: input.company_name,
    companyIndustry: input.company_industry,
    companyDescription: input.company_description,
    companyTechStack: input.company_tech_stack,
    signalType,
    source: official ? 'OFFICIAL_ANNOUNCEMENT' : 'PUBLIC_NEWS',
    sourceUrl,
    title,
    summary: item.summary?.trim() || `A public announcement was published by ${input.company_name}.`,
    observedAt: normalizeDate(item.published_at),
    ttlDays,
    confidence: official ? 0.95 : 0.8,
    sourceQuality: official ? 1 : 0.7,
    intentWeight: signalType === 'FUNDING' ? 85 : 60,
    evidenceClassification: 'FACT',
    normalizedData: {
      announcement_type: signalType,
      title,
      url: sourceUrl ?? null,
      published_at: item.published_at ? normalizeDate(item.published_at).toISOString() : null,
    },
    rawData: {
      title,
      url: sourceUrl ?? null,
      summary: item.summary ?? null,
      kind: item.kind ?? null,
      metadata: item.metadata ?? {},
    },
    metadata: { collection_mode: 'provided_announcement' },
    cost: 0,
    deduplicationKey: buildDeduplicationKey({
      providerId: PROVIDER_ID,
      companyDomain: input.company_domain,
      signalType,
      sourceUrl,
      title,
      identity: item.published_at ? normalizeDate(item.published_at).toISOString() : title.toLowerCase(),
    }),
  };
}

function parseAnnouncementsHtml(input: SignalCollectionInput, html: string, fallbackUrl?: string): RawSignal[] {
  const $ = cheerio.load(html);
  const announcements: RawSignal[] = [];
  const selectors = ['article', '[itemtype*="NewsArticle"]', '[class*="press"]', '[class*="news-item"]'];
  const seen = new Set<string>();
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const title = $(element).find('h1, h2, h3, [itemprop="headline"]').first().text().replace(/\s+/g, ' ').trim();
      const summary = $(element).find('p, [itemprop="description"]').first().text().replace(/\s+/g, ' ').trim();
      const url = $(element).find('a[href]').first().attr('href');
      const publishedAtAttribute = $(element).find('time[datetime], [itemprop="datePublished"]').first().attr('datetime');
      const publishedAtText = $(element).find('[itemprop="datePublished"]').first().text().trim();
      const publishedAt = publishedAtAttribute || publishedAtText || undefined;
      const raw = buildRawSignal(input, { title, summary, url, published_at: publishedAt, metadata: { source: 'html' } }, fallbackUrl);
      const key = raw?.deduplicationKey;
      if (raw && key && !seen.has(key)) {
        seen.add(key);
        announcements.push(raw);
      }
    });
  }

  if (!announcements.length) {
    const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text();
    const summary = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    const raw = buildRawSignal(input, { title, summary, url: fallbackUrl, metadata: { source: 'page_metadata' } }, fallbackUrl);
    if (raw) announcements.push(raw);
  }
  return announcements;
}

export const publicAnnouncementsProvider: SignalProvider = {
  id: PROVIDER_ID,
  type: 'public_announcements',
  source: 'PUBLIC_ANNOUNCEMENTS',
  cost: 0,
  ttlDays: DEFAULT_TTL_DAYS,

  getAvailability(input) {
    if (input.announcement_items?.length || input.announcements_html || input.announcements_url) return { status: 'IMPLEMENTED' };
    return { status: 'NOT_AVAILABLE', reason: 'An announcements URL, crawl HTML, or normalized public items are required.' };
  },

  async collect(input) {
    const fallbackUrl = announcementsUrl(input);
    if (input.announcement_items?.length) {
      return input.announcement_items.map(item => buildRawSignal(input, item, fallbackUrl)).filter((signal): signal is RawSignal => Boolean(signal));
    }
    const html = input.announcements_html ?? (fallbackUrl ? await fetchPublicUrl(fallbackUrl) : '');
    if (!html.trim()) throw new SignalProviderError('NOT_AVAILABLE', 'The announcements page was empty.');
    return parseAnnouncementsHtml(input, html, fallbackUrl);
  },

  normalize(signal) {
    return [normalizeProviderSignal(signal)];
  },
};
