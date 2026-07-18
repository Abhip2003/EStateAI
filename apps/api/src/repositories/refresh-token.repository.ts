import { prisma } from '../db/prisma.js';
import type { Prisma, RefreshToken } from '../generated/prisma/client.js';

class RefreshTokenRepository {
  async create(data: Prisma.RefreshTokenUncheckedCreateInput): Promise<RefreshToken> {
    return prisma.refreshToken.create({ data });
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    return prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async revoke(id: string): Promise<RefreshToken | null> {
    try {
      return await prisma.refreshToken.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
    } catch {
      return null;
    }
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}

export const refreshTokenRepository = new RefreshTokenRepository();
