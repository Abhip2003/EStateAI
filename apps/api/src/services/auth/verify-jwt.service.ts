import { jwtService, type AccessTokenPayload } from './jwt.service.js';
import { UnauthorizedError } from './errors.js';

class VerifyJwtService {
  verify(token: string): AccessTokenPayload {
    try {
      return jwtService.verifyAccessToken(token);
    } catch {
      // Covers both an invalid signature (JsonWebTokenError) and an expired
      // token (TokenExpiredError) — callers only need to know it's unusable.
      throw new UnauthorizedError('Invalid or expired access token');
    }
  }
}

export const verifyJwtService = new VerifyJwtService();
