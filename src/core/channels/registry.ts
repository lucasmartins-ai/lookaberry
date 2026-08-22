import type { ChannelCapability, ChannelId, ChannelProfile } from './types.js';

/** Default channel profiles with conservative operational limits */
export const DEFAULT_CHANNEL_PROFILES: ChannelProfile[] = [
  {
    channelId: 'linkedin',
    defaultDailyLimit: 100,
    requiresAuth: true,
    requiresBrowser: true,
    supportedActions: ['connect', 'sendMessage', 'readMessages', 'searchProfiles', 'followUp', 'verifyDelivery'],
    rateLimitWindowMs: 3_000,
    safetyPauseMs: 48 * 60 * 60 * 1_000,
  },
  {
    channelId: 'email',
    defaultDailyLimit: 200,
    requiresAuth: true,
    requiresBrowser: false,
    supportedActions: ['sendMessage', 'followUp', 'verifyDelivery'],
    rateLimitWindowMs: 1_000,
    safetyPauseMs: 24 * 60 * 60 * 1_000,
  },
  {
    channelId: 'whatsapp',
    defaultDailyLimit: 50,
    requiresAuth: true,
    requiresBrowser: true,
    supportedActions: ['sendMessage', 'readMessages', 'followUp', 'verifyDelivery'],
    rateLimitWindowMs: 5_000,
    safetyPauseMs: 24 * 60 * 60 * 1_000,
  },
  {
    channelId: 'manual',
    defaultDailyLimit: Number.POSITIVE_INFINITY,
    requiresAuth: false,
    requiresBrowser: false,
    supportedActions: ['followUp'],
    rateLimitWindowMs: 0,
    safetyPauseMs: 0,
  },
];

/**
 * Registry that maps ChannelId → ChannelProfile and answers capability queries.
 *
 * The decision engine uses can() to filter recommended actions.
 * The outreach service uses getProfile() for anti-ban constraints.
 */
export class ChannelRegistry {
  private readonly profiles: Map<ChannelId, ChannelProfile>;

  constructor(profiles: ChannelProfile[] = DEFAULT_CHANNEL_PROFILES) {
    this.profiles = new Map();
    for (const p of profiles) {
      this.profiles.set(p.channelId, p);
    }
  }

  /** Check whether a channel supports a specific capability */
  can(channel: ChannelId, capability: ChannelCapability): boolean {
    const profile = this.profiles.get(channel);
    return profile ? profile.supportedActions.includes(capability) : false;
  }

  /** Retrieve the full profile for a channel (undefined if unknown) */
  getProfile(channel: ChannelId): ChannelProfile | undefined {
    return this.profiles.get(channel);
  }

  /** Type guard: is an arbitrary string a known ChannelId? */
  isKnown(channel: string): channel is ChannelId {
    return this.profiles.has(channel as ChannelId);
  }

  /** List all registered channel ids */
  listChannelIds(): ChannelId[] {
    return [...this.profiles.keys()];
  }
}

/** Singleton instance built from default profiles */
export const channelRegistry = new ChannelRegistry(DEFAULT_CHANNEL_PROFILES);