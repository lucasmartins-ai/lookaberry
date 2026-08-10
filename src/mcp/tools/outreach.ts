import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ScheduleOutreachSequenceInputSchema } from '../schemas/outreach.js';
import { outreachService } from '../../core/outreach/service.js';

export function registerOutreachTool(server: McpServer) {
  server.tool('gtm_schedule_outreach_sequence', 'Agenda uma sequência multicanal com cotas e salvaguardas anti-ban.', ScheduleOutreachSequenceInputSchema.shape, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await outreachService.scheduleSequence(args), null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Erro ao agendar sequência: ${error.message}` }] };
    }
  });
}
