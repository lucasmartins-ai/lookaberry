import type { ChannelAdapter, ExecutionContext, ExecutionResult } from '../types.js';
import type { ChannelCapability } from '../../channels/types.js';
import type { RecommendedAction } from '../../decision/types.js';

export class EmailAdapter implements ChannelAdapter {
  readonly channelId = 'email' as const;

  canHandle(capability: ChannelCapability): boolean {
    return ['sendMessage', 'followUp', 'verifyDelivery'].includes(capability);
  }

  async execute(_action: RecommendedAction, _context: ExecutionContext): Promise<ExecutionResult> {
    return {
      success: false,
      error: 'Email channel NOT_IMPLEMENTED — stub adapter.',
      retryable: false,
      rateLimitHit: false,
    };
  }
}