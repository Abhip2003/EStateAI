import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import type { User } from '../../generated/prisma/client.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

type SignableUser = Pick<User, 'id' | 'email' | 'role'>;

class JwtService {
  signAccessToken(user: SignableUser): string {
    return jwt.sign(
      {
        email: user.email,
        role: user.role,
      },
      config.jwt.secret,
      {
        subject: user.id,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
        // Cast: the ms-format string is validated at config-load time, but
        // jsonwebtoken's types want its own narrower string literal union.
        expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
      },
    );
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return jwt.verify(token, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    }) as AccessTokenPayload;
  }
}

export const jwtService = new JwtService();
