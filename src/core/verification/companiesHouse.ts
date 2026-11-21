import axios from 'axios';
import * as cheerio from 'cheerio';
import { checkPhone } from './contactCheck.js';

/**
 * UK PECR gate for cold outreach (ICO guide, read 17/11/2026; our reading, not legal advice):
 * sole traders and ordinary partnerships are individual subscribers, so unsolicited marketing by email, text,
 * WhatsApp or DM needs their prior consent. Only a live Ltd/PLC/LLP confirmed on Companies House is delivered.
 * Confirmed = the company number printed on the company's site (with a matching name), or an exact name match
 * whose registered office is in a postcode district seen on the site or in the lead's location.
 * Anything else (not found, homonym, other company type, lookup down) is excluded with a reason, never delivered.
 */

export type PecrStatus = 'CORPORATE' | 'NOT_FOUND' | 'UNCONFIRMED' | 'NOT_CORPORATE' | 'UNAVAILABLE';

export interface CompaniesHouseProfile { number: string; name: string; status: string; type: string; address: string }

export interface PecrCheck {
  status: PecrStatus;
  reason: string;
  companies_house?: CompaniesHouseProfile & { via: 'site_number' | 'name_postcode' };
}

export interface PecrInput { name: string; companyNumbers: string[]; postcodeDistricts: string[] }

const CH = 'https://find-and-update.company-information.service.gov.uk';

// ICO: LLPs and limited companies are corporate subscribers; an English "limited partnership" is a partnership.
const CORPORATE_TYPE = /\blimited liability partnership\b|\blimited company\b|\blimited by guarantee\b|\bltd by guar/i;

const UK_COUNTRY = /^(uk|u\.k\.|gb|gbr|united kingdom|great britain|england|scotland|wales|northern ireland)$/i;
// ponytail: hand list of the larger UK towns; a lead with only a smaller town and no other UK hint still slips. Add towns as leads show up.
const UK_LOCATION = new RegExp('\\b(united kingdom|great britain|england|scotland|wales|northern ireland|london|manchester|birmingham|bristol|leeds|liverpool|sheffield|newcastle|nottingham|leicester|coventry|bradford|cardiff|swansea|newport|edinburgh|glasgow|aberdeen|dundee|belfast|southampton|portsmouth|plymouth|exeter|bath|brighton|reading|oxford|cambridge|norwich|york|hull|derby|stoke|wolverhampton|milton keynes|luton|swindon|gloucester|cheltenham|bournemouth|preston|sunderland|middlesbrough)\\b|\\bUK\\b', 'i');

/** True when any field points at the UK (country, town or postcode in the location, .uk domain, +44 phone, UK postcode on the site).
 * Fail closed: one UK hint is enough to require the check. */
export function isUkLead(lead: { location?: string | null; phone?: string | null; company: { country?: string | null; domain?: string | null; whatsappPhone?: string | null } }, sitePostcodes: string[] = []): boolean {
  if (UK_COUNTRY.test((lead.company.country ?? '').trim())) return true;
  if (UK_LOCATION.test(lead.location ?? '') || postcodeDistrictsIn((lead.location ?? '').toUpperCase()).length || sitePostcodes.length) return true;
  const host = (lead.company.domain ?? '').toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/)[0];
  if (host.endsWith('.uk')) return true;
  return [lead.phone, lead.company.whatsappPhone].some(p => Boolean(p) && Boolean(checkPhone(p).normalized?.startsWith('+44')));
}

// "Company No. 1234567", "Registered in England and Wales No: 08123456", "Company registration number SC123456".
const NUMBER_NEAR_KEYWORD = /\b(?:company|registered|registration|reg)\b([^0-9<>]{0,40}?)\b((?:SC|NI|OC|SO|NC|R0)\d{6}|\d{7,8})\b/gi;
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?) ?\d[A-Z]{2}\b/g;

/** Company numbers printed near a registration keyword, zero-padded to the 8 characters Companies House uses. */
export function companyNumbersIn(text: string): string[] {
  // "Registered charity number 1234567" is the Charity Commission register, not Companies House.
  return [...new Set([...text.matchAll(NUMBER_NEAR_KEYWORD)].filter(m => !/charit/i.test(m[0])).map(m => m[2].toUpperCase().padStart(8, '0')))].slice(0, 3);
}

/** UK postcode districts ("BS8") in the text; upper case only, so ordinary words do not match. */
export function postcodeDistrictsIn(text: string): string[] {
  return [...new Set([...(text ?? '').matchAll(POSTCODE)].map(m => m[1]))].slice(0, 5);
}

const GENERIC = new Set(['the', 'and', 'ltd', 'limited', 'llp', 'plc', 'company', 'services', 'group', 'solutions', 'uk']);
const nkey = (name: string) => name.toLowerCase().replace(/&/g, ' and ').replace(/\b(ltd|limited|llp|plc|cic)\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '').replace(/ co$/, ' company');
/** The full name and the part before " - ", " | " or "(" ("Maid in Bristol Ltd - Office Cleaning"). */
const nameKeys = (name: string) => new Set([nkey(name), nkey(name.split(/\s+[-|–]\s+|\s*\(/)[0])].filter(Boolean));
/** Every distinctive word of the shorter name appears in the other ("Smith Dental" / "SMITH DENTAL CARE LTD"), so a number
 * printed for a directory or a web agency ("Smith Web Design Ltd") never confirms the business. */
function sameName(a: string, b: string): boolean {
  const words = (s: string) => new Set(nkey(s).split(' ').filter(w => w.length > 2 && !GENERIC.has(w)).map(w => w.slice(0, 6)));
  const [small, big] = [words(a), words(b)].sort((x, y) => x.size - y.size);
  return small.size > 0 && [...small].every(w => big.has(w));
}

export interface SearchHit { number: string; name: string; address: string }

/** Throws when the page is neither a result list nor "no results" (throttled/down): "not checked" never reads as "not found". */
export function parseSearch(html: string): SearchHit[] {
  if (!html.includes('class="results-list"') && !html.includes('no-results-heading')) throw new Error('Companies House search page not recognised');
  const $ = cheerio.load(html);
  return $('ul#results li.type-company').map((_, li) => {
    const href = $(li).find('h3 a').attr('href') ?? '';
    return { number: href.match(/\/company\/([A-Z0-9]{8})$/)?.[1] ?? '', name: $(li).find('h3 a').text().trim(), address: $(li).children('p').last().text().trim() };
  }).get().filter(h => h.number);
}

export function parseProfile(html: string, number: string): CompaniesHouseProfile | null {
  const $ = cheerio.load(html);
  const type = $('#company-type-value').text().trim();
  if (!type) return null;
  return { number, name: $('h1.heading-xlarge').first().text().trim(), status: $('#company-status').text().trim(), type, address: $('#roa-address').text().replace(/\s+/g, ' ').trim() };
}

let lastCall = Promise.resolve();
let waiting = 0;
const MAX_WAITING = 20; // ~12 s of queue: past that, concurrent deliveries get UNAVAILABLE (excluded) instead of an unbounded wait
// ponytail: one global 0.6 s gap (~1.6 req/s, under Companies House's 2 req/s); per-host token bucket if throughput matters.
async function chGet(path: string): Promise<string> {
  if (waiting >= MAX_WAITING) throw new Error('fila de consultas cheia');
  waiting++;
  const turn = lastCall.then(() => new Promise<void>(r => setTimeout(r, 600)));
  lastCall = turn;
  try { await turn; } finally { waiting--; }
  const res = await axios.get(CH + path, { timeout: 15_000, responseType: 'text', headers: { 'User-Agent': 'LookaBerry-Verifier/1.0', Accept: 'text/html' } /* the default Accept gets an undocumented JSON body */, maxRedirects: 3,
    validateStatus: s => s < 400 || s === 404 }); // 404 = no such company number: parsed as "no profile", not as "down"
  return res.status === 200 && typeof res.data === 'string' ? res.data : '';
}

const outward = (address: string) => [...address.toUpperCase().matchAll(POSTCODE)].pop()?.[1] ?? '';

function judge(p: CompaniesHouseProfile, via: 'site_number' | 'name_postcode'): PecrCheck {
  const companies_house = { ...p, via };
  if (!/^active$/i.test(p.status)) return { status: 'NOT_CORPORATE', reason: `UK PECR: ${p.name} (${p.number}) está ${p.status || 'sem status'} na Companies House`, companies_house };
  if (!CORPORATE_TYPE.test(p.type)) return { status: 'NOT_CORPORATE', reason: `UK PECR: ${p.name} (${p.number}) é "${p.type}", não Ltd/LLP`, companies_house };
  return { status: 'CORPORATE', reason: `Ltd/LLP ativa na Companies House (${p.number}, via ${via === 'site_number' ? 'número no site' : 'nome + distrito postal'})`, companies_house };
}

export async function checkUkCompany(input: PecrInput, get: (path: string) => Promise<string> = chGet): Promise<PecrCheck> {
  try {
    for (const n of input.companyNumbers.slice(0, 3)) {
      const p = parseProfile(await get(`/company/${n}`), n);
      if (p && sameName(input.name, p.name)) return judge(p, 'site_number');
    }
    const keys = nameKeys(input.name);
    let hits: SearchHit[] = [];
    for (const q of [...keys].sort((a, b) => b.length - a.length)) {
      hits = parseSearch(await get(`/search/companies?q=${encodeURIComponent(q)}`)).filter(h => keys.has(nkey(h.name)));
      if (hits.length) break;
    }
    if (!hits.length) return { status: 'NOT_FOUND', reason: 'UK PECR: empresa não encontrada na Companies House (provável sole trader/partnership): sem mensagem fria' };
    const local = hits.find(h => input.postcodeDistricts.includes(outward(h.address)));
    if (!local) return { status: 'UNCONFIRMED', reason: `UK PECR: homônima na Companies House (${hits[0].number}) sem confirmação: sem número no site nem mesmo distrito postal` };
    const p = parseProfile(await get(`/company/${local.number}`), local.number);
    if (!p) throw new Error('Companies House profile page not recognised');
    return judge(p, 'name_postcode');
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: `UK PECR: Companies House indisponível (${error instanceof Error ? error.message.slice(0, 80) : 'erro'}): empresa não confirmada` };
  }
}
