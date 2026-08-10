import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue.js';
import { icpService, AnalyzeIcpParams } from '../../icp/service.js';

export function createIcpWorker() {
  const worker = new Worker(
    'icp_analysis_queue',
    async (job: Job<AnalyzeIcpParams>) => {
      console.log(`[ICP Worker] Processing job ${job.id} for ${job.data.website_url}`);
      const result = await icpService.analyzeIcp(job.data);
      console.log(`[ICP Worker] Completed job ${job.id} -> ICP ID: ${result.icp_id}`);
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[ICP Worker] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
