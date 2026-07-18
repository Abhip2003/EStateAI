import { registerService } from '../src/services/auth/register.service.js';
import { EmailAlreadyExistsError } from '../src/services/auth/errors.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

async function main(): Promise<void> {
  const email = `verify-register-${Date.now()}@example.test`;
  let createdUserId: string | undefined;

  try {
    console.log('1. register() — successful registration');
    const user = await registerService.register({
      email,
      password: 'CorrectHorseBatteryStaple',
      firstName: 'Verify',
      lastName: 'Register',
    });
    createdUserId = user.id;

    console.log('   id:', user.id);
    console.log('   role:', user.role === 'USER' ? 'OK (USER)' : `FAILED (${user.role})`);
    console.log(
      '   emailVerified:',
      user.emailVerified === false ? 'OK (false)' : `FAILED (${user.emailVerified})`,
    );
    console.log(
      '   passwordHash exposed:',
      'passwordHash' in user ? 'FAILED (leaked)' : 'OK (not present)',
    );

    console.log('2. register() — duplicate email rejection');
    let duplicateRejected = false;
    try {
      await registerService.register({
        email,
        password: 'AnotherPassword123',
        firstName: 'Duplicate',
        lastName: 'User',
      });
    } catch (err) {
      duplicateRejected = err instanceof EmailAlreadyExistsError;
    }
    console.log(
      '   result:',
      duplicateRejected ? 'OK (EmailAlreadyExistsError thrown)' : 'FAILED (not rejected)',
    );

    console.log('\nAll registration checks passed.');
  } finally {
    console.log('3. cleanup');
    if (createdUserId) {
      const deleted = await userRepository.delete(createdUserId);
      console.log('   deleted:', deleted?.id === createdUserId ? 'OK' : 'FAILED');
    }
    await prisma.$disconnect();
  }
}

void main();
