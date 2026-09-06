import { Prisma } from '../generated/prisma/client.js';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

export function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}
