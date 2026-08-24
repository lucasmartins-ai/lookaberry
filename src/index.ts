import { buildServer } from './api/server.js';
import { config, assertProductionSafety } from './config/env.js';
import { initVectorExtension } from './db/pgvector.js';
import { createIcpWorker } from './core/queues/workers/icpWorker.js';
import { createEnrichmentWorker } from './core/queues/workers/enrichmentWorker.js';
import { createDispatcherWorker } from './core/execution/dispatcher.js';
import { createInboxWorker } from './core/execution/inboxWorker.js';
import { SequenceScheduler } from './core/execution/scheduler.js';
import { closeQueues } from './core/queues/queue.js';
import { prisma } from './db/client.js';

async function bootstrap() {
  console.log('🚀 Initializing LookaBerry GTM Outbound Engine...');

  try {
    // S12: Fail fast if production safety requirements aren't met
    assertProductionSafety();

    // 1. Initialize PostgreSQL vector extension and HNSW indexes
    console.log('📦 Ensuring pgvector extensions & HNSW indexes...');
    await initVectorExtension();
    console.log('✅ pgvector ready');

    // 2. Start BullMQ background workers
    console.log('⚙️ Starting BullMQ workers...');
    const icpWorker = createIcpWorker();
    const enrichmentWorker = createEnrichmentWorker();
    let dispatcherWorker: ReturnType<typeof createDispatcherWorker> | null = null;
    try {
      dispatcherWorker = createDispatcherWorker({ prisma });
      console.log('✅ Dispatcher worker active');
    } catch (err) {
      console.warn('⚠️ Dispatcher worker unavailable (Redis may be offline):', err instanceof Error ? err.message : String(err));
    }

    let inboxWorker: ReturnType<typeof createInboxWorker> | null = null;
    try {
      inboxWorker = createInboxWorker({ _prisma: prisma });
      console.log('✅ Inbox worker active');
    } catch (err) {
      console.warn('⚠️ Inbox worker unavailable (Redis may be offline):', err instanceof Error ? err.message : String(err));
    }
    console.log('✅ Workers active');

    // 3. Start Sequence Scheduler (cron-like internal polling)
    console.log('⏰ Starting Sequence Scheduler...');
    const scheduler = new SequenceScheduler({ _prisma: prisma });
    scheduler.start();
    console.log('✅ Sequence Scheduler active (60s interval)');

    // 4. Build & start Fastify API and MCP SSE server
    const app = await buildServer();

    await app.listen({
      port: config.PORT,
      host: config.HOST,
    });

    console.log(`\n======================================================`);
    console.log(`🍓 LookaBerry Engine Running!`);
    console.log(`📡 REST API & Swagger UI: http://localhost:${config.PORT}/docs`);
    console.log(`🔌 MCP SSE Transport:    http://localhost:${config.PORT}/sse`);
    console.log(`💓 Health Endpoint:       http://localhost:${config.PORT}/health`);
    console.log(`======================================================\n`);

    // Graceful Shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[LookaBerry] Received ${signal}. Shutting down gracefully...`);
      try {
        scheduler.stop();
        await app.close();
        await icpWorker.close();
        await enrichmentWorker.close();
        if (dispatcherWorker) await dispatcherWorker.close();
        if (inboxWorker) await inboxWorker.close();
        await closeQueues();
        await prisma.$disconnect();
        console.log('[LookaBerry] Clean shutdown completed.');
        process.exit(0);
      } catch (err) {
        console.error('[LookaBerry] Error during shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('❌ Fatal bootstrap error:', error);
    process.exit(1);
  }
}

bootstrap();