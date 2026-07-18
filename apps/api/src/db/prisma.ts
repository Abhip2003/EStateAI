import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});

export const prisma = new PrismaClient({ adapter });

const HEALTH_CHECK_TIMEOUT_MS = 3000;

export async function checkDatabaseConnection(): Promise<boolean> {
  const query = prisma.$queryRaw`SELECT 1`;
  // Prevent an unhandled rejection if the timeout below wins the race.
  query.catch(() => undefined);

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('Database health check timed out')), HEALTH_CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([query, timeout]);
    return true;
  } catch {
    return false;
  }
}
