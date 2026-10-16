import axios from 'axios';
import * as cheerio from 'cheerio';
import { assertPublicUrl, safeHttpOptions } from '../security/ssrf.js';
import { extractContacts } from '../verification/contactCheck.js';

/** What we saw on the company's own site, right now. Every field is an observed FACT, never inferred by an LLM. */
export interface SiteObservation {
  url: string;
  observed_at: string;
  title?: string;
  description?: string;
  https: boolean;
  mobile_viewport: boolean;
  platform?: string;
  whatsapp_link: boolean;
  online_booking: boolean;
  analytics: boolean;
  meta_pixel: boolean;
  ecommerce: boolean;
  socials: string[];
  emails: string[];
  phones: string[];
}

const PLATFORMS: Array<[RegExp, string]> = [
  [/wix\.com|wixstatic/i, 'Wix'], [/wp-content|wordpress/i, 'WordPress'], [/cdn\.shopify|shopify/i, 'Shopify'],
  [/nuvemshop|tiendanube/i, 'Nuvemshop'], [/vtex/i, 'VTEX'], [/squarespace/i, 'Squarespace'], [/webflow/i, 'Webflow'],
  [/lojaintegrada/i, 'Loja Integrada'], [/tray\.com\.br|traycorp/i, 'Tray'], [/_next\/static/i, 'Next.js'],
];

export function observeHtml(html: string, url: string): SiteObservation {
  const $ = cheerio.load(html);
  const links = $('a[href]').map((_, a) => $(a).attr('href') ?? '').get().join(' ');
  const all = `${html} ${links}`;
  const contacts = extractContacts(all);
  return {
    url,
    observed_at: new Date().toISOString(),
    title: $('title').first().text().trim().slice(0, 200) || undefined,
    description: ($('meta[name="description"]').attr('content') ?? $('meta[property="og:description"]').attr('content'))?.trim().slice(0, 400) || undefined,
    https: url.startsWith('https://'),
    mobile_viewport: $('meta[name="viewport"]').length > 0,
    platform: PLATFORMS.find(([re]) => re.test(html))?.[1],
    whatsapp_link: /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i.test(all),
    online_booking: /calendly|doctoralia|agendor|simplesagenda|booksy|trinks|agendamento online|agende (online|agora|sua)|book (now|online)|marcar consulta/i.test(all),
    analytics: /googletagmanager|gtag\(|google-analytics|plausible|hotjar|clarity\.ms/i.test(html),
    meta_pixel: /fbq\(|connect\.facebook\.net/i.test(html),
    ecommerce: /add[-_ ]to[-_ ]cart|adicionar ao carrinho|carrinho|checkout|ifood\.com/i.test(all),
    socials: [...new Set((links.match(/https?:\/\/(?:www\.)?(?:instagram|facebook|linkedin|tiktok|youtube)\.com\/[^\s"'?#]+/gi) ?? []).map(s => s.toLowerCase()))].slice(0, 6),
    emails: contacts.emails,
    phones: contacts.phones,
  };
}

/** Fetches the homepage (and a contact page when linked) through the SSRF guard. Null when the site is unreachable. */
export async function observeSite(domain: string): Promise<SiteObservation | null> {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  const get = async (url: string) => {
    await assertPublicUrl(url);
    const res = await axios.get(url, { timeout: 12_000, responseType: 'text', headers: { 'User-Agent': 'LookaBerry-Verifier/1.0', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, ...safeHttpOptions });
    return typeof res.data === 'string' ? res.data : '';
  };
  try {
    const html = await get(base);
    const home = observeHtml(html, base);
    const $ = cheerio.load(html);
    const contactHref = $('a[href]').map((_, a) => $(a).attr('href') ?? '').get().find(h => /contat|contact|fale-conosco/i.test(h));
    if (contactHref) {
      try {
        const contactUrl = new URL(contactHref, base);
        if (contactUrl.hostname === new URL(base).hostname) {
          const extra = extractContacts(await get(contactUrl.toString()));
          home.emails = [...new Set([...home.emails, ...extra.emails])];
          home.phones = [...new Set([...home.phones, ...extra.phones])];
        }
      } catch { /* contact page is optional */ }
    }
    return home;
  } catch {
    return null;
  }
}
