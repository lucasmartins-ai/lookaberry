import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAnalyzeIcpTool } from './tools/analyzeIcp.js';
import { registerIntentTools } from './tools/intent.js';
import { registerEnrichmentTool } from './tools/enrichment.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'lookaberry-mcp',
    version: '0.1.0',
  });

  registerAnalyzeIcpTool(server);
  registerIntentTools(server);
  registerEnrichmentTool(server);

  return server;
}
