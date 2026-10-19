/**
 * Rank Google Maps places by CUSTOMER_LOSS evidence (dry run: no DB writes).
 *
 * usage: npx tsx scripts/customer-loss-scan.ts <maps-leads.jsonl> [--no-web]
 * Input = JSONL from `maps-leads scrape -json -extra-reviews` (lookacrawler 2/google-maps-scraper):
 *   PLAYWRIGHT_BROWSERS_PATH=~/Library/Caches/ms-playwright maps-leads scrape -input q.txt \
 *     -results out.jsonl -json -depth 1 -lang en -extra-reviews
 *   (binary does not exit on a full page: stop it once out.jsonl size is stable, kill by ancestry)
 * Output = ranked table on stdout + <input>.customer-loss.json next to the input.
 */
import fs from 'node:fs';
import { collectAndNormalizeProvider, customerLossProvider } from '../src/core/intent/providers/index.js';
import type { SignalCollectionInput } from '../src/core/intent/providers/types.js';

interface MapsPlace {
  title: string;
  web_site?: string;
  link?: string;
  phone?: string;
  category?: string;
  review_count?: number;
  review_rating?: number;
  user_reviews?: { Description?: string; Rating?: number }[] | null;
  /** Filled with `-extra-reviews` (~3 more per place, measured 17/10); Rating comes back 0 (unparsed), so treat as unrated. */
  user_reviews_extended?: { Description?: string; Rating?: number }[] | null;
  order_online?: { link?: string }[] | null;
  reservations?: { link?: string }[] | null;
}

const SOCIAL = ['facebook.com', 'instagram.com', 'linktr.ee', 'tiktok.com'];

export function toSignalInput(p: MapsPlace, fetchWeb: boolean): SignalCollectionInput {
  const site = p.web_site && !SOCIAL.some(s => p.web_site!.includes(s)) ? p.web_site : undefined;
  let domain = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (site) {
    try { domain = new URL(site).hostname.replace(/^www\./, ''); } catch { /* keep slug */ }
  }
  return {
    company_domain: domain,
    company_name: p.title,
    company_industry: p.category,
    website_url: fetchWeb ? site : undefined,
    reviews_url: p.link,
    reviews: [...(p.user_reviews ?? []), ...(p.user_reviews_extended ?? [])].filter(r => r.Description).map(r => ({ text: r.Description!, rating: r.Rating })),
    booking_links: [...(p.order_online ?? []), ...(p.reservations ?? [])].map(l => l.link).filter((l): l is string => Boolean(l)),
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: customer-loss-scan.ts <maps.jsonl> [--no-web]');
  const fetchWeb = !process.argv.includes('--no-web');
  const places: MapsPlace[] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const rows = [];
  for (const p of places) {
    const input = toSignalInput(p, fetchWeb);
    const r = await collectAndNormalizeProvider(customerLossProvider, [input]);
    const score = r.signals.reduce((a, s) => a + s.intentWeight * s.confidence, 0);
    rows.push({
      name: p.title, phone: p.phone, site: p.web_site, reviews: p.review_count, rating: p.review_rating,
      has_maps_booking: Boolean(input.booking_links?.length), score: Math.round(score),
      signals: r.signals.map(s => ({ title: s.title, class: s.evidenceClassification, data: s.normalizedData, quotes: (s.rawData as { quotes?: unknown }).quotes })),
    });
  }
  rows.sort((a, b) => b.score - a.score || (b.reviews ?? 0) - (a.reviews ?? 0));
  fs.writeFileSync(file.replace(/\.jsonl$/, '') + '.customer-loss.json', JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`${String(r.score).padStart(3)} | ${r.name.slice(0, 38).padEnd(38)} | ${String(r.reviews ?? 0).padStart(4)} rv | ${r.signals.map(s => s.title).join(' + ') || '-'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
