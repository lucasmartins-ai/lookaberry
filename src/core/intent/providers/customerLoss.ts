import { buildDeduplicationKey, canonicalizeContent, fetchPublicUrl, hashContent, isOfficialCompanyUrl, normalizeDate, normalizeProviderSignal, sanitizeSignalUrl } from './common.js';
import type { RawSignal, ReviewInput, SignalCollectionInput, SignalProvider } from './types.js';

/**
 * CUSTOMER_LOSS: evidence that a local business loses customers for lack of automation.
 * - Reviews where customers say they could not reach or book the business (FACT, quoted).
 * - Website with no online booking and no chat/WhatsApp entry point (INFERENCE).
 * Plain substring matching on lowercased, length-capped text: no regex, no ReDoS surface.
 * Review text is kept as evidence only; it must never be interpolated into outreach copy.
 */
const PROVIDER_ID = 'customer-loss';
const TTL_DAYS = 60;
const MAX_REVIEWS = 200;
const MAX_REVIEW_CHARS = 2_000;
const MAX_QUOTES = 5;

// ponytail: fixed phrase lists (en + pt-BR); widen from real misses, swap for a TypeSafe classifier if recall stalls
export const UNREACHABLE_PHRASES = [
  "couldn't get through", 'could not get through', 'no one answered', 'nobody answered', 'no one answers',
  'nobody answers', 'never answer', "didn't answer", 'did not answer', 'never called back', 'never call back',
  "didn't call back", 'no call back', 'no callback', 'voicemail', 'on hold for', 'phone just rang', 'rang and rang',
  'impossible to book', "couldn't book", 'could not book', 'hard to book', 'difficult to book', 'no reply',
  'never replied', "didn't respond", 'did not respond', 'never responded', 'no response', 'ignored my',
  'trying to get hold of', 'never heard back', "haven't heard", 'have not heard', 'never received a call',
  'never got a call', 'will call me back, but', 'call me back but', 'put the phone down', 'hung up on',
  'days to get to talk', 'days to get through',
  'não atende', 'ninguém atende', 'nunca atende', 'não responde', 'não respondem', 'não retornaram',
  'nunca retornaram', 'sem resposta', 'difícil agendar', 'não consegui agendar', 'caixa postal',
];

export const BOOKING_MARKERS = [
  'calendly.com', 'acuityscheduling', 'setmore', 'simplybook', 'booksy', 'fresha', 'treatwell', 'cliniko',
  'jane.app', 'dentally', 'vetstoria', 'petsapp', 'pabau', 'phorest', 'gettimely', 'squareup.com/appointments',
  'zocdoc', 'doctolib', 'writeupp', 'that-time.co.uk', 'zenoti.com', 'facesconsent.com', 'vagaro', 'mindbodyonline', 'book online', 'online booking', 'book an appointment online', 'agendar online',
  'agende online', 'agendamento online',
];

export const CHAT_MARKERS = [
  'intercom', 'tawk.to', 'crisp.chat', 'livechatinc', 'drift.com', 'js.usemessages.com', 'tidio', 'zdassets',
  'wa.me/', 'api.whatsapp.com', 'chatbot',
];

export function findComplaints(reviews: ReviewInput[]): { quote: string; phrase: string; rating?: number }[] {
  const hits: { quote: string; phrase: string; rating?: number }[] = [];
  const seen = new Set<string>();
  for (const review of reviews.slice(0, MAX_REVIEWS)) {
    const text = (review.text ?? '').slice(0, MAX_REVIEW_CHARS);
    const lower = text.toLowerCase();
    if (seen.has(lower)) continue; // same review often arrives in both default and extended lists
    seen.add(lower);
    const phrase = UNREACHABLE_PHRASES.find(p => lower.includes(p));
    if (phrase) hits.push({ quote: text.slice(0, 280), phrase, rating: review.rating });
  }
  return hits;
}

export function detectWebsiteGap(rawHtml: string): { hasBooking: boolean; hasChat: boolean } {
  const lower = rawHtml.slice(0, 2_000_000).toLowerCase();
  return {
    hasBooking: BOOKING_MARKERS.some(m => lower.includes(m)),
    hasChat: CHAT_MARKERS.some(m => lower.includes(m)),
  };
}

function websiteUrl(input: SignalCollectionInput): string | undefined {
  return sanitizeSignalUrl(input.website_url ?? input.company_website_url);
}

function base(input: SignalCollectionInput, sourceUrl: string | undefined) {
  return {
    providerId: PROVIDER_ID,
    companyDomain: input.company_domain,
    companyName: input.company_name,
    companyIndustry: input.company_industry,
    companyDescription: input.company_description,
    companyTechStack: input.company_tech_stack,
    signalType: 'CUSTOMER_LOSS',
    sourceUrl,
    observedAt: normalizeDate(undefined),
    ttlDays: TTL_DAYS,
    cost: 0,
  };
}

export const customerLossProvider: SignalProvider = {
  id: PROVIDER_ID,
  type: 'customer_loss',
  source: 'PUBLIC_REVIEWS_AND_WEBSITE',
  cost: 0,
  ttlDays: TTL_DAYS,

  getAvailability(input) {
    if (input.reviews?.length || input.website_html || websiteUrl(input)) return { status: 'IMPLEMENTED' };
    return { status: 'NOT_AVAILABLE', reason: 'Reviews or a website URL/HTML snapshot is required.' };
  },

  async collect(input) {
    const signals: RawSignal[] = [];

    const complaints = findComplaints(input.reviews ?? []);
    if (complaints.length) {
      const reviewsUrl = sanitizeSignalUrl(input.reviews_url);
      const title = `${complaints.length} review(s) report customers unable to reach or book`;
      signals.push({
        ...base(input, reviewsUrl),
        source: 'PUBLIC_REVIEWS',
        title,
        summary: `${complaints.length} of ${Math.min(input.reviews!.length, MAX_REVIEWS)} public reviews for ${input.company_name} describe unanswered calls, no reply or failed booking.`,
        confidence: 0.9,
        sourceQuality: 0.8,
        intentWeight: Math.min(95, 60 + complaints.length * 8),
        evidenceClassification: 'FACT',
        normalizedData: {
          complaint_count: complaints.length,
          reviews_scanned: Math.min(input.reviews!.length, MAX_REVIEWS),
          phrases: [...new Set(complaints.map(c => c.phrase))],
        },
        rawData: { quotes: complaints.slice(0, MAX_QUOTES) },
        metadata: { detected_by: 'review_phrase_match', copy_safe: false },
        deduplicationKey: buildDeduplicationKey({
          providerId: PROVIDER_ID, companyDomain: input.company_domain, signalType: 'CUSTOMER_LOSS',
          sourceUrl: reviewsUrl, title: 'reviews', identity: hashContent(complaints.map(c => c.quote).join('|')),
        }),
      });
    }

    const sourceUrl = websiteUrl(input);
    const rawHtml = input.website_html ?? (sourceUrl ? await fetchPublicUrl(sourceUrl).catch(() => '') : '');
    if (!input.booking_links?.length && rawHtml && canonicalizeContent(rawHtml)) {
      const gap = detectWebsiteGap(rawHtml);
      if (!gap.hasBooking && !gap.hasChat) {
        signals.push({
          ...base(input, sourceUrl),
          source: 'PUBLIC_WEBSITE',
          title: 'No online booking or chat on website',
          summary: `The public website of ${input.company_name} shows no online booking and no chat or WhatsApp entry point, so enquiries outside opening hours depend on the phone.`,
          confidence: 0.7,
          sourceQuality: isOfficialCompanyUrl(sourceUrl, input.company_domain) ? 1 : 0.8,
          intentWeight: 55,
          evidenceClassification: 'INFERENCE',
          normalizedData: { has_online_booking: false, has_chat: false },
          rawData: { checked_markers: BOOKING_MARKERS.length + CHAT_MARKERS.length, html_length: rawHtml.length },
          metadata: { detected_by: 'website_marker_scan' },
          deduplicationKey: buildDeduplicationKey({
            providerId: PROVIDER_ID, companyDomain: input.company_domain, signalType: 'CUSTOMER_LOSS',
            sourceUrl, title: 'website-gap', identity: 'no-booking-no-chat',
          }),
        });
      }
    }
    return signals;
  },

  normalize(signal) {
    return [normalizeProviderSignal(signal)];
  },
};
