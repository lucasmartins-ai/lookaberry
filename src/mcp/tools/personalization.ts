import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GenerateHyperPersonalizedMessageInputSchema } from '../schemas/personalization.js';
import { hyperPersonalizationService } from '../../core/personalization/service.js';

export function registerPersonalizationTool(server: McpServer) {
  server.tool('gtm_generate_hyper_personalized_message', 'Gera uma mensagem B2B baseada apenas no lead e no sinal ativo, com guardrails anti-spam.', GenerateHyperPersonalizedMessageInputSchema.shape, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await hyperPersonalizationService.generateMessage(args), null, 2) }] }; }
    catch (error: any) { return { isError: true, content: [{ type: 'text', text: `Erro ao gerar mensagem: ${error.message}` }] }; }
  });
}
