import type { ChannelAdapter, ExecutionContext, ExecutionResult } from './types.js';
import type { ChannelCapability, ChannelId } from '../channels/types.js';
import type { RecommendedAction } from '../decision/types.js';
import { channelRegistry } from '../channels/registry.js';

export interface ExecutionRouterDependencies {
  adapters?: Map<ChannelId, ChannelAdapter>;
}

export class ExecutionRouter {
  private readonly adapters: Map<ChannelId, ChannelAdapter>;

  constructor(deps: ExecutionRouterDependencies = {}) {
    this.adapters = deps.adapters ?? new Map();
  }

  /** Register an adapter for a specific channel */
  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelId, adapter);
  }

  /** Get a registered adapter */
  getAdapter(channel: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  /** Execute a RecommendedAction through the appropriate adapter */
  async execute(action: RecommendedAction, context: ExecutionContext): Promise<ExecutionResult> {
    // Validate the channel is known
    if (!channelRegistry.isKnown(action.channel)) {
      return {
        success: false,
        error: `Unknown channel: ${action.channel}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Validate the channel supports the required capability
    if (!channelRegistry.can(action.channel, action.capability)) {
      return {
        success: false,
        error: `Channel ${action.channel} does not support capability ${action.capability}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Find the adapter for this channel
    const adapter = this.adapters.get(action.channel);
    if (!adapter) {
      return {
        success: false,
        error: `No adapter registered for channel: ${action.channel}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Validate the adapter supports the required capability
    if (!adapter.canHandle(action.capability)) {
      return {
        success: false,
        error: `Adapter for ${action.channel} does not support capability ${action.capability}`,
        retryable: false,
        rateLimitHit: false,
      };
    }

    // Execute through the adapter
    return adapter.execute(action, context);
  }
}