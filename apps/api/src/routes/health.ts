import type { FastifyInstance } from 'fastify';
import { checkDatabaseConnection } from '../db/prisma.js';

export function healthRoutes(app: FastifyInstance): void {
  app.get('/health', () => {
    return { status: 'ok' };
  });

  app.get('/health/db', async (request, reply) => {
    const isConnected = await checkDatabaseConnection();

    if (!isConnected) {
      reply.code(503);
      return { status: 'error', database: 'disconnected' };
    }

    return { status: 'ok', database: 'connected' };
  });
}
