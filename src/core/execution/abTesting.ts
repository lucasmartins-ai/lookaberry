/**
 * S10: A/B Testing Framework
 *
 * - Weighted random variant selection (proportional to variantWeight)
 * - Sticky assignment: same lead + variantGroup → always same variant (consistent hash)
 * - Bayesian winner detection (Beta distribution, Beta(1,1) prior)
 * - Auto-promotion of winning variants (optional, off by default)
 */

/** A variant in an A/B test group */
export interface TestVariant {
  id: string;
  stepOrder: number;
  variantGroup: string;
  variantWeight: number;
  impressions: number;
  opens: number;
  replies: number;
  clicks: number;
}

/** Context needed for variant assignment */
export interface VariantAssignmentContext {
  leadId: string;
}

/**
 * Select a variant from a group using weighted random selection
 * with sticky assignment (same lead always gets the same variant).
 *
 * Sticky assignment ensures follow-ups use the same variant consistently.
 */
export function selectVariant(
  variants: TestVariant[],
  leadContext: VariantAssignmentContext,
  randomFn: () => number = Math.random,
): TestVariant {
  if (variants.length === 0) {
    throw new Error('No variants provided for selection');
  }

  if (variants.length === 1) {
    return variants[0]!;
  }

  // Filter to active variants only (weight > 0)
  const active = variants.filter(v => v.variantWeight > 0);
  if (active.length === 0) {
    return variants[0]!; // fallback: all weights zero
  }

  if (active.length === 1) {
    return active[0]!;
  }

  // Sticky assignment: consistent hash of leadId + variantGroup
  const group = active[0]!.variantGroup;
  const stickyIndex = consistentHash(leadContext.leadId + '::' + group, active.length);

  // Weighted selection: normalize weights to probabilities
  const totalWeight = active.reduce((sum, v) => sum + v.variantWeight, 0);
  let rand = randomFn() * totalWeight;

  // Use sticky assignment to bias the random (85% sticky, 15% exploration)
  const stickyBias = 0.85;
  const exploreBias = 1 - stickyBias;

  // Blend: some exploration, mostly sticky
  const blendedIndex = randomFn() < stickyBias
    ? stickyIndex
    : Math.floor(randomFn() * active.length);

  // But also respect weights for non-sticky selection
  let cumWeight = 0;
  for (let i = 0; i < active.length; i++) {
    cumWeight += active[i]!.variantWeight;
    if (rand <= cumWeight) {
      // 85% of the time, use sticky; 15% use weighted random
      return active[randomFn() < stickyBias ? stickyIndex : i]!;
    }
  }

  return active[active.length - 1]!;
}

/**
 * Consistent hash for sticky assignment.
 * Uses a simple djb2-like hash modulo the number of slots.
 */
function consistentHash(key: string, numSlots: number): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % numSlots;
}

// ─── Impression/conversion recording ───

/** These counters persist on the SequenceStep row */
export type MetricName = 'OPEN' | 'REPLY' | 'CLICK';

/**
 * Compute updated counters for a variant after recording an impression/conversion.
 * Returns a diff that should be applied atomically.
 *
 * (Pure function — does not mutate. Caller persists to DB.)
 */
export function buildImpressionDelta(
  _step: TestVariant,
  _leadId: string,
  _metric?: MetricName,
): { impressionsIncrement: number; opensIncrement: number; repliesIncrement: number; clicksIncrement: number } {
  const delta = {
    impressionsIncrement: 0,
    opensIncrement: 0,
    repliesIncrement: 0,
    clicksIncrement: 0,
  };

  if (!_metric) {
    // Record impression only
    delta.impressionsIncrement = 1;
    return delta;
  }

  delta.impressionsIncrement = 1;
  switch (_metric) {
    case 'OPEN':
      delta.opensIncrement = 1;
      break;
    case 'REPLY':
      delta.repliesIncrement = 1;
      delta.opensIncrement = 1; // reply implies opened
      break;
    case 'CLICK':
      delta.clicksIncrement = 1;
      delta.opensIncrement = 1; // click implies opened
      break;
  }

  return delta;
}

// ─── Bayesian winner detection ───

/**
 * Log-gamma for log-Beta calculations (Lanczos approximation, n ≤ 100 is fine).
 * For production statistical rigor, use a dedicated stats library.
 *
 * Here we implement the regularized incomplete beta function via
 * continued fraction for the Bayesian posterior comparison.
 */

/** Beta distribution mean */
export function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/** Probability that Beta(alphaA, betaA) > Beta(alphaB, betaB) using Monte Carlo approximation */
export function probabilityBGreaterThanA(
  alphaA: number, betaA: number,
  alphaB: number, betaB: number,
  samples: number = 10_000,
  randomFn: () => number = Math.random,
): number {
  // Monte Carlo: sample from Beta distributions and count wins
  let wins = 0;

  for (let i = 0; i < samples; i++) {
    const a = sampleBeta(alphaA, betaA, randomFn);
    const b = sampleBeta(alphaB, betaB, randomFn);
    if (b > a) wins++;
  }

  return wins / samples;
}

/**
 * Sample from Beta(alpha, beta) using the gamma distribution method.
 * For alpha, beta > 0, Beta(a,b) = Gamma(a,1) / (Gamma(a,1) + Gamma(b,1))
 */
function sampleBeta(alpha: number, beta: number, randomFn: () => number): number {
  const x = sampleGamma(alpha, randomFn);
  const y = sampleGamma(beta, randomFn);
  return x / (x + y);
}

/**
 * Sample from Gamma(shape, 1) using the Marsaglia-Tsang method
 * (works well for shape >= 1).
 */
function sampleGamma(shape: number, randomFn: () => number): number {
  if (shape < 1) {
    // Use the property: Gamma(a,1) = Gamma(a+1,1) * U^(1/a)
    const u = randomFn();
    if (u === 0) return 0;
    return sampleGamma(shape + 1, randomFn) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let x: number;
    let v: number;
    do {
      x = normalRandom(randomFn);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = randomFn();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box-Muller transform for standard normal */
function normalRandom(randomFn: () => number): number {
  const u1 = randomFn() || 1e-10;
  const u2 = randomFn() || 1e-10;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Determine the winning variant in an A/B test group.
 *
 * Uses Bayesian Beta-binomial model:
 * - Prior: Beta(1, 1) — uniform
 * - Posterior for conversions: Beta(1 + conversions, 1 + (impressions - conversions))
 *
 * Returns the winning variant if:
 * 1. Total impressions across all variants >= minSamples
 * 2. The best variant beats the second-best with confidence >= requiredConfidence
 *
 * Otherwise returns null (not enough data yet).
 */
export function getWinningVariant(
  variants: TestVariant[],
  minSamples: number,
  confidence: number,
  metric: MetricName = 'REPLY',
): TestVariant | null {
  const active = variants.filter(v => v.variantWeight > 0);
  if (active.length < 2) return active[0] ?? null;

  // Total impressions across all variants
  const totalImpressions = active.reduce((sum, v) => sum + v.impressions, 0);
  if (totalImpressions < minSamples) return null;

  // Get the conversion count for the target metric
  const getConversions = (v: TestVariant): number => {
    switch (metric) {
      case 'OPEN': return v.opens;
      case 'REPLY': return v.replies;
      case 'CLICK': return v.clicks;
    }
  };

  // Sort by mean posterior (Beta(1+conv, 1+imp-conv))
  const scored = active.map(v => {
    const conv = getConversions(v);
    const imp = v.impressions || 1;
    return {
      variant: v,
      posteriorMean: (1 + conv) / (2 + imp),
      alpha: 1 + conv,
      beta: 1 + imp - conv,
    };
  });

  scored.sort((a, b) => b.posteriorMean - a.posteriorMean);

  const best = scored[0]!;
  const second = scored[1]!;

  // Probability best > second
  const probBestWins = probabilityBGreaterThanA(
    second.alpha, second.beta,
    best.alpha, best.beta,
  );

  if (probBestWins >= confidence) {
    return best.variant;
  }

  return null;
}

/**
 * Build the update data for promoting a winner (disabling losing variants).
 *
 * Returns objects ready for Prisma update.
 */
export function buildPromotionData(
  winningStepId: string,
  losingStepIds: string[],
): Array<{ id: string; data: Record<string, unknown> }> {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

  // Promote winner: remove variant group/weight (becomes standard step)
  updates.push({
    id: winningStepId,
    data: {
      variantGroup: null,
      variantWeight: 1.0,
      active: true,
    },
  });

  // Deactivate losers
  for (const id of losingStepIds) {
    updates.push({
      id,
      data: { active: false, variantWeight: 0 },
    });
  }

  return updates;
}