import { promises as dns } from 'dns';
import type { ChannelId } from '../channels/types.js';
import { detectTimezone } from './smartScheduler.js';

/**
 * S10: Lead Enrichment Engine
 *
 * Called before the first send to a lead. Validates contact info,
 * detects timezone, and checks for duplicates.
 *
 * Best-effort: failures in enrichment (e.g. DNS timeout) don't block sending.
 */

export interface EnrichableLead {
  id: string;
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  phoneStatus: string | null;
  timezone: string | null;
  location: string | null;
}

export interface EnrichedLead {
  lead: EnrichableLead;
  skipped: boolean;
  skipReason?: string;
  /** Updated timezone, if detected */
  detectedTimezone?: string;
  /** Updated email status */
  emailValidation?: 'VALID' | 'INVALID' | 'RISKY';
  /** Updated phone status */
  phoneValidation?: 'VALID' | 'INVALID';
}

export interface EnricherConfig {
  defaultTimezone: string;
  mxLookupTimeoutMs: number;
}

const DEFAULT_CONFIG: EnricherConfig = {
  defaultTimezone: 'America/Sao_Paulo',
  mxLookupTimeoutMs: 3000,
};

// ─── Email validation ───

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

/**
 * Basic email validation:
 * 1. Regex format check
 * 2. DNS MX record lookup for the domain
 *
 * Returns 'VALID', 'INVALID', or null if unverified.
 */
async function validateEmail(
  email: string | null,
  config: EnricherConfig,
): Promise<'VALID' | 'INVALID' | null> {
  if (!email) return null;

  if (!EMAIL_REGEX.test(email)) return 'INVALID';

  const domain = email.split('@')[1];
  if (!domain) return 'INVALID';

  // DNS MX lookup with timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.mxLookupTimeoutMs);

    const addresses = await dns.resolveMx(domain);
    clearTimeout(timeout);

    if (addresses.length === 0) return 'INVALID';

    return 'VALID';
  } catch {
    // DNS failure (no MX records, timeout, etc.) — don't block, just leave unverified
    return null;
  }
}

// ─── Phone validation ───

/**
 * E.164 phone number validation.
 * Accepts: +[country][number] where number is 7-15 digits.
 * Also accepts Brazilian formats with optional 0 prefix.
 */
function validatePhone(phone: string | null): 'VALID' | 'INVALID' | null {
  if (!phone) return null;

  const cleaned = phone.replace(/[\s\-()]/g, '');

  // E.164 format: + followed by country code and number
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return 'VALID';

  // Brazilian format: 55 followed by DDD + 8-9 digits (without +)
  if (/^55[1-9]{2}9?\d{8}$/.test(cleaned)) return 'VALID';

  // Brazilian with leading 0: 0XX9XXXXXXXX
  if (/^0[1-9]{2}9?\d{8}$/.test(cleaned)) return 'VALID';

  return 'INVALID';
}

// ─── Duplicate detection ───

interface PrismaLike {
  outreachMessage: {
    findFirst: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
    }) => Promise<unknown | null>;
  };
}

/**
 * Check if this lead already has a non-failed outreach message
 * for this channel — avoids accidental re-send on re-import.
 */
async function isDuplicateSend(
  leadId: string,
  channelId: ChannelId,
  prisma: PrismaLike,
): Promise<boolean> {
  try {
    const existing = await prisma.outreachMessage.findFirst({
      where: {
        leadId,
        channelId,
        status: { not: 'FAILED' },
      },
      orderBy: { createdAt: 'desc' },
    });
    return existing !== null;
  } catch {
    return false; // Best-effort
  }
}

// ─── Main enricher hook ───

export interface EnricherDeps {
  config?: Partial<EnricherConfig>;
  prisma?: PrismaLike;
}

/**
 * Enrich a lead before sending.
 *
 * This is the main hook called by the dispatcher for every lead.
 * It validates contact info, detects timezone, and checks for duplicates.
 *
 * If the lead's contact is invalid for the target channel, marks it as skipped.
 */
export async function enrichLeadBeforeSend(
  lead: EnrichableLead,
  channel: ChannelId,
  deps: EnricherDeps = {},
): Promise<EnrichedLead> {
  const config: EnricherConfig = { ...DEFAULT_CONFIG, ...deps.config };
  const result: EnrichedLead = { lead, skipped: false };

  // Timezone detection
  if (!lead.timezone) {
    result.detectedTimezone = detectTimezone(
      { timezone: lead.timezone, phone: lead.phone, location: lead.location },
      config.defaultTimezone,
    );
  }

  // Email validation (only for email channel)
  if (channel === 'email' && lead.email && lead.emailStatus !== 'VALID' && lead.emailStatus !== 'INVALID') {
    const status = await validateEmail(lead.email, config);
    if (status) result.emailValidation = status;
  }

  // Phone validation (only for WhatsApp channel)
  if (channel === 'whatsapp' && lead.phone && lead.phoneStatus !== 'VALID' && lead.phoneStatus !== 'INVALID') {
    const status = validatePhone(lead.phone);
    if (status) result.phoneValidation = status;
  }

  // Skip if contact is invalid for the target channel
  if (channel === 'email' && (result.emailValidation === 'INVALID' || lead.emailStatus === 'INVALID')) {
    result.skipped = true;
    result.skipReason = 'SKIPPED_INVALID_CONTACT: email invalid';
  }

  if (channel === 'whatsapp' && (result.phoneValidation === 'INVALID' || lead.phoneStatus === 'INVALID')) {
    result.skipped = true;
    result.skipReason = 'SKIPPED_INVALID_CONTACT: phone invalid';
  }

  // Duplicate detection (best-effort)
  if (!result.skipped && deps.prisma) {
    const isDuplicate = await isDuplicateSend(lead.id, channel, deps.prisma);
    if (isDuplicate) {
      result.skipped = true;
      result.skipReason = 'SKIPPED_DUPLICATE: already sent to this lead on this channel';
    }
  }

  return result;
}