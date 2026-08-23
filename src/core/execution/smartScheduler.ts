import type { ChannelId } from '../channels/types.js';

/** Schedule configuration (env-driven with optional overrides) */
export interface ScheduleConfig {
  businessHoursStart: string;    // HH:MM
  businessHoursEnd: string;      // HH:MM
  daysOfWeek: number[];          // 0=Sun, 1=Mon, ..., 6=Sat
  respectLeadTimezone: boolean;
  defaultTimezone: string;
  whatsappBusinessHoursStart: string;
  whatsappBusinessHoursEnd: string;
}

/** Minimal lead info needed for scheduling decisions */
export interface SchedulableLead {
  timezone?: string | null;
  phone?: string | null;
  location?: string | null;
}

/** Brazilian DDD → IANA timezone mapping */
const BRAZIL_DDD_TIMEZONE: Record<string, string> = {
  '68': 'America/Rio_Branco',        // Acre: UTC-5
  '69': 'America/Porto_Velho',       // Rondônia (part): UTC-4
  '65': 'America/Cuiaba',            // Mato Grosso: UTC-4
  '66': 'America/Cuiaba',            // Mato Grosso (part): UTC-4
  '67': 'America/Campo_Grande',      // Mato Grosso do Sul: UTC-4
  '95': 'America/Boa_Vista',         // Roraima: UTC-4
  // All others default to Brasília: UTC-3
};

/** Brazilian state/city keywords → timezone */
const BRAZIL_LOCATION_TIMEZONE: Array<{ pattern: RegExp; tz: string }> = [
  { pattern: /\b(acre|rio branco|cruzeiro do sul)\b/i, tz: 'America/Rio_Branco' },
  { pattern: /\b(mato grosso|cuiab[aá]|rondon[oó]polis|sinop)\b/i, tz: 'America/Cuiaba' },
  { pattern: /\b(mato grosso do sul|campo grande|dourados|tr[eê]s lagoas)\b/i, tz: 'America/Campo_Grande' },
  { pattern: /\b(amazonas|manaus|parintins|itacoatiara)\b(?!.*\b(parte|extremo)\b)/i, tz: 'America/Manaus' },
  { pattern: /\b(roraima|boa vista)\b/i, tz: 'America/Boa_Vista' },
  { pattern: /\b(rond[ôo]nia|porto velho|ji-paran[aá])\b/i, tz: 'America/Porto_Velho' },
  { pattern: /\b(fernando de noronha)\b/i, tz: 'America/Noronha' },
];

/** Parse HH:MM to [hours, minutes] */
function parseTime(t: string): [number, number] {
  const [h, m] = t.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

/**
 * Detect a lead's timezone from available fields.
 *
 * Priority:
 * 1. Lead.timezone (if populated via enrichment)
 * 2. Phone DDD → timezone (Brazil only)
 * 3. Location text match
 * 4. Default timezone from config
 */
export function detectTimezone(lead: SchedulableLead, defaultTimezone: string): string {
  if (lead.timezone) return lead.timezone;

  // Try DDD-based inference (Brazil phone numbers)
  if (lead.phone) {
    const ddd = extractBrazilDDD(lead.phone);
    if (ddd && BRAZIL_DDD_TIMEZONE[ddd]) {
      return BRAZIL_DDD_TIMEZONE[ddd];
    }
    // If it's a Brazilian number without a specific mapping, default to Brasília
    if (ddd) return 'America/Sao_Paulo';
  }

  // Try location-based inference
  if (lead.location) {
    for (const { pattern, tz } of BRAZIL_LOCATION_TIMEZONE) {
      if (pattern.test(lead.location)) return tz;
    }
    // If location mentions Brazil, default to Brasilia
    if (/\b(brasil|brazil|s[aã]o paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|salvador|fortaleza|recife|bras[ií]lia|florian[oó]polis|vit[oó]ria|goi[âa]nia|bel[eé]m|natal|jo[aã]o pessoa|teresina|aracaju|palmas|macap[aá])\b/i.test(lead.location)) {
      return 'America/Sao_Paulo';
    }
  }

  return defaultTimezone;
}

/** Extract DDD from Brazilian phone number (e.g. +5511999999999 → "11") */
function extractBrazilDDD(phone: string): string | null {
  const cleaned = phone.replace(/\D/g, '');
  // +55 XX 9XXXX-XXXX or 55XX9XXXXXXXX
  if (cleaned.startsWith('55') && cleaned.length >= 12) {
    return cleaned.substring(2, 4);
  }
  // 0XX...
  if (cleaned.startsWith('0') && cleaned.length >= 11) {
    return cleaned.substring(1, 3);
  }
  // Without country code, 10-11 digits
  if (!cleaned.startsWith('55') && !cleaned.startsWith('0') && cleaned.length >= 10) {
    return cleaned.substring(0, 2);
  }
  return null;
}

/**
 * Determine whether it is currently appropriate to send a message
 * to the given lead on the given channel.
 */
export function shouldSendNow(
  lead: SchedulableLead,
  channel: ChannelId,
  config: ScheduleConfig,
  now: Date = new Date(),
): boolean {
  if (!config.respectLeadTimezone && channel !== 'whatsapp') {
    return true; // No timezone check needed
  }

  const timezone = detectTimezone(lead, config.defaultTimezone);

  // WhatsApp has a more restrictive window per Meta policy
  const startStr = channel === 'whatsapp' ? config.whatsappBusinessHoursStart : config.businessHoursStart;
  const endStr = channel === 'whatsapp' ? config.whatsappBusinessHoursEnd : config.businessHoursEnd;

  const dayOfWeek = getDayOfWeekInTimezone(now, timezone);
  if (!config.daysOfWeek.includes(dayOfWeek)) return false;

  const timeStr = getTimeStringInTimezone(now, timezone);
  return isTimeInRange(timeStr, startStr, endStr);
}

/**
 * Calculate the next available send slot if now is outside business hours.
 */
export function nextAvailableSlot(
  lead: SchedulableLead,
  channel: ChannelId,
  config: ScheduleConfig,
  now: Date = new Date(),
): Date {
  if (!config.respectLeadTimezone && channel !== 'whatsapp') {
    return now; // Send immediately
  }

  const timezone = detectTimezone(lead, config.defaultTimezone);

  const startStr = channel === 'whatsapp' ? config.whatsappBusinessHoursStart : config.businessHoursStart;
  const endStr = channel === 'whatsapp' ? config.whatsappBusinessHoursEnd : config.businessHoursEnd;

  const [startH, startM] = parseTime(startStr);
  const [endH, endM] = parseTime(endStr);

  // Get current time in lead's timezone
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const localDate = getPart(parts, 'year') + '-' + getPart(parts, 'month') + '-' + getPart(parts, 'day');
  const localHour = parseInt(getPart(parts, 'hour'), 10);
  const localMinute = parseInt(getPart(parts, 'minute'), 10);
  const localSeconds = parseInt(getPart(parts, 'second'), 10);

  const localTimeMinutes = localHour * 60 + localMinute;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  let candidateLocal: Date;

  if (localTimeMinutes >= endMinutes) {
    // After business hours → next day at start
    candidateLocal = new Date(`${localDate}T${startStr}:00`);
    candidateLocal.setDate(candidateLocal.getDate() + 1);
  } else if (localTimeMinutes < startMinutes) {
    // Before business hours → today at start
    candidateLocal = new Date(`${localDate}T${startStr}:00`);
  } else {
    // During business hours but maybe wrong day of week
    candidateLocal = new Date(`${localDate}T${startStr}:00`);
  }

  // Adjust to next valid day of week
  while (true) {
    const dayOfWeek = candidateLocal.getDay();
    if (config.daysOfWeek.includes(dayOfWeek)) break;
    candidateLocal.setDate(candidateLocal.getDate() + 1);
  }

  // Make sure we're not scheduling in the past
  if (candidateLocal <= now) {
    candidateLocal.setDate(candidateLocal.getDate() + 1);
    while (true) {
      const dayOfWeek = candidateLocal.getDay();
      if (config.daysOfWeek.includes(dayOfWeek)) break;
      candidateLocal.setDate(candidateLocal.getDate() + 1);
    }
  }

  // Convert from local timezone to UTC
  // We do this by constructing the UTC equivalent
  const localStr = candidateLocal.toISOString().slice(0, 19);
  // Actually we need a proper conversion. Use Intl.DateTimeFormat offset.
  const offsetMinutes = getTimezoneOffset(timezone, now);
  return new Date(candidateLocal.getTime() - offsetMinutes * 60_000 + getTimezoneOffset(timezone, candidateLocal) * 60_000);
}

// ─── Helpers ───

function getPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find(p => p.type === type)?.value ?? '00';
}

function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
  const dayName = fmt.format(date);
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return days[dayName] ?? 0;
}

function getTimeStringInTimezone(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const h = getPart(parts, 'hour');
  const m = getPart(parts, 'minute');
  return `${h}:${m}`;
}

function isTimeInRange(time: string, start: string, end: string): boolean {
  return time >= start && time <= end;
}

function getTimezoneOffset(timezone: string, date: Date): number {
  // Get UTC offset for a timezone at a given date
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(date);
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  if (offsetPart === 'GMT' || offsetPart === 'UTC') return 0;

  const match = offsetPart.match(/GMT([+-]\d+)(?::?(\d+))?/);
  if (match) {
    const sign = match[1]!.startsWith('-') ? -1 : 1;
    const hours = parseInt(match[1]!.replace(/[+-]/, ''), 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    return sign * (hours * 60 + minutes);
  }
  return 0;
}