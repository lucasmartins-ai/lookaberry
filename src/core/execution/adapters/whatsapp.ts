import type { ChannelAdapter, ExecutionContext, ExecutionResult } from '../types.js';
import type { ChannelCapability } from '../../channels/types.js';
import type { RecommendedAction } from '../../decision/types.js';

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelId = 'whatsapp' as const;

  canHandle(capability: ChannelCapability): boolean {
    return ['sendMessage', 'readMessages', 'followUp', 'verifyDelivery'].includes(capability);
  }

  async execute(_action: RecommendedAction, _context: ExecutionContext): Promise<ExecutionResult> {
    return {
      success: false,
      error: 'WhatsApp channel NOT_IMPLEMENTED — stub adapter.',
      retryable: false,
      rateLimitHit: false,
    };
  }
}