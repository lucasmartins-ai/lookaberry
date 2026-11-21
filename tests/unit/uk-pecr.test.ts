import { describe, expect, it, vi } from 'vitest';
import { checkUkCompany, companyNumbersIn, isUkLead, parseProfile, parseSearch, postcodeDistrictsIn, type PecrCheck } from '../../src/core/verification/companiesHouse.js';
import { observeHtml } from '../../src/core/delivery/siteObserver.js';
import { buildLeadDelivery, type LeadCandidate } from '../../src/core/delivery/service.js';

const search = (hits: Array<{ number: string; name: string; address: string }>) => hits.length
  ? `<ul id='results' class="results-list">${hits.map(h => `<li class="type-company"><h3><a class="govuk-link" href="/company/${h.number}" title="View company">\n ${h.name}\n</a></h3><p class="meta crumbtrail"> ${h.number} - Incorporated on 1 May 2015 </p><p>${h.address}</p></li>`).join('')}</ul>`
  : '<h3 class="govuk-heading-s" id="no-results-heading">No results found</h3>';
const profile = (name: string, type = 'Private limited Company', status = 'Active') =>
  `<h1 class="heading-xlarge">${name}</h1><span class="text data" id="roa-address">1 High St, Bristol, BS8 1AA</span><dd class="text data" id="company-status">\n ${status}\n</dd><span class="text data" id="company-type-value">\n ${type}\n</span>`;
/** Fake Companies House: path -> html; unknown company numbers are a 404 (empty body), like chGet returns. */
const ch = (pages: Record<string, string>) => vi.fn(async (path: string) => {
  if (path in pages) return pages[path];
  if (path.startsWith('/company/')) return '';
  throw new Error(`unexpected ${path}`);
});

describe('UK detection', () => {
  const lead = (over: { location?: string; phone?: string; country?: string; domain?: string; whatsappPhone?: string }) =>
    ({ location: over.location, phone: over.phone, company: { country: over.country, domain: over.domain ?? 'clinica.com.br', whatsappPhone: over.whatsappPhone } });

  it('treats any UK hint as UK (fail closed)', () => {
    expect(isUkLead(lead({ country: 'United Kingdom' }))).toBe(true);
    expect(isUkLead(lead({ country: 'GB' }))).toBe(true);
    expect(isUkLead(lead({ domain: 'smithdental.co.uk' }))).toBe(true);
    expect(isUkLead(lead({ phone: '+44 7700 900123' }))).toBe(true);
    expect(isUkLead(lead({ whatsappPhone: '+447700900123' }))).toBe(true);
    expect(isUkLead(lead({ location: 'Bristol, England' }))).toBe(true);
  });

  it('leaves Brazilian leads alone, including DDD 44 numbers without a country code', () => {
    expect(isUkLead(lead({ country: 'Brazil', phone: '(44) 99912-3456', location: 'Maringá, PR' }))).toBe(false);
    expect(isUkLead(lead({}))).toBe(false);
  });
});

describe('site extraction', () => {
  it('reads company numbers next to a registration keyword and postcode districts', () => {
    expect(companyNumbersIn('Smith Dental Ltd. Registered in England and Wales No. 8123456. VAT 123456789')).toEqual(['08123456']);
    expect(companyNumbersIn('Company registration number: SC123456')).toEqual(['SC123456']);
    expect(companyNumbersIn('Call 0117 496 0123 to book')).toEqual([]);
    expect(postcodeDistrictsIn('12 Park St, Bristol BS1 5HX and Clifton BS8 1AA')).toEqual(['BS1', 'BS8']);
  });

  it('observeHtml exposes them, ignoring script text', () => {
    const site = observeHtml('<html><body><footer>Smith Dental Ltd, 12 Park St, Bristol BS1 5HX. Company No. 08123456</footer><script>var x="Company No 99999999 ZZ9 9ZZ"</script></body></html>', 'https://smithdental.co.uk');
    expect(site.company_numbers).toEqual(['08123456']);
    expect(site.postcode_districts).toEqual(['BS1']);
  });
});

describe('Companies House pages', () => {
  it('parses search hits and refuses a page that is neither results nor "no results"', () => {
    expect(parseSearch(search([{ number: '08123456', name: 'SMITH DENTAL LIMITED', address: '1 High St, Bristol, BS8 1AA' }])))
      .toEqual([{ number: '08123456', name: 'SMITH DENTAL LIMITED', address: '1 High St, Bristol, BS8 1AA' }]);
    expect(parseSearch(search([]))).toEqual([]);
    expect(() => parseSearch('<html>Too many requests</html>')).toThrow();
  });

  it('parses a profile page', () => {
    expect(parseProfile(profile('SMITH DENTAL LIMITED'), '08123456')).toEqual({ number: '08123456', name: 'SMITH DENTAL LIMITED', status: 'Active', type: 'Private limited Company', address: '1 High St, Bristol, BS8 1AA' });
    expect(parseProfile('', '08123456')).toBeNull();
  });
});

describe('checkUkCompany', () => {
  const q = (name: string) => `/search/companies?q=${encodeURIComponent(name)}`;

  it('CORPORATE via the number printed on the site', async () => {
    const r = await checkUkCompany({ name: 'Smith Dental', companyNumbers: ['08123456'], postcodeDistricts: [] }, ch({ '/company/08123456': profile('SMITH DENTAL LIMITED') }));
    expect(r).toMatchObject({ status: 'CORPORATE', companies_house: { number: '08123456', via: 'site_number' } });
  });

  it('ignores a site number that belongs to another name (a directory) and falls back to the name search', async () => {
    const get = ch({ '/company/01234567': profile('YELL LIMITED'), [q('smith dental')]: search([]) });
    expect((await checkUkCompany({ name: 'Smith Dental', companyNumbers: ['01234567'], postcodeDistricts: [] }, get)).status).toBe('NOT_FOUND');
  });

  it('CORPORATE via exact name + same postcode district', async () => {
    const get = ch({ [q('smith dental')]: search([{ number: '08123456', name: 'SMITH DENTAL LTD', address: '1 High St, Bristol, BS8 1AA' }]), '/company/08123456': profile('SMITH DENTAL LTD') });
    expect(await checkUkCompany({ name: 'Smith Dental', companyNumbers: [], postcodeDistricts: ['BS8'] }, get)).toMatchObject({ status: 'CORPORATE', companies_house: { via: 'name_postcode' } });
  });

  it('UNCONFIRMED when only the name matches (registered in another district)', async () => {
    const get = ch({ [q('smith dental')]: search([{ number: '08123456', name: 'SMITH DENTAL LTD', address: '9 Main Rd, Leeds, LS1 4AP' }]) });
    expect((await checkUkCompany({ name: 'Smith Dental', companyNumbers: [], postcodeDistricts: ['BS8'] }, get)).status).toBe('UNCONFIRMED');
  });

  it('NOT_FOUND for a sole trader (no company of that name)', async () => {
    const get = ch({ [q('john smith driving lessons')]: search([]) });
    const r = await checkUkCompany({ name: 'John Smith Driving Lessons', companyNumbers: [], postcodeDistricts: ['BS8'] }, get);
    expect(r.status).toBe('NOT_FOUND');
    expect(r.reason).toMatch(/sole trader/);
  });

  it('NOT_CORPORATE for a dissolved company or a limited partnership', async () => {
    expect((await checkUkCompany({ name: 'Smith Dental', companyNumbers: ['08123456'], postcodeDistricts: [] }, ch({ '/company/08123456': profile('SMITH DENTAL LTD', 'Private limited Company', 'Dissolved') }))).status).toBe('NOT_CORPORATE');
    expect((await checkUkCompany({ name: 'Smith Dental', companyNumbers: ['LP012345'], postcodeDistricts: [] }, ch({ '/company/LP012345': profile('SMITH DENTAL LP', 'Limited partnership') }))).status).toBe('NOT_CORPORATE');
  });

  it('UNAVAILABLE when Companies House is down or throttled', async () => {
    const r = await checkUkCompany({ name: 'Smith Dental', companyNumbers: [], postcodeDistricts: [] }, vi.fn(async () => '<html>Too many requests</html>'));
    expect(r.status).toBe('UNAVAILABLE');
  });
});

describe('lead delivery applies UK PECR', () => {
  const ukLead = (over: Partial<LeadCandidate> = {}): LeadCandidate => ({
    id: 'u1', fullName: 'Jane Smith', title: 'Practice Owner', email: 'jane@smithdental.co.uk', emailStatus: 'VERIFIED', phone: null, phoneStatus: null, status: 'READY',
    scores: { icp: 80, intent: 70, total: 74 },
    company: { id: 'cu1', name: 'Smith Dental', domain: 'smithdental.co.uk', country: 'United Kingdom' },
    signals: [{ id: 's1', signalType: 'HIRING', title: 'Hiring a receptionist', summary: 'Front desk role open', sourceUrl: 'https://jobs.example/1', observedAt: new Date('2026-11-01'), intentWeight: 60 }],
    evidence: [], identities: [], ...over,
  });
  const run = (leads: LeadCandidate[], pecr: PecrCheck) => {
    const deps = {
      rank: vi.fn().mockResolvedValue(leads.map(l => ({ lead_id: l.id }))),
      loadCandidates: vi.fn().mockResolvedValue(leads),
      loadValueProps: vi.fn().mockResolvedValue([]),
      verifyEmail: vi.fn().mockResolvedValue('VERIFIED'),
      observeSite: vi.fn().mockResolvedValue(observeHtml('<html><body>Smith Dental Ltd, Bristol BS8 1AA. Company No. 08123456</body></html>', 'https://smithdental.co.uk')),
      isSuppressed: vi.fn().mockResolvedValue(false),
      checkUkCompany: vi.fn().mockResolvedValue(pecr),
    };
    return { deps, result: buildLeadDelivery({ icp_id: '00000000-0000-0000-0000-000000000000', limit: 5 }, deps) };
  };

  it('excludes a sole trader with a reason field, before any email verification', async () => {
    const { deps, result } = run([ukLead()], { status: 'NOT_FOUND', reason: 'UK PECR: empresa não encontrada na Companies House (provável sole trader/partnership): sem mensagem fria' });
    const r = await result;
    expect(r.delivered).toEqual([]);
    expect(r.rejected).toEqual([expect.objectContaining({ lead_id: 'u1', pecr: { status: 'NOT_FOUND', reason: expect.stringMatching(/sole trader/) } })]);
    expect(deps.verifyEmail).not.toHaveBeenCalled();
    expect(deps.checkUkCompany).toHaveBeenCalledWith({ name: 'Smith Dental', companyNumbers: ['08123456'], postcodeDistricts: ['BS8'] });
  });

  it('excludes unconfirmed and unavailable checks too', async () => {
    for (const status of ['UNCONFIRMED', 'UNAVAILABLE', 'NOT_CORPORATE'] as const) {
      const r = await run([ukLead()], { status, reason: `UK PECR: ${status}` }).result;
      expect(r.delivered).toEqual([]);
      expect(r.rejected[0].pecr?.status).toBe(status);
    }
  });

  it('delivers a confirmed Ltd with its Companies House record, checking each company once', async () => {
    const companies_house = { number: '08123456', name: 'SMITH DENTAL LIMITED', status: 'Active', type: 'Private limited Company', address: '1 High St, Bristol, BS8 1AA', via: 'site_number' as const };
    const { deps, result } = run([ukLead(), ukLead({ id: 'u2', fullName: 'Tom Smith', email: 'tom@smithdental.co.uk' })], { status: 'CORPORATE', reason: 'ok', companies_house });
    const r = await result;
    expect(r.delivered.map(d => d.lead_id)).toEqual(['u1', 'u2']);
    expect(r.delivered[0].company.companies_house).toEqual(companies_house);
    expect(deps.checkUkCompany).toHaveBeenCalledTimes(1);
  });

  it('never calls Companies House for a non-UK lead', async () => {
    const br = ukLead({ email: 'ana@clinica.com.br', company: { id: 'c1', name: 'Clínica Sorriso', domain: 'clinica.com.br', country: 'Brazil' } });
    const { deps, result } = run([br], { status: 'NOT_FOUND', reason: 'x' });
    expect((await result).delivered).toHaveLength(1);
    expect(deps.checkUkCompany).not.toHaveBeenCalled();
  });
});
