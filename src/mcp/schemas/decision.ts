import { z } from 'zod';

export const EvaluateOpportunityInputSchema = z.object({
  icp_id: z.string().uuid().describe('ID do perfil de ICP'),
  lead_id: z.string().uuid().optional().describe('Avaliar um lead específico (opcional; se omitido, avalia todos os leads ativos)'),
  company_id: z.string().uuid().optional().describe('Avaliar uma empresa específica (opcional; alternativo a lead_id)'),
  min_weight: z.number().min(0).max(100).default(50).describe('Peso mínimo do sinal para consideração'),
});

export type EvaluateOpportunityInput = z.infer<typeof EvaluateOpportunityInputSchema>;