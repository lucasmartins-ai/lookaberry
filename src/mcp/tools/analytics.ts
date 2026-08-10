import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyticsService } from '../../core/analytics/service.js';
import { RecordLeadInteractionFeedbackInputSchema, TrackCampaignMetricsInputSchema } from '../schemas/analytics.js';

export function registerAnalyticsTools(server: McpServer) {
  server.tool('gtm_track_campaign_metrics', 'Consulta métricas agregadas de uma campanha e suas taxas de conversão.', TrackCampaignMetricsInputSchema.shape, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await analyticsService.trackMetrics(args), null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Erro ao consultar métricas: ${error.message}` }] };
    }
  });

  server.tool('gtm_record_lead_interaction_feedback', 'Registra interação, classifica respostas e pausa sequências quando há reply.', RecordLeadInteractionFeedbackInputSchema.shape, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await analyticsService.recordFeedback(args), null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Erro ao registrar feedback: ${error.message}` }] };
    }
  });
}
