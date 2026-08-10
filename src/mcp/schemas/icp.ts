import { z } from 'zod';

export const AnalyzeIcpInputSchema = z.object({
  website_url: z.string().describe('URL principal da empresa/produto (ex: https://example.com)'),
  description: z.string().optional().describe('Resumo opcional da tese de produto ou contexto adicional'),
  target_geos: z.array(z.string()).optional().describe("Regiões geográficas alvo (ex: ['BR', 'US', 'LATAM'])"),
});

export const TargetPersonaSchema = z.object({
  title: z.string().describe('Cargo da persona (ex: Head of Sales)'),
  seniority: z.string().describe('Nível de senioridade (ex: C-Level, VP, Director)'),
  core_pain: z.string().describe('Dor central aguda resolvida pelo produto'),
});

export const AnalyzeIcpOutputSchema = z.object({
  icp_id: z.string().uuid().describe('ID único do perfil de ICP gerado no banco de dados'),
  company_summary: z.string().describe('Síntese da proposta de valor da empresa'),
  target_personas: z.array(TargetPersonaSchema).describe('Lista de personas ideais identificadas'),
  value_propositions: z.array(z.string()).describe('Propostas de valor e diferenciais competitivos'),
});

export type AnalyzeIcpInput = z.infer<typeof AnalyzeIcpInputSchema>;
export type AnalyzeIcpOutput = z.infer<typeof AnalyzeIcpOutputSchema>;
