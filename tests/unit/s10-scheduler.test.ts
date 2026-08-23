import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  shouldSendNow,
  nextAvailableSlot,
  detectTimezone,
} from '../../src/core/execution/smartScheduler.js';
import type { ScheduleConfig, SchedulableLead } from '../../src/core/execution/smartScheduler.js';
import type { ChannelId } from '../../src/core/channels/types.js';

const baseConfig: ScheduleConfig = {
  businessHoursStart: '09:00',
  businessHoursEnd: '18:00',
  daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
  respectLeadTimezone: true,
  defaultTimezone: 'America/Sao_Paulo',
  whatsappBusinessHoursStart: '08:00',
  whatsappBusinessHoursEnd: '20:00',
};

// ─── detectTimezone ───

describe('detectTimezone', () => {
  it('returns lead.timezone when set', () => {
    const lead: SchedulableLead = { timezone: 'America/New_York' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/New_York');
  });

  it('infers from DDD 68 → Acre (UTC-5)', () => {
    const lead: SchedulableLead = { phone: '+5568999999999' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Rio_Branco');
  });

  it('infers from DDD 65 → Mato Grosso (UTC-4)', () => {
    const lead: SchedulableLead = { phone: '5565999999999' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Cuiaba');
  });

  it('infers from DDD 11 → default São Paulo (UTC-3)', () => {
    const lead: SchedulableLead = { phone: '+5511999999999' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('infers from DDD 0XX format', () => {
    const lead: SchedulableLead = { phone: '011999999999' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('infers from location — Acre', () => {
    const lead: SchedulableLead = { location: 'Rio Branco, Acre' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Rio_Branco');
  });

  it('infers from location — Mato Grosso do Sul', () => {
    const lead: SchedulableLead = { location: 'Campo Grande, Mato Grosso do Sul' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Campo_Grande');
  });

  it('infers from location — Amazonas', () => {
    const lead: SchedulableLead = { location: 'Manaus, Amazonas' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Manaus');
  });

  it('infers from location — São Paulo (default)', () => {
    const lead: SchedulableLead = { location: 'São Paulo, SP' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('falls back to default when no data available', () => {
    const lead: SchedulableLead = {};
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('phone DDD takes priority over location', () => {
    const lead: SchedulableLead = { phone: '5565999999999', location: 'São Paulo, SP' };
    expect(detectTimezone(lead, 'America/Sao_Paulo')).toBe('America/Cuiaba');
  });
});

// ─── shouldSendNow ───

describe('shouldSendNow', () => {
  it('returns true during business hours on weekday (email)', () => {
    // Monday 2026-08-24 10:00 UTC = 07:00 Brasília → before business hours
    // Use a time that is 10:00 Brasília on a Monday
    // Monday Aug 24 2026 13:00 UTC = 10:00 BRT
    const now = new Date('2026-08-24T13:00:00Z'); // 10:00 BRT (UTC-3)
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'email', baseConfig, now)).toBe(true);
  });

  it('returns false before business hours (email)', () => {
    // Monday 10:00 UTC = 07:00 BRT — too early
    const now = new Date('2026-08-24T10:00:00Z');
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'email', baseConfig, now)).toBe(false);
  });

  it('returns false after business hours (email)', () => {
    // Monday 22:00 UTC = 19:00 BRT — after hours
    const now = new Date('2026-08-24T22:00:00Z');
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'email', baseConfig, now)).toBe(false);
  });

  it('returns false on weekend (Saturday)', () => {
    // Saturday Aug 29 2026 13:00 UTC = 10:00 BRT
    const now = new Date('2026-08-29T13:00:00Z'); // Saturday
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'email', baseConfig, now)).toBe(false);
  });

  it('returns true for WhatsApp within 08:00-20:00 window', () => {
    // Monday 12:00 UTC = 09:00 BRT — within WhatsApp window
    const now = new Date('2026-08-24T12:00:00Z');
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'whatsapp', baseConfig, now)).toBe(true);
  });

  it('returns false for WhatsApp before 08:00 window', () => {
    // Monday 14:00 UTC = 11:00 BRT — wait, that's within business hours...
    // Let's use 10:00 UTC = 07:00 BRT — before WhatsApp window
    const now = new Date('2026-08-24T10:00:00Z');
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'whatsapp', baseConfig, now)).toBe(false);
  });

  it('returns true when respectLeadTimezone is false (email)', () => {
    const config = { ...baseConfig, respectLeadTimezone: false };
    const now = new Date('2026-08-29T13:00:00Z'); // Saturday
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    expect(shouldSendNow(lead, 'email', config, now)).toBe(true);
  });

  it('still checks WhatsApp window even when respectLeadTimezone is false', () => {
    const config = { ...baseConfig, respectLeadTimezone: false };
    // 10:00 UTC — we don't know local time since we don't respect timezone
    // With respectLeadTimezone=false, we skip the check for non-whatsapp, but
    // for whatsapp we still check the window (per spec: "WhatsApp: janela mais restrita")
    const now = new Date('2026-08-24T14:00:00Z');
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    // At 14:00 UTC = 11:00 BRT — within WhatsApp window
    expect(shouldSendNow(lead, 'whatsapp', config, now)).toBe(true);
  });

  it('resolves timezone from lead data (DDD-based)', () => {
    // DDD 65 → Cuiaba (UTC-4). Monday 12:00 UTC = 08:00 Cuiaba → before hours for email
    const now = new Date('2026-08-24T12:00:00Z');
    const lead: SchedulableLead = { phone: '5565999999999' };
    expect(shouldSendNow(lead, 'email', baseConfig, now)).toBe(false);
  });
});

// ─── nextAvailableSlot ───

describe('nextAvailableSlot', () => {
  it('returns a future date when before business hours', () => {
    // Monday 10:00 UTC = 07:00 BRT → next slot is today at 09:00 BRT = 12:00 UTC
    const now = new Date('2026-08-24T10:00:00Z');
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    const next = nextAvailableSlot(lead, 'email', baseConfig, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    // Should be same day (Monday)
    expect(next.getUTCDay()).toBe(1); // Monday
  });

  it('skips to next business day when after hours on Friday', () => {
    // Friday 22:00 UTC = 19:00 BRT → next slot is Monday at 09:00 BRT
    const now = new Date('2026-08-28T22:00:00Z'); // Friday
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    const next = nextAvailableSlot(lead, 'email', baseConfig, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getUTCDay()).toBe(1); // Monday
  });

  it('returns immediate when respectLeadTimezone is false', () => {
    const config = { ...baseConfig, respectLeadTimezone: false };
    const now = new Date('2026-08-28T22:00:00Z'); // Friday
    const lead: SchedulableLead = { timezone: 'America/Sao_Paulo' };
    const next = nextAvailableSlot(lead, 'email', config, now);
    expect(next.getTime()).toBe(now.getTime());
  });
});