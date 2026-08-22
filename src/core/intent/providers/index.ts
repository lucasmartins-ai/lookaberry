import { hiringProvider } from './hiring.js';
import { publicAnnouncementsProvider } from './publicAnnouncements.js';
import { websiteChangesProvider } from './websiteChanges.js';
import { credentialedFundingProvider } from './credentialedFunding.js';
import type { SignalProvider } from './types.js';

export { hiringProvider } from './hiring.js';
export { publicAnnouncementsProvider } from './publicAnnouncements.js';
export { websiteChangesProvider } from './websiteChanges.js';
export { credentialedFundingProvider } from './credentialedFunding.js';
export { collectAndNormalizeProvider, collectAndNormalizeProviders } from './runner.js';
export * from './types.js';

export const initialSignalProviders: SignalProvider[] = [
  websiteChangesProvider,
  hiringProvider,
  publicAnnouncementsProvider,
];

export const registeredSignalProviders: SignalProvider[] = [
  ...initialSignalProviders,
  credentialedFundingProvider,
];

export function resolveSignalProviders(providerIds?: string[]): SignalProvider[] {
  if (!providerIds?.length) return initialSignalProviders;
  const requested = new Set(providerIds);
  return registeredSignalProviders.filter(provider => requested.has(provider.id));
}
