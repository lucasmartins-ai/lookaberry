import { normalizeProviderSignal } from './common.js';
import type { RawSignal, SignalCollectionInput, SignalProvider } from './types.js';
import { SignalProviderError } from './types.js';

export const credentialedFundingProvider: SignalProvider = {
  id: 'funding-api',
  type: 'funding_api',
  source: 'FUNDING_API',
  cost: 1,
  ttlDays: 60,

  getAvailability(_input: SignalCollectionInput) {
    return {
      status: 'REQUIRES_CREDENTIALS',
      reason: 'No funding API adapter is enabled; provide credentials and an approved adapter before collection.',
    };
  },

  async collect(_input: SignalCollectionInput): Promise<RawSignal[]> {
    throw new SignalProviderError('REQUIRES_CREDENTIALS', 'Funding API collection requires an authenticated adapter.');
  },

  normalize(signal) {
    return [normalizeProviderSignal(signal)];
  },
};
