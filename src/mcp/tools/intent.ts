import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DetectIntentSignalsInputSchema, ScoreAndRankLeadsInputSchema } from '../schemas/intent.js';
import { intentService } from '../../core/intent/service.js';

export function registerIntentTools(server: McpServer) {
  server.tool('gtm_detect_intent_signals', 'Ingere e retorna sinais recentes de intenção de compra associados a empresas do ICP.', DetectIntentSignalsInputSchema.shape, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await intentService.detectSignals(args), null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Erro ao detectar sinais: ${error.message}` }] };
    }
  });

  server.tool('gtm_score_and_rank_leads', 'Executa o ranqueamento híbrido de leads usando similaridade vetorial e sinais de intenção, sem tokens LLM.', ScoreAndRankLeadsInputSchema.shape, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await intentService.scoreAndRankLeads(args), null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Erro ao ranquear leads: ${error.message}` }] };
    }
  });
}
