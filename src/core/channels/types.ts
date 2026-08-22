/** Supported communication channel identifiers (open set, not tied to DB enum) */
export type ChannelId = 'linkedin' | 'email' | 'whatsapp' | 'manual';

/** Capabilities a channel can expose — what it can do automatically */
export type ChannelCapability =
  | 'connect'
  | 'sendMessage'
  | 'readMessages'
  | 'searchProfiles'
  | 'followUp'
  | 'verifyDelivery';

/** Operational limits and characteristics of a channel */
export interface ChannelProfile {
  /** Channel this profile describes */
  channelId: ChannelId;
  /** Recommended default daily action limit per account */
  defaultDailyLimit: number;
  /** Whether the channel requires authentication credentials */
  requiresAuth: boolean;
  /** Whether the channel requires a browser (e.g. for anti-detection) */
  requiresBrowser: boolean;
  /** Capabilities this channel supports */
  supportedActions: ChannelCapability[];
  /** Minimum window between actions in milliseconds (rate limit) */
  rateLimitWindowMs: number;
  /** How long to pause the channel after a safety signal (CAPTCHA / 429) */
  safetyPauseMs: number;
}

/** Map a legacy Prisma ChannelType enum value to the new ChannelId */
export function legacyChannelToChannelId(legacy: string): ChannelId {
  switch (legacy) {
    case 'LINKEDIN_CONNECT':
    case 'LINKEDIN_MESSAGE':
      return 'linkedin';
    case 'EMAIL':
      return 'email';
    case 'MANUAL_TASK':
      return 'manual';
    default:
      // If it's already a valid ChannelId, return it
      if (['linkedin', 'email', 'whatsapp', 'manual'].includes(legacy)) {
        return legacy as ChannelId;
      }
      return 'manual';
  }
}