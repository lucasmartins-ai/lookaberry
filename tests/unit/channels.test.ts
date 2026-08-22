import { describe, expect, it } from 'vitest';
import { ChannelRegistry, channelRegistry } from '../../src/core/channels/registry.js';
import { legacyChannelToChannelId } from '../../src/core/channels/types.js';
import type { ChannelId } from '../../src/core/channels/types.js';

describe('Channel Registry', () => {
  describe('can(capability)', () => {
    it('reports linkedin supports all capabilities', () => {
      expect(channelRegistry.can('linkedin', 'connect')).toBe(true);
      expect(channelRegistry.can('linkedin', 'sendMessage')).toBe(true);
      expect(channelRegistry.can('linkedin', 'readMessages')).toBe(true);
      expect(channelRegistry.can('linkedin', 'searchProfiles')).toBe(true);
      expect(channelRegistry.can('linkedin', 'followUp')).toBe(true);
      expect(channelRegistry.can('linkedin', 'verifyDelivery')).toBe(true);
    });

    it('reports email does NOT support connect', () => {
      expect(channelRegistry.can('email', 'sendMessage')).toBe(true);
      expect(channelRegistry.can('email', 'connect')).toBe(false);
      expect(channelRegistry.can('email', 'searchProfiles')).toBe(false);
      expect(channelRegistry.can('email', 'readMessages')).toBe(false);
    });

    it('reports manual only supports followUp', () => {
      expect(channelRegistry.can('manual', 'followUp')).toBe(true);
      expect(channelRegistry.can('manual', 'sendMessage')).toBe(false);
      expect(channelRegistry.can('manual', 'connect')).toBe(false);
      expect(channelRegistry.can('manual', 'searchProfiles')).toBe(false);
    });

    it('reports whatsapp supports messaging but not connect', () => {
      expect(channelRegistry.can('whatsapp', 'sendMessage')).toBe(true);
      expect(channelRegistry.can('whatsapp', 'readMessages')).toBe(true);
      expect(channelRegistry.can('whatsapp', 'followUp')).toBe(true);
      expect(channelRegistry.can('whatsapp', 'connect')).toBe(false);
      expect(channelRegistry.can('whatsapp', 'searchProfiles')).toBe(false);
    });

    it('returns false for unknown channel', () => {
      expect(channelRegistry.can('unknown' as ChannelId, 'sendMessage')).toBe(false);
    });
  });

  describe('getProfile', () => {
    it('returns profile for known channels', () => {
      const profile = channelRegistry.getProfile('linkedin');
      expect(profile).toBeDefined();
      expect(profile!.requiresBrowser).toBe(true);
      expect(profile!.requiresAuth).toBe(true);
      expect(profile!.defaultDailyLimit).toBe(100);
      expect(profile!.rateLimitWindowMs).toBe(3000);
      expect(profile!.safetyPauseMs).toBe(48 * 60 * 60 * 1000);
    });

    it('returns undefined for unknown channel', () => {
      expect(channelRegistry.getProfile('unknown' as ChannelId)).toBeUndefined();
    });
  });

  describe('isKnown', () => {
    it('recognises valid ChannelId strings', () => {
      expect(channelRegistry.isKnown('linkedin')).toBe(true);
      expect(channelRegistry.isKnown('email')).toBe(true);
      expect(channelRegistry.isKnown('whatsapp')).toBe(true);
      expect(channelRegistry.isKnown('manual')).toBe(true);
    });

    it('rejects unknown strings', () => {
      expect(channelRegistry.isKnown('slack')).toBe(false);
      expect(channelRegistry.isKnown('')).toBe(false);
    });
  });

  describe('listChannelIds', () => {
    it('returns all registered channels', () => {
      const ids = channelRegistry.listChannelIds();
      expect(ids).toContain('linkedin');
      expect(ids).toContain('email');
      expect(ids).toContain('whatsapp');
      expect(ids).toContain('manual');
      expect(ids.length).toBe(4);
    });
  });

  describe('custom profiles', () => {
    it('accepts custom profile set at construction time', () => {
      const custom = new ChannelRegistry([
        {
          channelId: 'linkedin',
          defaultDailyLimit: 50,
          requiresAuth: true,
          requiresBrowser: true,
          supportedActions: ['connect', 'sendMessage'],
          rateLimitWindowMs: 10_000,
          safetyPauseMs: 12 * 60 * 60 * 1_000,
        },
      ]);

      expect(custom.can('linkedin', 'connect')).toBe(true);
      expect(custom.can('linkedin', 'searchProfiles')).toBe(false);
      expect(custom.can('email', 'sendMessage')).toBe(false); // not registered
      expect(custom.getProfile('linkedin')!.defaultDailyLimit).toBe(50);
      expect(custom.getProfile('linkedin')!.rateLimitWindowMs).toBe(10_000);
    });
  });
});

describe('legacyChannelToChannelId', () => {
  it('maps LINKEDIN_CONNECT and LINKEDIN_MESSAGE to linkedin', () => {
    expect(legacyChannelToChannelId('LINKEDIN_CONNECT')).toBe('linkedin');
    expect(legacyChannelToChannelId('LINKEDIN_MESSAGE')).toBe('linkedin');
  });

  it('maps EMAIL to email', () => {
    expect(legacyChannelToChannelId('EMAIL')).toBe('email');
  });

  it('maps MANUAL_TASK to manual', () => {
    expect(legacyChannelToChannelId('MANUAL_TASK')).toBe('manual');
  });

  it('passes through valid ChannelId values unchanged', () => {
    expect(legacyChannelToChannelId('linkedin')).toBe('linkedin');
    expect(legacyChannelToChannelId('email')).toBe('email');
    expect(legacyChannelToChannelId('whatsapp')).toBe('whatsapp');
    expect(legacyChannelToChannelId('manual')).toBe('manual');
  });

  it('falls back to manual for unknown values', () => {
    expect(legacyChannelToChannelId('SLACK')).toBe('manual');
    expect(legacyChannelToChannelId('')).toBe('manual');
  });
});