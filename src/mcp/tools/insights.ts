import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DIMENSIONS, getInsights } from '../../core/learning/service.js';

const InsightsInputSchema = z.object({
  by: z.enum(DIMENSIONS).default('segment').describe('Dimensão: segment, channel, variant, campaign, hour, weekday ou segment_channel.'),
  min_sent: z.number().int().min(1).optional().describe('Envios mínimos para um braço contar como dado suficiente (padrão 30).'),
});

export function registerInsightsTool(server: McpServer) {
  server.tool(
    'gtm_insights',
    'O que converte: taxa de respostas positivas por segmento, canal, variante, campanha ou horário (atribuição last-touch, 30 dias), mais a demanda inbound.',
    InsightsInputSchema.shape,
    async args => {
      try {
        const insights = await getInsights(args.by ?? 'segment', args.min_sent ?? 30);
        return { content: [{ type: 'text', text: JSON.stringify(insights, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: `Erro ao calcular insights: ${error.message}` }] };
      }
    },
  );
}
