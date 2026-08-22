import type { NormalizedSignal, ProviderRunResult, ProviderStatus, SignalCollectionInput, SignalProvider } from './types.js';
import { isProviderError } from './common.js';

const RUNNABLE_STATUSES = new Set<ProviderStatus>(['IMPLEMENTED', 'PARTIALLY_IMPLEMENTED', 'FALLBACK']);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Provider timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(value => {
      clearTimeout(timeout);
      resolve(value);
    }, error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function errorStatus(error: unknown): { status: ProviderStatus; message: string } {
  if (isProviderError(error)) return { status: error.status, message: error.message };
  if (error instanceof Error && error.message.startsWith('Provider timed out')) {
    return { status: 'TIMEOUT', message: error.message };
  }
  return { status: 'FAILED', message: error instanceof Error ? error.message : 'Unknown provider failure' };
}

function aggregateStatus(
  statuses: ProviderStatus[],
  errors: string[],
  signals: NormalizedSignal[],
  successfulRuns: number,
  failedRuns: number,
  unavailableRuns: number,
): ProviderStatus {
  const runnable = statuses.filter(status => RUNNABLE_STATUSES.has(status));
  const failures = statuses.filter(status => status === 'FAILED' || status === 'TIMEOUT');
  const firstFailure = failures[0];

  if (successfulRuns > 0 && (failedRuns > 0 || unavailableRuns > 0)) return 'PARTIALLY_IMPLEMENTED';
  if (failedRuns > 0 && successfulRuns === 0 && unavailableRuns > 0) return 'PARTIALLY_IMPLEMENTED';
  if (failedRuns > 0 && successfulRuns === 0) return firstFailure ?? 'FAILED';
  if (successfulRuns > 0) return statuses.find(status => RUNNABLE_STATUSES.has(status)) ?? 'IMPLEMENTED';
  if (unavailableRuns > 0 && failedRuns === 0) return statuses.find(status => status === 'REQUIRES_CREDENTIALS' || status === 'NOT_AVAILABLE') ?? 'NOT_AVAILABLE';
  if (errors.length && signals.length) return 'PARTIALLY_IMPLEMENTED';
  if (runnable.length) return 'IMPLEMENTED';
  return 'NOT_AVAILABLE';
}

export async function collectAndNormalizeProvider(
  provider: SignalProvider,
  inputs: SignalCollectionInput[],
  timeoutMs = 10_000,
): Promise<ProviderRunResult> {
  const statuses: ProviderStatus[] = [];
  const errors: string[] = [];
  const signals: NormalizedSignal[] = [];
  let rawSignalCount = 0;
  let successfulRuns = 0;
  let failedRuns = 0;
  let unavailableRuns = 0;

  for (const input of inputs) {
    const availability = provider.getAvailability(input);
    statuses.push(availability.status);
    if (!RUNNABLE_STATUSES.has(availability.status)) {
      unavailableRuns += 1;
      if (availability.reason) errors.push(availability.reason);
      continue;
    }
    try {
      const rawSignals = await withTimeout(provider.collect(input), timeoutMs);
      successfulRuns += 1;
      rawSignalCount += rawSignals.length;
      for (const rawSignal of rawSignals) {
        try {
          signals.push(...provider.normalize({ ...rawSignal, cost: rawSignal.cost ?? provider.cost }));
        } catch (error) {
          failedRuns += 1;
          statuses.push('FAILED');
          errors.push(error instanceof Error ? error.message : 'Provider normalization failed');
        }
      }
    } catch (error) {
      const result = errorStatus(error);
      if (result.status === 'FAILED' || result.status === 'TIMEOUT') failedRuns += 1;
      else unavailableRuns += 1;
      statuses.push(result.status);
      errors.push(result.message);
    }
  }

  const cost = signals.reduce((total, signal) => total + signal.cost, 0);
  if (!inputs.length) statuses.push('NOT_AVAILABLE');
  return {
    providerId: provider.id,
    providerType: provider.type,
    status: aggregateStatus(statuses, errors, signals, successfulRuns, failedRuns, unavailableRuns),
    rawSignalCount,
    signals,
    cost,
    errors,
  };
}

export async function collectAndNormalizeProviders(
  providers: SignalProvider[],
  inputs: SignalCollectionInput[],
  timeoutMs = 10_000,
): Promise<ProviderRunResult[]> {
  return Promise.all(providers.map(provider => collectAndNormalizeProvider(provider, inputs, timeoutMs)));
}
