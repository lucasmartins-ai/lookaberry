import * as cheerio from 'cheerio';
import { buildDeduplicationKey, fetchPublicUrl, isOfficialCompanyUrl, normalizeDate, normalizeProviderSignal, resolveUrl, sanitizeSignalUrl } from './common.js';
import type { JobPostingInput, RawSignal, SignalCollectionInput, SignalProvider } from './types.js';
import { SignalProviderError } from './types.js';

const TTL_DAYS = 30;
const PROVIDER_ID = 'hiring';
const JOB_TITLE_NOISE = /^(careers?|jobs?|view jobs?|open positions?|join us|learn more)$/i;

function hiringUrl(input: SignalCollectionInput): string | undefined {
  return sanitizeSignalUrl(input.hiring_url ?? input.company_website_url);
}

function buildRawSignal(input: SignalCollectionInput, posting: JobPostingInput, fallbackUrl?: string): RawSignal | undefined {
  const title = posting.title.trim();
  if (!title || JOB_TITLE_NOISE.test(title)) return undefined;
  const sourceUrl = resolveUrl(posting.url, fallbackUrl) ?? fallbackUrl;
  const official = isOfficialCompanyUrl(sourceUrl, input.company_domain);
  return {
    providerId: PROVIDER_ID,
    companyDomain: input.company_domain,
    companyName: input.company_name,
    companyIndustry: input.company_industry,
    companyDescription: input.company_description,
    companyTechStack: input.company_tech_stack,
    signalType: 'HIRING',
    source: official ? 'OFFICIAL_CAREERS_PAGE' : 'PUBLIC_JOB_BOARD',
    sourceUrl,
    title: `Hiring: ${title}`,
    summary: posting.description?.trim() || `The company has a public opening for ${title}.`,
    observedAt: normalizeDate(posting.published_at),
    ttlDays: TTL_DAYS,
    confidence: official ? 0.95 : 0.8,
    sourceQuality: official ? 1 : 0.75,
    intentWeight: 75,
    evidenceClassification: 'FACT',
    normalizedData: {
      role_title: title,
      posting_url: sourceUrl ?? null,
      department: posting.department ?? null,
    },
    rawData: {
      title,
      url: sourceUrl ?? null,
      description: posting.description ?? null,
      department: posting.department ?? null,
      metadata: posting.metadata ?? {},
    },
    metadata: { collection_mode: 'provided_posting' },
    cost: 0,
    deduplicationKey: buildDeduplicationKey({
      providerId: PROVIDER_ID,
      companyDomain: input.company_domain,
      signalType: 'HIRING',
      sourceUrl,
      title,
      identity: title.toLowerCase(),
    }),
  };
}

function parseJobPostingJsonLd(input: SignalCollectionInput, html: string, fallbackUrl?: string): RawSignal[] {
  const $ = cheerio.load(html);
  const postings: RawSignal[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const value = JSON.parse($(element).text()) as Record<string, unknown> | Record<string, unknown>[];
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (candidate['@type'] !== 'JobPosting' || typeof candidate.title !== 'string') continue;
        const raw = buildRawSignal(input, {
          title: candidate.title,
          url: typeof candidate.url === 'string' ? candidate.url : undefined,
          description: typeof candidate.description === 'string' ? candidate.description : undefined,
          published_at: typeof candidate.datePosted === 'string' ? candidate.datePosted : undefined,
          metadata: { source: 'json_ld' },
        }, fallbackUrl);
        if (raw) postings.push(raw);
      }
    } catch {
      // Ignore malformed public JSON-LD and continue with regular HTML parsing.
    }
  });
  return postings;
}

function parseHiringHtml(input: SignalCollectionInput, html: string, fallbackUrl?: string): RawSignal[] {
  const $ = cheerio.load(html);
  const postings = parseJobPostingJsonLd(input, html, fallbackUrl);
  const selectors = [
    '[data-job-title]',
    '[data-job-name]',
    'a[href*="/jobs/"]',
    'a[href*="/job/"]',
    'a[href*="/careers/"]',
    '.job-card a',
    '[class*="job-card"] a',
  ];
  const seen = new Set(postings.map(signal => signal.deduplicationKey));
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const title = ($(element).attr('data-job-title') || $(element).attr('data-job-name') || $(element).text()).replace(/\s+/g, ' ').trim();
      const raw = buildRawSignal(input, {
        title,
        url: $(element).attr('href'),
      }, fallbackUrl);
      if (raw && !seen.has(raw.deduplicationKey)) {
        seen.add(raw.deduplicationKey);
        postings.push(raw);
      }
    });
  }
  return postings;
}

export const hiringProvider: SignalProvider = {
  id: PROVIDER_ID,
  type: 'hiring',
  source: 'PUBLIC_HIRING',
  cost: 0,
  ttlDays: TTL_DAYS,

  getAvailability(input) {
    if (input.job_postings?.length || input.hiring_html || input.hiring_url) return { status: 'IMPLEMENTED' };
    return { status: 'NOT_AVAILABLE', reason: 'A hiring URL, crawl HTML, or normalized job postings are required.' };
  },

  async collect(input) {
    const fallbackUrl = hiringUrl(input);
    if (input.job_postings?.length) {
      return input.job_postings.map(posting => buildRawSignal(input, posting, fallbackUrl)).filter((signal): signal is RawSignal => Boolean(signal));
    }
    const html = input.hiring_html ?? (fallbackUrl ? await fetchPublicUrl(fallbackUrl) : '');
    if (!html.trim()) throw new SignalProviderError('NOT_AVAILABLE', 'The hiring page was empty.');
    return parseHiringHtml(input, html, fallbackUrl);
  },

  normalize(signal) {
    return [normalizeProviderSignal(signal)];
  },
};
