/**
 * Deterministic fake/doubtful contact detection. No network, no LLM.
 * FAKE = never deliver. DOUBTFUL = deliver only with extra corroboration. OK = format is plausible
 * (plausible is not verified: the lead gate still asks for independent confirmations).
 */

export type ContactVerdict = 'OK' | 'DOUBTFUL' | 'FAKE';
export interface ContactCheck { verdict: ContactVerdict; reason?: string; normalized?: string }

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'teste.com', 'email.com', 'domain.com', 'dominio.com', 'seudominio.com', 'yourdomain.com', 'empresa.com', 'company.com', 'mail.com.br']);
// ponytail: short static list of the common throwaway providers; swap for a maintained list if they get through.
const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'emailondeck.com', 'mohmal.com']);
const FREE_MAIL = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'bol.com.br', 'uol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com', 'protonmail.com', 'aol.com', 'msn.com']);
const PLACEHOLDER_LOCAL = /^(test|teste|testing|asdf|qwerty|abc|abcd|xxx+|aaa+|fake|null|none|nome|name|email|seuemail|youremail|user|usuario|foo|bar|noreply|no-reply|donotreply|nao-responda|naoresponda)\d*$/i;

export const isFreeMail = (domain: string) => FREE_MAIL.has(domain.toLowerCase());

const bareDomain = (d?: string | null) => (d ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

export function checkEmail(email: string | null | undefined, companyDomain?: string | null): ContactCheck {
  if (!email) return { verdict: 'FAKE', reason: 'email ausente' };
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.includes('..')) return { verdict: 'FAKE', reason: 'formato de e-mail inválido' };
  const [local, domain] = normalized.split('@');
  if (PLACEHOLDER_DOMAINS.has(domain)) return { verdict: 'FAKE', reason: `domínio de exemplo (${domain})` };
  if (DISPOSABLE_DOMAINS.has(domain)) return { verdict: 'FAKE', reason: `domínio descartável (${domain})` };
  if (PLACEHOLDER_LOCAL.test(local)) return { verdict: 'FAKE', reason: `caixa de placeholder/no-reply (${local}@)` };
  const company = bareDomain(companyDomain);
  if (company && !isFreeMail(domain) && domain !== company && !domain.endsWith(`.${company}`) && !company.endsWith(`.${domain}`)) {
    return { verdict: 'DOUBTFUL', reason: `domínio do e-mail (${domain}) difere do site da empresa (${company})`, normalized };
  }
  return { verdict: 'OK', normalized };
}

// Valid Brazilian area codes (Anatel).
const BR_DDD = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99]);

function looksGenerated(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  const asc = '01234567890123456789';
  const desc = '98765432109876543210';
  return digits.length >= 6 && (asc.includes(digits) || desc.includes(digits));
}

/** `kind`: MOBILE (WhatsApp-capable in BR) or LANDLINE; undefined outside BR. */
export interface PhoneCheck extends ContactCheck { kind?: 'MOBILE' | 'LANDLINE' }

export function checkPhone(phone: string | null | undefined): PhoneCheck {
  if (!phone) return { verdict: 'FAKE', reason: 'telefone ausente' };
  let digits = phone.replace(/\D/g, '');
  const hadPlus = phone.trim().startsWith('+');
  if (!hadPlus && digits.startsWith('0')) digits = `55${digits.slice(1)}`; // 0XX… national format
  if (!hadPlus && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`; // DDD + number
  if (digits.length < 8 || digits.length > 15) return { verdict: 'FAKE', reason: 'tamanho de telefone inválido' };

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = Number(digits.slice(2, 4));
    const subscriber = digits.slice(4);
    if (!BR_DDD.has(ddd)) return { verdict: 'FAKE', reason: `DDD inexistente (${ddd})` };
    if (looksGenerated(subscriber) || looksGenerated(subscriber.slice(1))) return { verdict: 'FAKE', reason: 'número repetido/sequencial' };
    if (subscriber.length === 9) {
      if (subscriber[0] !== '9') return { verdict: 'FAKE', reason: 'celular com 9 dígitos precisa começar com 9' };
      return { verdict: 'OK', normalized: `+${digits}`, kind: 'MOBILE' };
    }
    if (!/^[2-5]/.test(subscriber)) return { verdict: 'DOUBTFUL', reason: 'número de 8 dígitos fora da faixa de fixo (celular sem o 9?)', normalized: `+${digits}` };
    return { verdict: 'OK', normalized: `+${digits}`, kind: 'LANDLINE' };
  }

  if (looksGenerated(digits.slice(-8))) return { verdict: 'FAKE', reason: 'número repetido/sequencial' };
  return { verdict: 'OK', normalized: `+${digits}` };
}

const PLACEHOLDER_NAME = /^(test|teste|testing|fulano|ciclano|beltrano|lorem|ipsum|n\/?a|null|undefined|unknown|desconhecido|sem nome|nome|name|asdf|qwerty|xxx+|aaa+|cliente|customer|user|usuario|usuário|admin)$/i;

export function checkName(name: string | null | undefined): ContactCheck {
  const value = (name ?? '').trim();
  if (value.length < 2) return { verdict: 'FAKE', reason: 'nome ausente' };
  if (/\d{3,}/.test(value) || !/\p{L}/u.test(value)) return { verdict: 'FAKE', reason: 'nome não parece de pessoa' };
  if (value.split(/\s+/).some(part => PLACEHOLDER_NAME.test(part)) || PLACEHOLDER_NAME.test(value)) return { verdict: 'FAKE', reason: `nome placeholder (${value})` };
  return { verdict: 'OK' };
}

/** Pulls emails, phones and WhatsApp links out of raw HTML/text (site cross-check). */
export function extractContacts(html: string): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (!/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e)) emails.add(e);
  }
  const phones = new Set<string>();
  const push = (raw: string) => { const c = checkPhone(raw); if (c.verdict !== 'FAKE' && c.normalized) phones.add(c.normalized); };
  for (const m of html.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=|tel:)\+?([\d\s().-]{8,20})/gi)) push(m[1].startsWith('55') ? `+${m[1]}` : m[1]);
  for (const m of html.matchAll(/(?:\+?55[\s.-]?)?\(?\b[1-9]{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g)) push(m[0]);
  return { emails: [...emails], phones: [...phones] };
}
