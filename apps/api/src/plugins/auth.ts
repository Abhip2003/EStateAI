import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyJwtService } from '../services/auth/verify-jwt.service.js';
import { userRepository } from '../repositories/user.repository.js';
import { UnauthorizedError } from '../services/auth/errors.js';
import { toSafeUser } from '../services/auth/safe-user.js';

const BEARER_PREFIX = 'Bearer ';

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(BEARER_PREFIX.length);
    const payload = verifyJwtService.verify(token);

    const user = await userRepository.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    request.user = toSafeUser(user);
  } catch (err) {
    const message = err instanceof UnauthorizedError ? err.message : 'Unauthorized';
    reply.code(401);
    await reply.send({ status: 'error', message });
  }
}

export function authPlugin(app: FastifyInstance): void {
  app.decorateRequest('user');
  app.decorate('authenticate', authenticate);
}
