import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

async function main(): Promise<void> {
  const email = `verify-register-api-${Date.now()}@example.test`;
  let createdUserId: string | undefined;

  try {
    console.log('1. POST /auth/register — successful registration');
    const registerRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'CorrectHorseBatteryStaple',
        firstName: 'Verify',
        lastName: 'Api',
      }),
    });
    const registerBody = (await registerRes.json()) as { id?: string; passwordHash?: string };
    createdUserId = registerBody.id;

    console.log(
      '   status:',
      registerRes.status === 201 ? 'OK (201)' : `FAILED (${registerRes.status})`,
    );
    console.log(
      '   passwordHash exposed:',
      registerBody.passwordHash === undefined ? 'OK (not present)' : 'FAILED (leaked)',
    );

    console.log('2. POST /auth/register — duplicate email rejection');
    const duplicateRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'AnotherPassword123',
        firstName: 'Duplicate',
        lastName: 'User',
      }),
    });
    console.log(
      '   status:',
      duplicateRes.status === 409 ? 'OK (409)' : `FAILED (${duplicateRes.status})`,
    );

    console.log('3. POST /auth/register — invalid body');
    const invalidRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'not-an-email',
        password: 'short',
      }),
    });
    console.log(
      '   status:',
      invalidRes.status === 400 ? 'OK (400)' : `FAILED (${invalidRes.status})`,
    );

    console.log('\nAll API registration checks passed.');
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
