import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildLeadDelivery } from '../../core/delivery/service.js';

const LeadDeliveryInputSchema = z.object({
  icp_id: z.string().uuid(),
  limit: z.number().int().positive().max(50).default(10).describe('Leads aprovados a entregar (o ranking busca 3x e o gate descarta os duvidosos).'),
  min_score: z.number().min(0).max(100).default(50),
  status_filter: z.enum(['DISCOVERED', 'ENRICHED', 'READY']).default('READY'),
  observe_sites: z.boolean().default(true).describe('Visita o site da empresa para conferir contatos e observar o negócio.'),
});

export function registerDeliveryTool(server: McpServer) {
  server.tool(
    'gtm_build_lead_delivery',
    'Entrega final de leads: só passa quem tem contato com dupla confirmação (verificação agora + site/ficha/identidade) e fatos verificáveis. Cada lead vem com dossiê do negócio, fatos com fonte e sugestões de abordagem; os reprovados voltam em rejected com o motivo.',
    LeadDeliveryInputSchema.shape,
    async args => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await buildLeadDelivery(args), null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: `Erro ao montar entrega: ${error.message}` }] };
      }
    },
  );
}
