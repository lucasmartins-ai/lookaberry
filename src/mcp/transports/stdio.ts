#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server.js';
import { initVectorExtension } from '../../db/pgvector.js';

async function main() {
  try {
    // Ensure pgvector extension and indexes are ready
    await initVectorExtension().catch(err => {
      console.error('[MCP Stdio] Database initialization warning:', err.message);
    });

    const server = createMcpServer();
    const transport = new StdioServerTransport();

    await server.connect(transport);
    console.error('[LookaBerry MCP Server] Running on stdio transport');
  } catch (error) {
    console.error('[LookaBerry MCP Server] Fatal startup error:', error);
    process.exit(1);
  }
}

main();
