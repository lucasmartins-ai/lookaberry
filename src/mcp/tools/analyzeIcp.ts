import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { icpService } from '../../core/icp/service.js';

export function registerAnalyzeIcpTool(server: McpServer) {
  server.tool(
    'gtm_analyze_icp',
    'Perfil de ICP (personas, dores, propostas de valor, embedding) a partir do website. Sem LLM no servidor (padrão), devolve o conteúdo reduzido + formato: você analisa e chama de novo com analysis para salvar.',
    {
      website_url: z.string().describe('URL principal da empresa/produto'),
      description: z.string().optional().describe('Resumo opcional da tese de produto ou contexto adicional'),
      target_geos: z.array(z.string()).optional().describe("Regiões geográficas alvo (ex: ['BR', 'US', 'LATAM'])"),
      analysis: z.record(z.unknown()).optional().describe('ICP que VOCÊ analisou a partir do brief (JSON no formato do campo system). Na primeira chamada, omita.'),
    },
    async (args) => {
      try {
        const result = await icpService.analyzeIcp({
          website_url: args.website_url,
          description: args.description,
          target_geos: args.target_geos,
          analysis: args.analysis as any,
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
