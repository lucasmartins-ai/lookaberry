import type { ChannelCapability, ChannelId } from '../channels/types.js';
import type { RecommendedAction } from '../decision/types.js';

import type { BranchCondition as PrismaBranchCondition } from '@prisma/client';

/** Re-export from Prisma so consumers don't need @prisma/client */
export type BranchCondition = PrismaBranchCondition | 'NONE' | 'OPENED' | 'NOT_OPENED' | 'REPLIED' | 'NOT_REPLIED' | 'CLICKED' | 'BOUNCED';

/** Contract every channel adapter must implement */
export interface ChannelAdapter {
  /** Channel this adapter handles */
  readonly channelId: ChannelId;

  /** Execute a recommended action against the real channel */
  execute(action: RecommendedAction, context: ExecutionContext): Promise<ExecutionResult>;

  /** Whether this adapter can handle a specific capability */
  canHandle(capability: ChannelCapability): boolean;
}

/** Data needed to execute an action against a real channel */
export interface ExecutionContext {
  /** Lead being targeted */
  lead: {
    id: string;
    firstName: string;
    lastName: string | null;
    fullName: string;
    title: string;
    linkedinUrl: string | null;
    email: string | null;
    phone: string | null;
    phoneStatus: string | null;
  };
  /** Company associated with the lead */
  company: {
    id: string;
    name: string;
    domain: string;
    linkedinUrl: string | null;
  };
  /** Outreach account with credentials / session info */
  account: {
    id: string;
    provider: string;
    externalId: string;
    dailyLimit: number;
    sentToday: number;
    pausedUntil: Date | null;
    sessionKey: string | null;
  };
  /** The outreach message record */
  message: {
    id: string;
    subject: string | null;
    body: string;
    outreachAccountId: string | null;
  };
  /** If true, skip actual execution and simulate the result */
  dryRun: boolean;
}

/** Result of executing an action */
export interface ExecutionResult {
  /** Whether the action was successful */
  success: boolean;
  /** Provider-assigned external ID (thread URL, message ID, profile URL) */
  externalId?: string;
  /** Human-readable error message */
  error?: string;
  /** Whether the action can be retried */
  retryable: boolean;
  /** Whether the channel hit a rate limit */
  rateLimitHit: boolean;
  /** If set, channel should be paused until this timestamp */
  channelPausedUntil?: Date;
}