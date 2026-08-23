import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client.js';
import { getWinningVariant, buildPromotionData } from '../../core/execution/abTesting.js';
import type { TestVariant } from '../../core/execution/abTesting.js';
import { config as envConfig } from '../../config/env.js';

// ─── Campaign Analytics ───

export async function campaignRoutes(app: FastifyInstance) {
  /** List campaigns for dashboard navigation and overview. */
  app.get('/api/v1/campaigns', async (request, reply) => {
    try {
      const campaigns = await prisma.campaign.findMany({
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
   * Aggregate stats: sent, delivered, opened, clicked, replied, bounced, failed, pending
   */
  app.get('/api/v1/campaigns/:id/analytics', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id },
        select: { name: true },
      });

      // Count by message status
      const statusGroups = await prisma.outreachMessage.groupBy({
        by: ['status'],
        where: { campaignId: id },
        _count: { id: true },
      });

      const counts: Record<string, number> = {};
      for (const g of statusGroups) {
        counts[g.status] = g._count.id;
      }

      // Funnel stages are cumulative: later engagement stages remain included
      // in the earlier stages even though the message status is updated in place.
      const [sentCount, deliveredCount, openedCount, clickedCount, repliedCount] = await Promise.all([
        prisma.outreachMessage.count({
          where: {
            campaignId: id,
            OR: [
              { sentAt: { not: null } },
              { status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'REPLIED', 'BOUNCED'] } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            campaignId: id,
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
            campaignId: id,
            OR: [
              { status: { in: ['OPENED', 'CLICKED', 'REPLIED'] } },
              { openedAt: { not: null } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            campaignId: id,
            OR: [
              { status: { in: ['CLICKED', 'REPLIED'] } },
              { clickedAt: { not: null } },
            ],
          },
        }),
        prisma.outreachMessage.count({
          where: {
            campaignId: id,
            OR: [{ status: 'REPLIED' }, { repliedAt: { not: null } }],
          },
        }),
      ]);

      // Count by channel
      const channelGroups = await prisma.outreachMessage.groupBy({
        by: ['channel'],
        where: { campaignId: id },
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

  /** Recent messages for the campaign detail table. */
  app.get('/api/v1/campaigns/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 25);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 25;

    try {
      const messages = await prisma.outreachMessage.findMany({
        where: { campaignId: id },
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
          lead: { select: { fullName: true, email: true } },
        },
      });

      return reply.status(200).send(messages.map(message => ({
        id: message.id,
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
   * List active A/B test groups with stats
   */
  app.get('/api/v1/campaigns/:id/ab-tests', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      // Find all steps that belong to this campaign and have a variantGroup set
      const steps = await prisma.sequenceStep.findMany({
        where: {
          campaignId: id,
          variantGroup: { not: null },
        },
        orderBy: [{ variantGroup: 'asc' }, { stepOrder: 'asc' }],
      });

      // Group by variant group
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
        }>;
        totalImpressions: number;
        hasWinner: boolean;
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

        result.push({
          variantGroup: groupName,
          variants: groupSteps.map(s => ({
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
          })),
          totalImpressions,
          hasWinner: winner !== null,
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
}