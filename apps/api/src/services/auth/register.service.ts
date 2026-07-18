import { userRepository } from '../../repositories/user.repository.js';
import { passwordService } from '../password.service.js';
import { EmailAlreadyExistsError } from './errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import { toSafeUser, type SafeUser } from './safe-user.js';

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

class RegisterService {
  async register(input: RegisterInput): Promise<SafeUser> {
    const emailAlreadyExists = await userRepository.existsByEmail(input.email);
    if (emailAlreadyExists) {
      throw new EmailAlreadyExistsError(input.email);
    }

    const passwordHash = await passwordService.hash(input.password);

    try {
      // role and emailVerified are intentionally omitted — the Prisma schema
      // defaults (USER, false) apply.
      const user = await userRepository.create({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
      });

      return toSafeUser(user);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new EmailAlreadyExistsError(input.email);
      }
      throw err;
    }
  }
}

export const registerService = new RegisterService();
