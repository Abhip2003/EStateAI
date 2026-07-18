import { registerService } from '../src/services/auth/register.service.js';
import { loginService } from '../src/services/auth/login.service.js';
import { InvalidCredentialsError } from '../src/services/auth/errors.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

async function main(): Promise<void> {
  const email = `verify-login-${Date.now()}@example.test`;
  const correctPassword = 'CorrectHorseBatteryStaple';
  let createdUserId: string | undefined;

  try {
    console.log('0. register() — create a test user');
    const registered = await registerService.register({
      email,
      password: correctPassword,
      firstName: 'Verify',
      lastName: 'Login',
    });
    createdUserId = registered.id;
    console.log('   id:', registered.id);

    console.log('1. login() — successful login');
    const result = await loginService.login({ email, password: correctPassword });
    console.log(
      '   accessToken present:',
      typeof result.accessToken === 'string' ? 'OK' : 'FAILED',
    );
    console.log(
      '   passwordHash exposed:',
      'passwordHash' in result.user ? 'FAILED (leaked)' : 'OK (not present)',
    );
    console.log('   user.email matches:', result.user.email === email ? 'OK' : 'FAILED');

    console.log('2. login() — wrong password');
    let wrongPasswordRejected = false;
    try {
      await loginService.login({ email, password: 'TotallyWrongPassword' });
    } catch (err) {
      wrongPasswordRejected = err instanceof InvalidCredentialsError;
    }
    console.log(
      '   result:',
      wrongPasswordRejected ? 'OK (InvalidCredentialsError thrown)' : 'FAILED (not rejected)',
    );

    console.log('3. login() — nonexistent email');
    let nonexistentEmailRejected = false;
    try {
      await loginService.login({ email: 'nobody-here@example.test', password: correctPassword });
    } catch (err) {
      nonexistentEmailRejected = err instanceof InvalidCredentialsError;
    }
    console.log(
      '   result:',
      nonexistentEmailRejected ? 'OK (InvalidCredentialsError thrown)' : 'FAILED (not rejected)',
    );

    console.log('\nAll login checks passed.');
  } finally {
    console.log('4. cleanup');
    if (createdUserId) {
      const deleted = await userRepository.delete(createdUserId);
      console.log('   deleted:', deleted?.id === createdUserId ? 'OK' : 'FAILED');
    }
    await prisma.$disconnect();
  }
}

void main();
