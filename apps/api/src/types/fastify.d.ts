import type { FastifyReply } from 'fastify';
import type { SafeUser } from '../services/auth/safe-user.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Only populated after the `authenticate` preHandler has run.
    user: SafeUser;
  }

  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
