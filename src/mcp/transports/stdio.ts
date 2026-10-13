import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server.js';
import { initVectorExtension } from '../../db/pgvector.js';
import { prisma } from '../../db/client.js';

async function main() {
  try {
    // Ensure pgvector extension and indexes are ready
    await initVectorExtension().catch(err => {
      console.error('[MCP Stdio] Database initialization warning:', err.message);
    });

    const server = createMcpServer();
    const transport = new StdioServerTransport();

    const cleanup = async () => {
      console.error('[LookaBerry MCP Server] Shutting down, disconnecting database...');
      try {
        await prisma.$disconnect();
      } catch (err: any) {
        console.error('[LookaBerry MCP Server] Error disconnecting database:', err?.message);
      }
      process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.stdin.once('close', cleanup);

    await server.connect(transport);
    console.error('[LookaBerry MCP Server] Running on stdio transport');
  } catch (error) {
    console.error('[LookaBerry MCP Server] Fatal startup error:', error);
    try {
      await prisma.$disconnect();
    } catch {}
    process.exit(1);
  }
}

main();
