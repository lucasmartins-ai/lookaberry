import { prisma } from '../../db/client.js';
import { config } from '../../config/env.js';
import { getWinningVariant, buildPromotionData, type TestVariant } from './abTesting.js';

/**
 * Promote statistically significant A/B winners (AB_TEST_AUTO_PROMOTE).
 * Uses the same rule as the manual promote route: AB_TEST_MIN_SAMPLES impressions
 * and AB_TEST_CONFIDENCE probability that the best variant beats the runner-up on replies.
 * Returns the number of groups promoted.
 */
export async function autoPromoteAbWinners(db: typeof prisma = prisma): Promise<number> {
  const steps = await db.sequenceStep.findMany({
    where: { active: true, variantGroup: { not: null } },
    select: {
      id: true, sequenceId: true, stepOrder: true, variantGroup: true, variantWeight: true,
      impressions: true, opens: true, replies: true, clicks: true,
    },
  });

  const groups = new Map<string, typeof steps>();
  for (const step of steps) {
    const key = `${step.sequenceId}::${step.variantGroup}`;
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }

  let promoted = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const variants: TestVariant[] = group.map(s => ({
      id: s.id,
      stepOrder: s.stepOrder,
      variantGroup: s.variantGroup ?? '',
      variantWeight: s.variantWeight ?? 1,
      impressions: s.impressions ?? 0,
      opens: s.opens ?? 0,
      replies: s.replies ?? 0,
      clicks: s.clicks ?? 0,
    }));
    const winner = getWinningVariant(variants, config.AB_TEST_MIN_SAMPLES, config.AB_TEST_CONFIDENCE);
    if (!winner) continue;

    const updates = buildPromotionData(winner.id, group.filter(s => s.id !== winner.id).map(s => s.id));
    await db.$transaction(updates.map(({ id, data }) => db.sequenceStep.update({ where: { id }, data })));
    console.log(`[ABPromotion] ${key}: promoted step ${winner.id}`);
    promoted++;
  }
  return promoted;
}
