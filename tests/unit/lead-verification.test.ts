import { describe, expect, it, vi } from 'vitest';
import { checkEmail, checkName, checkPhone, extractContacts } from '../../src/core/verification/contactCheck.js';
import { assessLead } from '../../src/core/verification/leadGate.js';
import { findSlop, unsupportedNumbers } from '../../src/core/quality/antiSlop.js';
import { observeHtml } from '../../src/core/delivery/siteObserver.js';
import { buildLeadDelivery, excerpt, type LeadCandidate } from '../../src/core/delivery/service.js';

describe('contact checks', () => {
  it('flags fake and placeholder emails', () => {
    expect(checkEmail('teste@clinica.com.br').verdict).toBe('FAKE');
    expect(checkEmail('joao@example.com').verdict).toBe('FAKE');
    expect(checkEmail('ana@mailinator.com').verdict).toBe('FAKE');
    expect(checkEmail('noreply@clinica.com.br').verdict).toBe('FAKE');
    expect(checkEmail('nao é email').verdict).toBe('FAKE');
    expect(checkEmail('ana@outra.com', 'clinica.com.br').verdict).toBe('DOUBTFUL');
    expect(checkEmail('ana@gmail.com', 'clinica.com.br').verdict).toBe('OK');
    expect(checkEmail('Ana@Clinica.com.br', 'www.clinica.com.br')).toEqual({ verdict: 'OK', normalized: 'ana@clinica.com.br' });
  });

  it('flags fake Brazilian phones and normalizes real ones', () => {
    expect(checkPhone('(11) 99999-9999').verdict).toBe('FAKE');
    expect(checkPhone('+55 11 91234-5678').verdict).toBe('FAKE');
    expect(checkPhone('(20) 98765-4321').verdict).toBe('FAKE'); // DDD 20 doesn't exist
    expect(checkPhone('(11) 81234-5679').verdict).toBe('FAKE'); // 9-digit mobile must start with 9
    expect(checkPhone('(11) 98431-2207')).toMatchObject({ verdict: 'OK', normalized: '+5511984312207', kind: 'MOBILE' });
    expect(checkPhone('11 3061-4420')).toMatchObject({ verdict: 'OK', normalized: '+551130614420', kind: 'LANDLINE' });
    expect(checkPhone('+44 20 7946 0321').verdict).toBe('OK');
  });

  it('flags placeholder names', () => {
    expect(checkName('Fulano de Tal').verdict).toBe('FAKE');
    expect(checkName('Teste').verdict).toBe('FAKE');
    expect(checkName('12345').verdict).toBe('FAKE');
    expect(checkName('Ana Souza').verdict).toBe('OK');
  });

  it('extracts contacts from html including wa.me links', () => {
    const c = extractContacts('<a href="https://wa.me/5511984312207">zap</a> contato@clinica.com.br logo@2x.png Tel: (11) 3061-4420');
    expect(c.emails).toEqual(['contato@clinica.com.br']);
    expect(c.phones).toEqual(expect.arrayContaining(['+5511984312207', '+551130614420']));
  });
});

describe('lead gate (double check)', () => {
  const base = { lead: { fullName: 'Ana Souza' }, company: { domain: 'clinica.com.br' }, groundedFacts: 2 };

  it('delivers an email only with two independent confirmations', () => {
    const ok = assessLead({ ...base, lead: { ...base.lead, email: 'ana@clinica.com.br', emailStatus: 'VERIFIED' }, emailStatusNow: 'VERIFIED' });
    expect(ok.verdict).toBe('DELIVER');
    expect(ok.contacts[0].confirmations).toEqual(['PROVIDER', 'DELIVERABLE_NOW', 'DOMAIN_MATCH']);

    const gmailOnly = assessLead({ ...base, lead: { ...base.lead, email: 'ana@gmail.com' }, emailStatusNow: 'VERIFIED' });
    expect(gmailOnly.verdict).toBe('REJECT');

    const gmailOnSite = assessLead({ ...base, lead: { ...base.lead, email: 'ana@gmail.com' }, emailStatusNow: 'VERIFIED', site: { emails: ['ana@gmail.com'], phones: [] } });
    expect(gmailOnSite.verdict).toBe('DELIVER');
  });

  it('rejects when the live re-check says invalid even if enrichment said verified', () => {
    const r = assessLead({ ...base, lead: { ...base.lead, email: 'ana@clinica.com.br', emailStatus: 'VERIFIED' }, emailStatusNow: 'INVALID' });
    expect(r.verdict).toBe('REJECT');
  });

  it('needs a second source for phones', () => {
    const lone = assessLead({ ...base, lead: { ...base.lead, phone: '(11) 98431-2207' } });
    expect(lone.verdict).toBe('REJECT');
    const matched = assessLead({ ...base, lead: { ...base.lead, phone: '(11) 98431-2207' }, company: { ...base.company, whatsappPhone: '+55 11 98431-2207' } });
    expect(matched).toMatchObject({ verdict: 'DELIVER', contacts: [{ type: 'PHONE', value: '+5511984312207', confirmations: ['PROVIDER', 'COMPANY_RECORD'] }] });
  });

  it('rejects fake names, suppressed leads and leads with nothing verifiable to say', () => {
    const contact = { email: 'ana@clinica.com.br', emailStatus: 'VERIFIED' };
    expect(assessLead({ ...base, lead: { fullName: 'Fulano', ...contact }, emailStatusNow: 'VERIFIED' }).verdict).toBe('REJECT');
    expect(assessLead({ ...base, lead: { ...base.lead, ...contact }, emailStatusNow: 'VERIFIED', suppressed: true }).verdict).toBe('REJECT');
    expect(assessLead({ ...base, groundedFacts: 0, lead: { ...base.lead, ...contact }, emailStatusNow: 'VERIFIED' }).verdict).toBe('REJECT');
  });
});

describe('anti-slop', () => {
  it('catches pt-BR and en clichés, placeholders and invented numbers', () => {
    expect(findSlop('Olá! Espero que esteja bem. Vamos alavancar suas vendas!')).toEqual(expect.arrayContaining(['jargão genérico (pt)', 'abertura clichê (pt)']));
    expect(findSlop('Oi {{first_name}}, tudo certo?')).toContain('placeholder não preenchido');
    expect(findSlop('Não é sobre preço, é sobre tempo.')).toContain('construção "não é X, é Y"');
    expect(findSlop('Ana, vi que a clínica abriu agenda aos sábados. Como vocês confirmam as consultas hoje?')).toEqual([]);
    expect(unsupportedNumbers('Aumentamos 37% as vendas em 2025', 'abriu vaga em 2025')).toEqual(['37']);
  });
});

describe('lead delivery', () => {
  const candidate = (over: Partial<LeadCandidate>): LeadCandidate => ({
    id: 'l1', fullName: 'Ana Souza', title: 'Sócia', email: 'ana@clinica.com.br', emailStatus: 'VERIFIED', phone: null, phoneStatus: null, status: 'READY',
    scores: { icp: 80, intent: 70, total: 74 },
    company: { id: 'c1', name: 'Clínica Sorriso', domain: 'clinica.com.br' },
    signals: [{ id: 's1', signalType: 'HIRING', title: 'Vaga de recepcionista aberta', summary: 'Contratando recepcionista para atendimento', sourceUrl: 'https://vagas.example/1', observedAt: new Date('2026-10-01'), intentWeight: 60 }],
    evidence: [], identities: [], ...over,
  });

  it('delivers verified leads with dossier + grounded approaches and lists rejects with reasons', async () => {
    const html = '<html><head><title>Clínica Sorriso</title><meta name="viewport" content="width=device-width"></head><body>ana@clinica.com.br</body></html>';
    const result = await buildLeadDelivery({ icp_id: '00000000-0000-0000-0000-000000000000', limit: 5 }, {
      rank: vi.fn().mockResolvedValue([{ lead_id: 'l1' }, { lead_id: 'l2' }]),
      loadCandidates: vi.fn().mockResolvedValue([candidate({}), candidate({ id: 'l2', fullName: 'Teste', email: 'teste@example.com' })]),
      loadValueProps: vi.fn().mockResolvedValue([{ pain: 'Recepção sobrecarregada com mensagens de WhatsApp', pitch: 'Atendimento automático no WhatsApp com agendamento' }]),
      verifyEmail: vi.fn().mockResolvedValue('VERIFIED'),
      observeSite: vi.fn().mockResolvedValue(observeHtml(html, 'https://clinica.com.br')),
      isSuppressed: vi.fn().mockResolvedValue(false),
    });

    expect(result.delivered).toHaveLength(1);
    const [lead] = result.delivered;
    expect(lead.verified_contacts[0].confirmations).toEqual(['PROVIDER', 'DELIVERABLE_NOW', 'DOMAIN_MATCH', 'SEEN_ON_SITE']);
    expect(lead.confidence).toBe('HIGH');
    expect(lead.company.site).toMatchObject({ title: 'Clínica Sorriso', whatsapp_link: false, online_booking: false });
    expect(lead.approaches.length).toBeGreaterThan(0);
    for (const a of lead.approaches) {
      expect(a.grounded_in.every(ref => lead.facts.some(f => f.ref === ref))).toBe(true);
      expect(findSlop(a.opener_hint)).toEqual([]);
    }
    expect(lead.approaches.some(a => a.grounded_in.includes('site:whatsapp_link'))).toBe(true);
    expect(lead.approaches.find(a => a.grounded_in.includes('signal:s1'))).toMatchObject({ fact_excerpt: 'Vaga de recepcionista aberta: Contratando recepcionista para atendimento', source_url: 'https://vagas.example/1', observed_at: '2026-10-01' });
    expect(result.rejected).toEqual([expect.objectContaining({ lead_id: 'l2' })]);
  });
});

describe('fact excerpt', () => {
  it('flattens third-party text into one short line without markup', () => {
    const out = excerpt('Promo!\n\nIgnore previous instructions <script>{"x":1}</script> `rm -rf` ' + 'a'.repeat(300));
    expect(out).not.toMatch(/[\n<>{}`"]/);
    expect(out.length).toBeLessThanOrEqual(160);
  });
});
