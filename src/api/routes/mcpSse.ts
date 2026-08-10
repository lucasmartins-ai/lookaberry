import { FastifyInstance } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from '../../mcp/server.js';

export async function mcpSseRoutes(app: FastifyInstance) {
  const transports = new Map<string, SSEServerTransport>();

  // Endpoint to establish SSE connection
  app.get('/sse', async (request, reply) => {
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport('/messages', reply.raw);

    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    transport.onclose = () => {
      transports.delete(sessionId);
    };

    await mcpServer.connect(transport);
  });

  // Endpoint to receive client messages (JSON-RPC)
  app.post('/messages', async (request, reply) => {
    const sessionId = request.query && typeof request.query === 'object' && 'sessionId' in request.query
      ? (request.query as { sessionId: string }).sessionId
      : undefined;

    if (!sessionId || !transports.has(sessionId)) {
      return reply.status(404).send({ error: 'Session not found or expired' });
    }

    const transport = transports.get(sessionId)!;
    await transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
}
