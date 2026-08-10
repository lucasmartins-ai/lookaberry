import { Job, Worker } from 'bullmq';
import { redisConnection } from '../queue.js';
import { waterfallEnrichmentService } from '../../enrichment/service.js';
import type { WaterfallEnrichLeadInput } from '../../../mcp/schemas/enrichment.js';

export function createEnrichmentWorker() {
  const worker = new Worker('waterfall_enrichment_queue', (job: Job<WaterfallEnrichLeadInput>) => waterfallEnrichmentService.enrichLead(job.data), {
    connection: redisConnection,
    concurrency: 5,
    limiter: { max: 10, duration: 1000 },
  });
  worker.on('failed', (job, error) => console.error(`[Enrichment Worker] Job ${job?.id} failed: ${error.message}`));
  return worker;
}
