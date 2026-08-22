import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EvaluateOpportunityInputSchema } from '../schemas/decision.js';
import { decisionService } from '../../core/decision/service.js';

export function registerDecisionTool(server: McpServer) {
  server.tool(
    'gtm_evaluate_opportunity',
    'Avalia oportunidades de prospecção combinando sinais ativos, evidências, fit de ICP e senioridade do lead. Retorna score, urgência, fatores, WHY_NOW e ações recomendadas de forma determinística (sem LLM).',
    EvaluateOpportunityInputSchema.shape,
    async args => {
      try {
        return {
          content: [{ type: 'text', text: JSON.stringify(await decisionService.evaluateOpportunity(args), null, 2) }],
        };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: `Erro ao avaliar oportunidade: ${error.message}` }] };
      }
    },
  );
}