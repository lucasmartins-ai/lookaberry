import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { icpService } from '../../core/icp/service.js';

export function registerAnalyzeIcpTool(server: McpServer) {
  server.tool(
    'gtm_analyze_icp',
    'Extrai a proposta de valor de uma empresa a partir do seu website e gera o perfil do ICP com personas, dores e embeddings vetoriais (1536 dimensões).',
    {
      website_url: z.string().describe('URL principal da empresa/produto'),
      description: z.string().optional().describe('Resumo opcional da tese de produto ou contexto adicional'),
      target_geos: z.array(z.string()).optional().describe("Regiões geográficas alvo (ex: ['BR', 'US', 'LATAM'])"),
    },
    async (args) => {
      try {
        const result = await icpService.analyzeIcp({
          website_url: args.website_url,
          description: args.description,
          target_geos: args.target_geos,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Erro ao analisar ICP para ${args.website_url}: ${error.message}`,
            },
          ],
        };
      }
    }
  );
}
