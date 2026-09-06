import { verifyJwtService } from '../auth/verify-jwt.service.js';
import { userRepository } from '../../repositories/user.repository.js';
import { UnauthorizedError } from '../auth/errors.js';
import type { Requester } from '../assets/ownership.js';

// A browser WebSocket can't set an Authorization header, so the access
// token travels as a query param (?token=...) instead — the one departure
// from the REST Bearer-header convention, forced by transport, not a
// second auth scheme. Reuses the exact same verifyJwtService +
// userRepository pieces src/plugins/auth.ts composes for REST, just
// without a Fastify request/reply pair to hang them off.
export async function authenticateSocket(token: string | undefined): Promise<Requester> {
  if (!token) {
    throw new UnauthorizedError('Missing token');
  }
  const payload = verifyJwtService.verify(token);
  const user = await userRepository.findById(payload.sub);
  if (!user) {
    throw new UnauthorizedError('User not found');
  }
  return { id: user.id, role: user.role };
}
