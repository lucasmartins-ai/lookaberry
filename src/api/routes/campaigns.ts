import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { getWinningVariant, buildPromotionData, probabilityBGreaterThanA, betaMean } from '../../core/execution/abTesting.js';
import type { TestVariant } from '../../core/execution/abTesting.js';
import { config as envConfig } from '../../config/env.js';
import type { ChannelType, MessageStatus } from '@prisma/client';

// ─── Campaign Analytics ───

/** Valid campaign status transitions */
const STATUS_TRANSITIONS: Record<string, string[]> = {
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  DRAFT: ['ACTIVE'],
};

/** S13: Build Prisma where clause from dashboard filter query params */
function buildMessageWhere(
  campaignId: string,
  query: Record<string, string | undefined>,
): Prisma.OutreachMessageWhereInput {
  const where: Prisma.OutreachMessageWhereInput = { campaignId };

  if (query.channel) {
    where.channel = { in: query.channel.split(',').map((c) => c.trim().toUpperCase() as ChannelType) };
  }
  if (query.status) {
    where.status = { in: query.status.split(',').map((s) => s.trim().toUpperCase() as MessageStatus) };
  }
  if (query.period_start || query.period_end) {
    where.sentAt = {};
    if (query.period_start) where.sentAt.gte = new Date(query.period_start);
    if (query.period_end) where.sentAt.lte = new Date(query.period_end);
  }

  return where;
}

export async function campaignRoutes(app: FastifyInstance) {
  /** List campaigns for dashboard navigation and overview. Supports status filter. */
  app.get('/api/v1/campaigns', async (request, reply) => {
    const query = request.query as { status?: string };
    try {
      const where: Prisma.CampaignWhereInput = {};
      if (query.status) {
        where.isActive = query.status === 'active' ? true : query.status === 'paused' ? false : undefined;
      }
      const campaigns = await prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, isActive: true, createdAt: true },
      });

      return reply.status(200).send(campaigns.map(campaign => ({
        id: campaign.id,
        name: campaign.name,
        is_active: campaign.isActive,
        created_at: campaign.createdAt,
      })));
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to fetch campaigns' });
    }
  });

  /**
   * GET /api/v1/campaigns/:id/analytics
   * Aggregate stats with optional filters: channel, status, period_start, period_end
   */
  app.get('/api/v1/campaigns/:id/analytics', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const filterWhere = buildMessageWhere(id, query);

    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id },
        select: { name: true },
      });

      // Count by message status
      const statusGroups = await prisma.outreachMessage.groupBy({
        by: ['status'],
        where: filterWhere,
        _count: { id: true },
      });

      const counts: Record<string, number> = {};
      for (const g of statusGroups) {
        counts[g.status] = g._count.id;
      }

      const [sentCount, deliveredCount, openedCount, clickedCount, repliedCount] = await Promise.all([
        prisma.outreachMessage.count({
          where: {
            ...filterWhere,
            OR: [
              { sentAt: { not: null } },
              { status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'] } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            ...filterWhere,
            OR: [
              { status: { in: ['DELIVERED', 'OPENED', 'CLICKED', 'REPLIED'] } },
              { openedAt: { not: null } },
              { clickedAt: { not: null } },
              { repliedAt: { not: null } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            ...filterWhere,
            OR: [
              { status: { in: ['OPENED', 'CLICKED', 'REPLIED'] } },
              { openedAt: { not: null } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            ...filterWhere,
            OR: [
              { status: { in: ['CLICKED', 'REPLIED'] } },
              { clickedAt: { not: null } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            ...filterWhere,
            OR: [{ status: 'REPLIED' }, { repliedAt: { not: null } }],
          },
        }),
      ]);

      // Count by channel
      const channelGroups = await prisma.outreachMessage.groupBy({
        by: ['channel'],
        where: filterWhere,
        _count: { id: true },
      });

      const byChannel: Record<string, number> = {};
      for (const g of channelGroups) {
        byChannel[g.channel] = g._count.id;
      }

      return reply.status(200).send({
        campaign_id: id,
        campaign_name: campaign?.name ?? null,
        sent: sentCount,
        delivered: deliveredCount,
        opened: openedCount,
        clicked: clickedCount,
        replied: repliedCount,
        bounced: counts.BOUNCED ?? 0,
        failed: counts.FAILED ?? 0,
        pending: (counts.QUEUED ?? 0) + (counts.SCHEDULED ?? 0),
        by_channel: byChannel,
      });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to fetch analytics' });
    }
  });

  /** Recent messages for the campaign detail table. Supports channel, status, period filters. */
  app.get('/api/v1/campaigns/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const rawLimit = Number(query.limit ?? 25);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 25;
    const filterWhere = buildMessageWhere(id, query);

    try {
      const messages = await prisma.outreachMessage.findMany({
        where: filterWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          channel: true,
          status: true,
          subject: true,
          body: true,
          sentAt: true,
          openedAt: true,
          clickedAt: true,
          repliedAt: true,
          createdAt: true,
          lead: { select: { id: true, fullName: true, email: true } },
        },
      });

      return reply.status(200).send(messages.map(message => ({
        id: message.id,
        lead_id: message.lead.id,
        lead_name: message.lead.fullName,
        lead_email: message.lead.email,
        channel: message.channel,
        status: message.status,
        subject: message.subject,
        body_preview: message.body.slice(0, 180),
        sent_at: message.sentAt,
        opened_at: message.openedAt,
        clicked_at: message.clickedAt,
        replied_at: message.repliedAt,
        created_at: message.createdAt,
      })));
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to fetch campaign messages' });
    }
  });

  /**
   * GET /api/v1/campaigns/:id/ab-tests
   * List active A/B test groups with enhanced S13 stats:
   * statistical significance, sample size, confidence intervals, posterior means
   */
  app.get('/api/v1/campaigns/:id/ab-tests', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const steps = await prisma.sequenceStep.findMany({
        where: {
          campaignId: id,
          variantGroup: { not: null },
        },
        orderBy: [{ variantGroup: 'asc' }, { stepOrder: 'asc' }],
      });

      const groups = new Map<string, typeof steps>();
      for (const step of steps) {
        const group = step.variantGroup!;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group)!.push(step);
      }

      const result: Array<{
        variantGroup: string;
        variants: Array<{
          stepId: string;
          stepIndex: number;
          body: string;
          impressions: number;
          opens: number;
          replies: number;
          clicks: number;
          variantWeight: number;
          active: boolean;
          isWinner?: boolean;
          conversionRate: number;
          posteriorMean: number;
          confidenceInterval95: [number, number];
        }>;
        totalImpressions: number;
        hasWinner: boolean;
        minSamplesRequired: number;
        requiredConfidence: number;
        bestVariantProbability: number | null;
      }> = [];

      for (const [groupName, groupSteps] of groups) {
        const variants: TestVariant[] = groupSteps.map(s => ({
          id: s.id,
          stepOrder: s.stepOrder,
          variantGroup: s.variantGroup ?? '',
          variantWeight: s.variantWeight ?? 1.0,
          impressions: s.impressions ?? 0,
          opens: s.opens ?? 0,
          replies: s.replies ?? 0,
          clicks: s.clicks ?? 0,
        }));

        const totalImpressions = variants.reduce((sum, v) => sum + v.impressions, 0);

        const winner = getWinningVariant(
          variants,
          envConfig.AB_TEST_MIN_SAMPLES,
          envConfig.AB_TEST_CONFIDENCE,
        );

        // S13: Compute full Bayesian stats for each variant
        const active = variants.filter(v => v.variantWeight > 0);
        const scored = active.map(v => {
          const conv = v.replies;
          const imp = v.impressions || 1;
          const alpha = 1 + conv;
          const beta = 1 + imp - conv;
          const mean = betaMean(alpha, beta);
          // 95% credible interval via normal approximation of Beta
          const se = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
          const ciLower = Math.max(0, mean - 1.96 * se);
          const ciUpper = Math.min(1, mean + 1.96 * se);
          return { variant: v, alpha, beta, mean, ciLower, ciUpper };
        });
        scored.sort((a, b) => b.mean - a.mean);

        // Probability best beats second-best
        let bestVariantProbability: number | null = null;
        if (scored.length >= 2) {
          bestVariantProbability = probabilityBGreaterThanA(
            scored[1]!.alpha, scored[1]!.beta,
            scored[0]!.alpha, scored[0]!.beta,
          );
        }

        result.push({
          variantGroup: groupName,
          variants: groupSteps.map(s => {
            const score = scored.find(sc => sc.variant.id === s.id);
            const conv = s.replies ?? 0;
            const imp = s.impressions || 1;
            return {
              stepId: s.id,
              stepIndex: s.stepOrder,
              body: s.promptTemplate.slice(0, 200),
              impressions: s.impressions ?? 0,
              opens: s.opens ?? 0,
              replies: s.replies ?? 0,
              clicks: s.clicks ?? 0,
              variantWeight: s.variantWeight ?? 1.0,
              active: s.active,
              isWinner: winner ? s.id === winner.id : undefined,
              conversionRate: imp > 0 ? (conv / imp) * 100 : 0,
              posteriorMean: score?.mean ?? 0,
              confidenceInterval95: [score?.ciLower ?? 0, score?.ciUpper ?? 0] as [number, number],
            };
          }),
          totalImpressions,
          hasWinner: winner !== null,
          minSamplesRequired: envConfig.AB_TEST_MIN_SAMPLES,
          requiredConfidence: envConfig.AB_TEST_CONFIDENCE,
          bestVariantProbability,
        });
      }

      return reply.status(200).send(result);
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to fetch A/B tests' });
    }
  });

  /**
   * POST /api/v1/campaigns/:id/ab-tests/:groupId/promote
   * Manually promote a winning variant (or auto-detect the winner)
   */
  app.post('/api/v1/campaigns/:id/ab-tests/:groupId/promote', async (request, reply) => {
    const { id, groupId } = request.params as { id: string; groupId: string };
    const body = request.body as { winnerStepId?: string } | undefined;

    try {
      const steps = await prisma.sequenceStep.findMany({
        where: {
          campaignId: id,
          variantGroup: groupId,
          active: true,
        },
        orderBy: { stepOrder: 'asc' },
      });

      if (steps.length === 0) {
        return reply.status(404).send({ error: 'A/B test group not found' });
      }

      const variants: TestVariant[] = steps.map(s => ({
        id: s.id,
        stepOrder: s.stepOrder,
        variantGroup: s.variantGroup ?? '',
        variantWeight: s.variantWeight ?? 1.0,
        impressions: s.impressions ?? 0,
        opens: s.opens ?? 0,
        replies: s.replies ?? 0,
        clicks: s.clicks ?? 0,
      }));

      let winner: TestVariant | null = null;

      if (body?.winnerStepId) {
        // Manual promotion
        winner = variants.find(v => v.id === body.winnerStepId) ?? null;
        if (!winner) {
          return reply.status(400).send({ error: 'winnerStepId not found in this A/B test group' });
        }
      } else {
        // Auto-detect winner
        winner = getWinningVariant(
          variants,
          envConfig.AB_TEST_MIN_SAMPLES,
          envConfig.AB_TEST_CONFIDENCE,
        );
        if (!winner) {
          return reply.status(400).send({
            error: 'No statistically significant winner yet. Increase sample size or promote manually.',
            totalImpressions: variants.reduce((s, v) => s + v.impressions, 0),
            minRequired: envConfig.AB_TEST_MIN_SAMPLES,
          });
        }
      }

      // Promote winner: deactivate losers
      const losingIds = steps.filter(s => s.id !== winner!.id).map(s => s.id);
      const updates = buildPromotionData(winner.id, losingIds);

      await prisma.$transaction(
        updates.map(({ id: stepId, data }) =>
          prisma.sequenceStep.update({ where: { id: stepId }, data }),
        ),
      );

      app.log.info(`[Campaigns] A/B test "${groupId}" promoted: winner step=${winner.id}, losers deactivated: ${losingIds.length}`);
      return reply.status(200).send({ promoted: true, winnerStepId: winner.id });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to promote A/B test variant' });
    }
  });

  /**
   * GET /api/v1/sequences/:id/versions
   * History of sequence versions
   */
  app.get('/api/v1/sequences/:id/versions', async (request, reply) => {
    const { id: sequenceId } = request.params as { id: string };

    try {
      const versions = await prisma.outreachSequenceVersion.findMany({
        where: { sequenceId },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          createdBy: true,
          changeDescription: true,
          createdAt: true,
        },
      });

      // Also get current version
      const sequence = await prisma.outreachSequence.findUnique({
        where: { id: sequenceId },
        select: { currentVersionId: true },
      });

      return reply.status(200).send({
        sequence_id: sequenceId,
        current_version_id: sequence?.currentVersionId ?? null,
        versions,
      });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to fetch versions' });
    }
  });

  /**
   * POST /api/v1/sequences/:id/rollback
   * Rollback to a previous version
   */
  app.post('/api/v1/sequences/:id/rollback', async (request, reply) => {
    const { id: sequenceId } = request.params as { id: string };
    const body = request.body as { versionId: string } | undefined;

    if (!body?.versionId) {
      return reply.status(400).send({ error: 'versionId is required' });
    }

    try {
      // Verify the version exists and belongs to this sequence
      const version = await prisma.outreachSequenceVersion.findFirst({
        where: { id: body.versionId, sequenceId },
      });

      if (!version) {
        return reply.status(404).send({ error: 'Version not found for this sequence' });
      }

      await prisma.outreachSequence.update({
        where: { id: sequenceId },
        data: { currentVersionId: body.versionId },
      });

      app.log.info(`[Campaigns] Sequence ${sequenceId} rolled back to version ${version.version}`);
      return reply.status(200).send({
        rolled_back: true,
        sequence_id: sequenceId,
        version: version.version,
      });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to rollback' });
    }
  });

  /**
   * PATCH /api/v1/campaigns/:id/status
   * S13: Safe operational actions — pause, resume, or terminate a campaign.
   * Valid transitions: ACTIVE→PAUSED/COMPLETED, PAUSED→ACTIVE/COMPLETED, DRAFT→ACTIVE.
   * Terminate (COMPLETED) is irreversible and deactivates the campaign.
   */
  app.patch('/api/v1/campaigns/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action?: string } | undefined;
    const action = body?.action;

    if (!action || !['pause', 'resume', 'terminate'].includes(action)) {
      return reply.status(400).send({ error: 'action must be one of: pause, resume, terminate' });
    }

    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id },
        select: { isActive: true },
      });

      if (!campaign) {
        return reply.status(404).send({ error: 'Campaign not found' });
      }

      const currentState = campaign.isActive ? 'ACTIVE' : 'PAUSED';
      let target: boolean;
      if (action === 'pause') target = false;
      else if (action === 'resume') target = true;
      else target = false; // terminate → always inactive

      if (action === 'terminate') {
        const allowed = STATUS_TRANSITIONS[currentState] ?? [];
        if (!allowed.includes('COMPLETED')) {
          return reply.status(409).send({ error: `Cannot terminate campaign from state ${currentState}` });
        }
      } else if (currentState === 'PAUSED' && action === 'resume') {
        const allowed = STATUS_TRANSITIONS[currentState] ?? [];
        if (!allowed.includes('ACTIVE')) {
          return reply.status(409).send({ error: `Cannot resume campaign from state ${currentState}` });
        }
      } else if (currentState === 'ACTIVE' && action === 'pause') {
        const allowed = STATUS_TRANSITIONS[currentState] ?? [];
        if (!allowed.includes('PAUSED')) {
          return reply.status(409).send({ error: `Cannot pause campaign from state ${currentState}` });
        }
      }

      const updated = await prisma.campaign.update({
        where: { id },
        data: {
          isActive: target,
          ...(action === 'terminate' ? { endedAt: new Date() } : {}),
        },
      });

      app.log.info(`[Campaigns] Campaign ${id} ${action}d (${currentState} → ${target ? 'ACTIVE' : 'PAUSED'})`);
      return reply.status(200).send({
        id: updated.id,
        is_active: updated.isActive,
        action,
        terminated: action === 'terminate',
      });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: `Failed to ${action} campaign` });
    }
  });

  /**
   * GET /api/v1/campaigns/:id/leads/:leadId
   * S13: Lead drill-down — full interaction history for a lead within a campaign.
   */
  app.get('/api/v1/campaigns/:id/leads/:leadId', async (request, reply) => {
    const { id, leadId } = request.params as { id: string; leadId: string };

    try {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
          id: true,
          fullName: true,
          email: true,
          company: true,
          title: true,
          linkedinUrl: true,
        },
      });

      if (!lead) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const messages = await prisma.outreachMessage.findMany({
        where: { campaignId: id, leadId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          channel: true,
          status: true,
          subject: true,
          body: true,
          sentAt: true,
          openedAt: true,
          clickedAt: true,
          repliedAt: true,
          createdAt: true,
        },
      });

      return reply.status(200).send({
        lead: {
          id: lead.id,
          full_name: lead.fullName,
          email: lead.email,
          company: lead.company,
          title: lead.title,
          linkedin_url: lead.linkedinUrl,
        },
        interactions: messages.map(m => ({
          id: m.id,
          channel: m.channel,
          status: m.status,
          subject: m.subject,
          body: m.body,
          sent_at: m.sentAt,
          opened_at: m.openedAt,
          clicked_at: m.clickedAt,
          replied_at: m.repliedAt,
          created_at: m.createdAt,
        })),
      });
    } catch (err) {
      app.log.error(err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: 'Failed to fetch lead interactions' });
    }
  });
}