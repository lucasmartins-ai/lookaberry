import type { ChannelAdapter, ExecutionContext, ExecutionResult } from '../types.js';
import type { ChannelCapability } from '../../channels/types.js';
import type { RecommendedAction } from '../../decision/types.js';
import { AntigravityClient } from '../antigravity.js';
import type { AntigravityClientDependencies } from '../antigravity.js';

const SUPPORTED_CAPABILITIES: ChannelCapability[] = [
  'connect',
  'sendMessage',
  'readMessages',
  'searchProfiles',
  'followUp',
  'verifyDelivery',
];

export interface LinkedInAdapterDependencies {
  client?: AntigravityClient;
  antigravityDeps?: AntigravityClientDependencies;
}

export class LinkedInAdapter implements ChannelAdapter {
  readonly channelId = 'linkedin' as const;
  private readonly client: AntigravityClient;

  constructor(deps: LinkedInAdapterDependencies = {}) {
    this.client = deps.client ?? new AntigravityClient(deps.antigravityDeps);
  }

  canHandle(capability: ChannelCapability): boolean {
    return SUPPORTED_CAPABILITIES.includes(capability);
  }

  async execute(action: RecommendedAction, context: ExecutionContext): Promise<ExecutionResult> {
    if (context.dryRun) {
      return {
        success: true,
        externalId: `dry-run:linkedin:${action.capability}:${context.lead.id}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    try {
      // Health check before any action
      await this.client.assertHealthy();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: msg,
        retryable: true,
        rateLimitHit: false,
      };
    }

    const sessionKey = context.account.sessionKey ?? undefined;

    try {
      switch (action.capability) {
        case 'connect':
          return await this.executeConnect(context, sessionKey);
        case 'sendMessage':
          return await this.executeSendMessage(context, sessionKey);
        case 'searchProfiles':
          return await this.executeSearchProfiles(action.template, sessionKey);
        case 'readMessages':
          return await this.executeReadInbox();
        case 'followUp':
          return await this.executeSendMessage(context, sessionKey);
        case 'verifyDelivery':
          return await this.verifyDelivery(context);
        default:
          return {
            success: false,
            error: `Unsupported capability: ${action.capability}`,
            retryable: false,
            rateLimitHit: false,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Classify the error
      const isRateLimited = msg.includes('429') || msg.includes('RATE_LIMITED');
      const isCaptcha = msg.includes('CAPTCHA') || msg.includes('captcha') || msg.includes('challenge');
      const isForbidden = msg.includes('403') || msg.includes('forbidden');
      const isConnection = msg.includes('ECONNREFUSED') || msg.includes('connect');

      return {
        success: false,
        error: msg,
        retryable: !isForbidden && !isCaptcha,
        rateLimitHit: isRateLimited || isCaptcha,
        channelPausedUntil: (isRateLimited || isCaptcha)
          ? new Date(Date.now() + 48 * 60 * 60 * 1_000)
          : undefined,
      };
    }
  }

  private async executeConnect(context: ExecutionContext, sessionKey?: string): Promise<ExecutionResult> {
    const linkedinUrl = context.lead.linkedinUrl;
    if (!linkedinUrl) {
      return {
        success: false,
        error: 'Lead has no LinkedIn URL — cannot connect.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    const result = await this.client.connect({
      profileUrl: linkedinUrl,
      note: context.message.body,
      sessionKey,
    });

    return {
      success: result.success,
      externalId: result.threadUrl ?? linkedinUrl,
      error: result.error,
      retryable: !result.success,
      rateLimitHit: false,
    };
  }

  private async executeSendMessage(context: ExecutionContext, sessionKey?: string): Promise<ExecutionResult> {
    const linkedinUrl = context.lead.linkedinUrl;
    if (!linkedinUrl) {
      return {
        success: false,
        error: 'Lead has no LinkedIn URL — cannot send message.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    const result = await this.client.sendMessage({
      profileUrl: linkedinUrl,
      body: context.message.body,
      sessionKey,
    });

    return {
      success: result.success,
      externalId: result.threadUrl ?? result.externalId ?? linkedinUrl,
      error: result.error,
      retryable: !result.success,
      rateLimitHit: false,
    };
  }

  private async executeSearchProfiles(query: string, sessionKey?: string): Promise<ExecutionResult> {
    const result = await this.client.searchProfiles({ query, sessionKey });
    return {
      success: result.success,
      externalId: `search:${query.slice(0, 50)}:${result.profiles.length}`,
      error: result.error,
      retryable: !result.success,
      rateLimitHit: false,
    };
  }

  private async executeReadInbox(): Promise<ExecutionResult> {
    const result = await this.client.readInbox();
    return {
      success: result.success,
      externalId: `inbox:${result.messages.length}`,
      error: result.error,
      retryable: !result.success,
      rateLimitHit: false,
    };
  }

  private async verifyDelivery(context: ExecutionContext): Promise<ExecutionResult> {
    const linkedinUrl = context.lead.linkedinUrl;
    if (!linkedinUrl) {
      return {
        success: false,
        error: 'No LinkedIn URL to verify.',
        retryable: false,
        rateLimitHit: false,
      };
    }

    // verifyDelivery: search for the lead's profile to confirm it's still accessible
    const result = await this.client.searchProfiles({
      query: `${context.lead.firstName} ${context.lead.lastName ?? ''} ${context.company.name}`,
      sessionKey: context.account.sessionKey ?? undefined,
    });

    const found = result.profiles.some(
      p => p.url === linkedinUrl || p.url.includes(context.lead.id?.slice(0, 8) ?? ''),
    );

    return {
      success: found,
      externalId: linkedinUrl,
      error: found ? undefined : 'Profile not found in search results — may be blocked or restricted.',
      retryable: !found,
      rateLimitHit: false,
    };
  }
}