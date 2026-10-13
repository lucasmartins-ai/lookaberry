import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { executionRouter } from '../../core/execution/index.js';
import type { ExecutionContext } from '../../core/execution/types.js';
import { shouldBlockLead, type SuppressionStore } from '../../core/security/suppression.js';

const BLOCKED_STATUSES = new Set(['UNSUBSCRIBED', 'BOUNCED', 'REPLIED_NEGATIVE']);
// ponytail: per-process counter (resets on restart); move to the DB if MCP sends become a main channel
const MCP_DAILY_LIMIT = Number(process.env.WHATSAPP_MCP_DAILY_LIMIT ?? 50);
let mcpSent = { day: '', count: 0 };

function sentTodayCount(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (mcpSent.day !== day) mcpSent = { day, count: 0 };
  return mcpSent.count;
}

/** Same opt-out rules as the dispatcher: lead status + global suppression list. Returns a reason or null. */
export async function whatsappBlockReason(
  store: SuppressionStore,
  lead: { id: string; status?: string | null; email?: string | null; linkedinUrl?: string | null; company?: { domain?: string | null } | null },
): Promise<string | null> {
  if (lead.status && BLOCKED_STATUSES.has(lead.status)) return `Lead status ${lead.status}`;
  const check = await shouldBlockLead(store, lead);
  return check.blocked ? (check.reason ?? 'Lead suppressed') : null;
}

const GtmSendWhatsAppInputSchema = z.object({
  lead_id: z.string().describe('UUID do lead.'),
  template_name: z.string().optional().describe('Nome do template WhatsApp aprovado (sobrescreve env).'),
  body: z.string().optional().describe('Corpo da mensagem com placeholders {{firstName}}/{{companyName}}.'),
  dryRun: z.boolean().optional().default(false).describe('Simular envio sem chamar a API.'),
});

export function registerWhatsAppTool(server: McpServer) {
  server.tool(
    'gtm_send_whatsapp',
    'Envia uma mensagem WhatsApp via Meta Business Cloud API para o lead especificado.',
    GtmSendWhatsAppInputSchema.shape,
    async args => {
      try {
        // Retrieve the lead
        const lead = await prisma.lead.findUnique({
          where: { id: args.lead_id },
          include: {
            company: {
              select: {
                id: true,
                name: true,
                domain: true,
                linkedinUrl: true,
              },
            },
          },
        });

        if (!lead) {
          return { isError: true, content: [{ type: 'text', text: `Lead não encontrado: ${args.lead_id}` }] };
        }

        if (!lead.phone) {
          return { isError: true, content: [{ type: 'text', text: `Lead ${lead.fullName} não possui telefone cadastrado.` }] };
        }

        const blockReason = await whatsappBlockReason(prisma as any, lead);
        if (blockReason) {
          return { isError: true, content: [{ type: 'text', text: `Envio bloqueado para ${lead.fullName}: ${blockReason}` }] };
        }
        if (!args.dryRun && sentTodayCount() >= MCP_DAILY_LIMIT) {
          return { isError: true, content: [{ type: 'text', text: `Limite diário de ${MCP_DAILY_LIMIT} envios WhatsApp via MCP atingido.` }] };
        }

        const body = args.body ?? `Olá {{firstName}}, tudo bem?`;
        const templateName = args.template_name ?? process.env.WHATSAPP_TEMPLATE_NAME ?? '';

        const context: ExecutionContext = {
          lead: {
            id: lead.id,
            firstName: lead.firstName,
            lastName: lead.lastName,
            fullName: lead.fullName,
            title: lead.title,
            linkedinUrl: lead.linkedinUrl,
            email: lead.email,
            phone: lead.phone,
            phoneStatus: lead.phoneStatus,
          },
          company: {
            id: lead.company.id,
            name: lead.company.name,
            domain: lead.company.domain,
            linkedinUrl: lead.company.linkedinUrl,
          },
          account: {
            id: 'mcp-default',
            provider: 'whatsapp',
            externalId: 'mcp',
            dailyLimit: MCP_DAILY_LIMIT,
            sentToday: sentTodayCount(),
            pausedUntil: null,
            sessionKey: null,
          },
          message: {
            id: `mcp:whatsapp:${lead.id}`,
            subject: null,
            body,
            outreachAccountId: null,
          },
          dryRun: args.dryRun ?? false,
        };

        const result = await executionRouter.execute(
          {
            channel: 'whatsapp',
            capability: 'sendMessage',
            timing: 'WITHIN_24H',
            template: templateName,
            rationale: `MCP direct WhatsApp send to ${lead.fullName}`,
          },
          context,
        );
        if (result.success && !context.dryRun) mcpSent.count++;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  lead_id: lead.id,
                  lead_name: lead.fullName,
                  phone: lead.phone,
                  success: result.success,
                  externalId: result.externalId,
                  error: result.error,
                  dryRun: context.dryRun,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: `Erro ao enviar WhatsApp: ${error.message}` }] };
      }
    },
  );
}