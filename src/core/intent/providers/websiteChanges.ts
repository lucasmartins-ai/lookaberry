import { buildDeduplicationKey, canonicalizeContent, fetchPublicUrl, hashContent, isOfficialCompanyUrl, normalizeDate, normalizeProviderSignal, sanitizeSignalUrl } from './common.js';
import type { RawSignal, SignalCollectionInput, SignalProvider } from './types.js';
import { SignalProviderError } from './types.js';

const TTL_DAYS = 14;
const PROVIDER_ID = 'website-changes';

function currentWebsiteUrl(input: SignalCollectionInput): string | undefined {
  return sanitizeSignalUrl(input.website_url ?? input.company_website_url);
}

export const websiteChangesProvider: SignalProvider = {
  id: PROVIDER_ID,
  type: 'website_changes',
  source: 'PUBLIC_WEBSITE',
  cost: 0,
  ttlDays: TTL_DAYS,

  getAvailability(input) {
    const hasCurrentSnapshot = Boolean(input.website_content || input.website_html || currentWebsiteUrl(input));
    const hasComparison = Boolean(input.previous_website_content || input.previous_website_html);
    const hasAgentAssertion = input.website_changed !== undefined;
    if (hasCurrentSnapshot && (hasComparison || hasAgentAssertion)) return { status: 'IMPLEMENTED' };
    if (hasCurrentSnapshot) {
      return { status: 'NOT_AVAILABLE', reason: 'A previous website snapshot or explicit website_changed value is required.' };
    }
    return { status: 'NOT_AVAILABLE', reason: 'A website URL or crawl snapshot is required.' };
  },

  async collect(input) {
    const sourceUrl = currentWebsiteUrl(input);
    const currentInput = input.website_content ?? input.website_html;
    const previousInput = input.previous_website_content ?? input.previous_website_html;
    const currentRaw = currentInput ?? (sourceUrl ? await fetchPublicUrl(sourceUrl) : '');
    const currentContent = canonicalizeContent(currentRaw);
    if (!currentContent) {
      throw new SignalProviderError('NOT_AVAILABLE', 'The website snapshot was empty.');
    }

    const currentHash = hashContent(currentContent);
    const previousContent = previousInput ? canonicalizeContent(previousInput) : '';
    const previousHash = previousContent ? hashContent(previousContent) : undefined;
    const changedByComparison = Boolean(previousHash && previousHash !== currentHash);
    const changedByInput = input.website_changed === true;

    if (input.website_changed === false || (!changedByComparison && !changedByInput)) return [];

    const classification = changedByComparison ? 'FACT' : 'UNVERIFIED';
    const confidence = changedByComparison ? 0.95 : 0.6;
    const normalizedData = {
      change_detected: true,
      comparison: changedByComparison ? 'snapshot_hash' : 'agent_reported',
      current_hash: currentHash,
      previous_hash: previousHash ?? null,
      content_length: currentContent.length,
    };
    const rawData = {
      current_hash: currentHash,
      previous_hash: previousHash ?? null,
      current_excerpt: currentContent.slice(0, 2_000),
    };

    const rawSignal: RawSignal = {
      providerId: PROVIDER_ID,
      companyDomain: input.company_domain,
      companyName: input.company_name,
      companyIndustry: input.company_industry,
      companyDescription: input.company_description,
      companyTechStack: input.company_tech_stack,
      signalType: 'WEBSITE_CHANGE',
      source: 'PUBLIC_WEBSITE',
      sourceUrl,
      title: 'Website content changed',
      summary: `A public website snapshot changed for ${input.company_domain}.`,
      observedAt: normalizeDate(undefined),
      ttlDays: TTL_DAYS,
      confidence,
      sourceQuality: isOfficialCompanyUrl(sourceUrl, input.company_domain) ? 1 : 0.85,
      intentWeight: 65,
      evidenceClassification: classification,
      normalizedData,
      rawData,
      metadata: { detected_by: changedByComparison ? 'snapshot_comparison' : 'agent_report' },
      cost: 0,
      deduplicationKey: buildDeduplicationKey({
        providerId: PROVIDER_ID,
        companyDomain: input.company_domain,
        signalType: 'WEBSITE_CHANGE',
        sourceUrl,
        title: 'Website content changed',
        identity: currentHash,
      }),
    };
    return [rawSignal];
  },

  normalize(signal) {
    return [normalizeProviderSignal(signal)];
  },
};
