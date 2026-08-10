import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAnalyzeIcpTool } from './tools/analyzeIcp.js';
import { registerIntentTools } from './tools/intent.js';
import { registerEnrichmentTool } from './tools/enrichment.js';
import { registerPersonalizationTool } from './tools/personalization.js';
import { registerOutreachTool } from './tools/outreach.js';
import { registerAnalyticsTools } from './tools/analytics.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'lookaberry-mcp',
    version: '0.1.0',
  });

  registerAnalyzeIcpTool(server);
  registerIntentTools(server);
  registerEnrichmentTool(server);
  registerPersonalizationTool(server);
  registerOutreachTool(server);
  registerAnalyticsTools(server);

  return server;
}
