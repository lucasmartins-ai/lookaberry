import { checkEmail, checkName, checkPhone, isFreeMail } from './contactCheck.js';

/**
 * Double-check gate run before a lead is delivered.
 * A contact is delivered only with >= 2 independent confirmations; a lead with no confirmed contact,
 * a fake name, or nothing verifiable to say about the business is rejected (never delivered).
 */

export type Confirmation =
  | 'DELIVERABLE_NOW'      // email re-verified at delivery time (MX/SMTP verifier)
  | 'DOMAIN_MATCH'         // email domain == company website domain
  | 'SEEN_ON_SITE'         // value published on the company's own website
  | 'COMPANY_RECORD'       // matches the company's WhatsApp/phone on file (Maps/registry)
  | 'IDENTITY_RECORD'      // matches an identity stored from another source
  | 'PROVIDER';            // the enrichment provider/importer that supplied the value

export interface GateContact { type: 'EMAIL' | 'PHONE'; value: string; kind?: 'MOBILE' | 'LANDLINE'; confirmations: Confirmation[]; notes: string[] }

export interface GateInput {
  lead: { fullName: string; email?: string | null; emailStatus?: string | null; phone?: string | null; phoneStatus?: string | null };
  company: { domain?: string | null; whatsappPhone?: string | null };
  /** Fresh deliverability status of lead.email (second check, at delivery time). */
  emailStatusNow?: 'VERIFIED' | 'RISKY' | 'INVALID' | 'NOT_FOUND' | null;
  site?: { emails: string[]; phones: string[] } | null;
  identities?: Array<{ type: string; value: string }>;
  /** Count of grounded facts (active signals + FACT evidence + site observations). */
  groundedFacts: number;
  suppressed?: boolean;
}

export interface GateResult { verdict: 'DELIVER' | 'REJECT'; confidence: 'HIGH' | 'MEDIUM' | 'NONE'; contacts: GateContact[]; reasons: string[] }

export const MIN_CONFIRMATIONS = 2;
const digits = (v: string) => v.replace(/\D/g, '');

export function assessLead(input: GateInput): GateResult {
  const reasons: string[] = [];
  const contacts: GateContact[] = [];
  if (input.suppressed) return { verdict: 'REJECT', confidence: 'NONE', contacts, reasons: ['lead/empresa na lista de supressão (opt-out)'] };

  const name = checkName(input.lead.fullName);
  if (name.verdict === 'FAKE') reasons.push(`nome: ${name.reason}`);

  const ids = input.identities ?? [];
  const companyDomain = (input.company.domain ?? '').toLowerCase().replace(/^www\./, '');

  if (input.lead.email) {
    const check = checkEmail(input.lead.email, companyDomain);
    if (check.verdict === 'FAKE') reasons.push(`e-mail descartado: ${check.reason}`);
    else if (input.lead.emailStatus === 'INVALID' || input.emailStatusNow === 'INVALID') reasons.push('e-mail descartado: verificador marcou como inválido');
    else {
      const email = check.normalized!;
      const domain = email.split('@')[1];
      const conf: Confirmation[] = ['PROVIDER'];
      if (input.emailStatusNow === 'VERIFIED') conf.push('DELIVERABLE_NOW');
      if (companyDomain && (domain === companyDomain || domain.endsWith(`.${companyDomain}`))) conf.push('DOMAIN_MATCH');
      if (input.site?.emails.includes(email)) conf.push('SEEN_ON_SITE');
      if (ids.some(i => /email/i.test(i.type) && i.value.toLowerCase() === email)) conf.push('IDENTITY_RECORD');
      const notes = check.verdict === 'DOUBTFUL' ? [check.reason!] : [];
      if (isFreeMail(domain)) notes.push('e-mail pessoal/gratuito');
      // The provider never counts (it is the claim being checked): email needs 2 independent checks, DOUBTFUL needs 3.
      const independent = conf.filter(c => c !== 'PROVIDER').length;
      const needed = MIN_CONFIRMATIONS + (check.verdict === 'DOUBTFUL' ? 1 : 0);
      if (input.emailStatusNow !== 'VERIFIED' && !conf.includes('SEEN_ON_SITE')) reasons.push(`e-mail ${email} sem entregabilidade confirmada agora`);
      else if (independent < needed) reasons.push(`e-mail ${email} com ${independent} confirmação(ões) independente(s), mínimo ${needed}`);
      else contacts.push({ type: 'EMAIL', value: email, confirmations: conf, notes });
    }
  }

  if (input.lead.phone) {
    const check = checkPhone(input.lead.phone);
    if (check.verdict === 'FAKE') reasons.push(`telefone descartado: ${check.reason}`);
    else if (input.lead.phoneStatus === 'INVALID') reasons.push('telefone descartado: marcado como inválido');
    else {
      const phone = check.normalized!;
      const same = (v?: string | null) => Boolean(v) && digits(checkPhone(v).normalized ?? v!) === digits(phone);
      const conf: Confirmation[] = ['PROVIDER'];
      if (input.site?.phones.some(same)) conf.push('SEEN_ON_SITE');
      if (same(input.company.whatsappPhone)) conf.push('COMPANY_RECORD');
      if (ids.some(i => /phone|whatsapp/i.test(i.type) && same(i.value))) conf.push('IDENTITY_RECORD');
      // No phone verifier exists, so the second source *is* the double check: provider + 1 other (DOUBTFUL: + 2).
      const independent = conf.length - 1;
      const needed = MIN_CONFIRMATIONS - 1 + (check.verdict === 'DOUBTFUL' ? 1 : 0);
      if (independent < needed) reasons.push(`telefone ${phone} sem confirmação em outra fonte (site, ficha da empresa, identidade)`);
      else contacts.push({ type: 'PHONE', value: phone, kind: check.kind, confirmations: conf, notes: check.verdict === 'DOUBTFUL' ? [check.reason!] : [] });
    }
  }

  if (!contacts.length) reasons.push('nenhum contato com dupla confirmação');
  if (input.groundedFacts === 0) reasons.push('nenhum fato verificável sobre o negócio (sem sinal, evidência ou observação do site)');

  const ok = name.verdict !== 'FAKE' && contacts.length > 0 && input.groundedFacts > 0;
  const strong = contacts.some(c => c.confirmations.length >= 3) || contacts.length >= 2;
  return { verdict: ok ? 'DELIVER' : 'REJECT', confidence: ok ? (strong ? 'HIGH' : 'MEDIUM') : 'NONE', contacts, reasons };
}
