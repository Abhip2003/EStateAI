import { prisma } from '../db/prisma.js';
import type { Prisma, User } from '../generated/prisma/client.js';

class UserRepository {
  async create(data: Prisma.UserCreateInput): Promise<User> {
    return prisma.user.create({ data });
  }

  async findById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  async existsByEmail(email: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    return user !== null;
  }

  async update(id: string, data: Prisma.UserUpdateInput): Promise<User | null> {
    try {
      return await prisma.user.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<User | null> {
    try {
      return await prisma.user.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async count(): Promise<number> {
    return prisma.user.count();
  }
}

export const userRepository = new UserRepository();
