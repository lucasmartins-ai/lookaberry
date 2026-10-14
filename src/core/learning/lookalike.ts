/**
 * Lookalike ICP: the mean embedding of companies whose leads converted for an ICP
 * (positive reply, meeting or payment). ICP fit then also measures "how close is this
 * company to the ones that actually bought", not only "how close to the website analysis".
 *
 * Only vectors from the ICP's own semantic model are averaged (never hash fallbacks), and a
 * centroid needs MIN_POSITIVES companies so one lucky deal doesn't redefine the ICP.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { HASH_EMBEDDING_MODEL } from '../icp/embeddings.js';

export const MIN_POSITIVES = 3;

/** Recompute positive_centroid for every ICP. Returns the number of ICPs with a centroid. */
export async function refreshPositiveCentroids(db: typeof prisma = prisma): Promise<number> {
  const updated = await db.$executeRaw(Prisma.sql`
    WITH positive_leads AS (
      SELECT camp.icp_id, f.lead_id
        FROM lead_interaction_feedback f
        JOIN campaigns camp ON camp.id = f.campaign_id
       WHERE f.interaction_type = 'REPLY' AND f.sentiment = 'POSITIVE'
      UNION
      SELECT camp.icp_id, e.lead_id
        FROM outreach_events e
        JOIN outreach_messages m ON m.lead_id = e.lead_id
        JOIN campaigns camp ON camp.id = m.campaign_id
       WHERE e.lead_id IS NOT NULL
         AND (e.event_type IN ('MEETING', 'PAID') OR e.intent IN ('INTERESTED', 'MEETING'))
    ),
    centroids AS (
      SELECT p.id AS icp_id, AVG(c.embedding) AS centroid, COUNT(DISTINCT c.id)::int AS n
        FROM positive_leads pl
        JOIN icp_profiles p ON p.id = pl.icp_id
        JOIN leads l ON l.id = pl.lead_id
        JOIN companies c ON c.id = l.company_id
       WHERE c.embedding IS NOT NULL
         AND c.embedding_model = p.embedding_model
         AND p.embedding_model <> ${HASH_EMBEDDING_MODEL}
       GROUP BY p.id
    )
    UPDATE icp_profiles p
       SET positive_centroid = CASE WHEN ct.n >= ${MIN_POSITIVES} THEN ct.centroid ELSE NULL END,
           positive_count = COALESCE(ct.n, 0),
           centroid_updated_at = NOW()
      FROM icp_profiles p2
      LEFT JOIN centroids ct ON ct.icp_id = p2.id
     WHERE p.id = p2.id
  `);
  const [{ n }] = await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`SELECT COUNT(*)::int AS n FROM icp_profiles WHERE positive_centroid IS NOT NULL`);
  void updated;
  return n;
}

export interface Lookalike {
  companyId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  similarity: number;
  basis: 'positives' | 'icp';
}

/**
 * Companies closest to what converted (or to the ICP itself while there are too few
 * positives), skipping companies whose leads already replied, unsubscribed or bounced.
 */
export async function findLookalikes(icpId: string, limit = 20, db: typeof prisma = prisma): Promise<Lookalike[]> {
  return db.$queryRaw<Lookalike[]>(Prisma.sql`
    SELECT c.id AS "companyId", c.name, c.domain, c.industry,
           ROUND((1 - (c.embedding <=> COALESCE(p.positive_centroid, p.embedding)))::numeric, 4)::float AS similarity,
           CASE WHEN p.positive_centroid IS NOT NULL THEN 'positives' ELSE 'icp' END AS basis
      FROM icp_profiles p
      JOIN companies c ON c.embedding IS NOT NULL AND c.embedding_model = p.embedding_model
     WHERE p.id = ${icpId}::uuid
       AND p.embedding IS NOT NULL
       AND p.embedding_model <> ${HASH_EMBEDDING_MODEL}
       AND NOT EXISTS (
         SELECT 1 FROM leads l
          WHERE l.company_id = c.id
            AND l.status IN ('REPLIED_POSITIVE', 'REPLIED_NEGATIVE', 'UNSUBSCRIBED', 'BOUNCED')
       )
     ORDER BY c.embedding <=> COALESCE(p.positive_centroid, p.embedding)
     LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `);
}
