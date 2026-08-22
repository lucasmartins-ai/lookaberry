import type { ChannelAdapter, ExecutionContext, ExecutionResult } from '../types.js';
import type { ChannelCapability } from '../../channels/types.js';
import type { RecommendedAction } from '../../decision/types.js';

export class ManualAdapter implements ChannelAdapter {
  readonly channelId = 'manual' as const;

  canHandle(capability: ChannelCapability): boolean {
    return capability === 'followUp';
  }

  async execute(action: RecommendedAction, context: ExecutionContext): Promise<ExecutionResult> {
    if (context.dryRun) {
      return {
        success: true,
        externalId: `dry-run:manual:${action.capability}:${context.lead.id}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    return {
      success: true,
      externalId: `manual-task:${context.lead.id}`,
      retryable: false,
      rateLimitHit: false,
    };
  }
}