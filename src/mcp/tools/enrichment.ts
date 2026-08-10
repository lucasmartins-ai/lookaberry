import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WaterfallEnrichLeadInputSchema } from '../schemas/enrichment.js';
import { waterfallEnrichmentService } from '../../core/enrichment/service.js';

export function registerEnrichmentTool(server: McpServer) {
  server.tool('gtm_waterfall_enrich_lead', 'Enriquece um lead em cascata e valida a entregabilidade do e-mail antes do outreach.', WaterfallEnrichLeadInputSchema.shape, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await waterfallEnrichmentService.enrichLead(args), null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Erro ao enriquecer lead: ${error.message}` }] };
    }
  });
}
