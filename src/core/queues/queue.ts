import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../../config/env.js';

export const redisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const icpQueue = new Queue('icp_analysis_queue', { connection: redisConnection });
export const signalQueue = new Queue('signal_ingestion_queue', { connection: redisConnection });
export const enrichmentQueue = new Queue('waterfall_enrichment_queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
export const outreachQueue = new Queue('outreach_dispatcher_queue', { connection: redisConnection });

export async function closeQueues() {
  await Promise.all([
    icpQueue.close(),
    signalQueue.close(),
    enrichmentQueue.close(),
    outreachQueue.close(),
  ]);
  await redisConnection.quit();
}
