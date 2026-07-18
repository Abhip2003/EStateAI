import crypto from 'node:crypto';
import { refreshTokenRepository } from '../../repositories/refresh-token.repository.js';
import { config } from '../../config/env.js';
import { InvalidRefreshTokenError, RefreshTokenReuseError } from './errors.js';
import type { RefreshToken } from '../../generated/prisma/client.js';

const RAW_TOKEN_BYTES = 64;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Refresh tokens are random opaque strings, not passwords — they must be
// looked up by exact hash equality, which bcrypt (salted, non-deterministic)
// cannot do. A fast, deterministic hash is correct here.
function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

class RefreshTokenService {
  async generate(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(RAW_TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + config.refreshToken.ttlDays * MS_PER_DAY);

    await refreshTokenRepository.create({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    });

    return { token, expiresAt };
  }

  async validate(rawToken: string): Promise<RefreshToken> {
    const record = await refreshTokenRepository.findByTokenHash(hashToken(rawToken));

    if (!record) {
      throw new InvalidRefreshTokenError();
    }

    if (record.revokedAt) {
      // Already rotated/revoked but presented again — the whole token
      // family is treated as compromised.
      await refreshTokenRepository.revokeAllForUser(record.userId);
      throw new RefreshTokenReuseError();
    }

    if (record.expiresAt.getTime() < Date.now()) {
      throw new InvalidRefreshTokenError();
    }

    return record;
  }

  async revoke(rawToken: string): Promise<void> {
    const record = await refreshTokenRepository.findByTokenHash(hashToken(rawToken));
    if (record) {
      await refreshTokenRepository.revoke(record.id);
    }
  }

  async rotate(rawToken: string): Promise<{ token: string; expiresAt: Date; userId: string }> {
    const record = await this.validate(rawToken);
    await refreshTokenRepository.revoke(record.id);
    const { token, expiresAt } = await this.generate(record.userId);
    return { token, expiresAt, userId: record.userId };
  }
}

export const refreshTokenService = new RefreshTokenService();
