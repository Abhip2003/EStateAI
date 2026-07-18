import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

async function main(): Promise<void> {
  const email = `verify-login-api-${Date.now()}@example.test`;
  const correctPassword = 'CorrectHorseBatteryStaple';
  let createdUserId: string | undefined;

  try {
    console.log('0. POST /auth/register — create a test user');
    const registerRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: correctPassword,
        firstName: 'Verify',
        lastName: 'LoginApi',
      }),
    });
    const registerBody = (await registerRes.json()) as { id?: string };
    createdUserId = registerBody.id;
    console.log(
      '   status:',
      registerRes.status === 201 ? 'OK (201)' : `FAILED (${registerRes.status})`,
    );

    console.log('1. POST /auth/login — successful login');
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: correctPassword }),
    });
    const loginBody = (await loginRes.json()) as {
      user?: { email?: string; passwordHash?: string };
      accessToken?: string;
    };
    console.log('   status:', loginRes.status === 200 ? 'OK (200)' : `FAILED (${loginRes.status})`);
    console.log(
      '   accessToken present:',
      typeof loginBody.accessToken === 'string' ? 'OK' : 'FAILED',
    );
    console.log(
      '   passwordHash exposed:',
      loginBody.user?.passwordHash === undefined ? 'OK (not present)' : 'FAILED (leaked)',
    );

    console.log('2. POST /auth/login — wrong password');
    const wrongPasswordRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TotallyWrongPassword' }),
    });
    console.log(
      '   status:',
      wrongPasswordRes.status === 401 ? 'OK (401)' : `FAILED (${wrongPasswordRes.status})`,
    );

    console.log('3. POST /auth/login — nonexistent email');
    const nonexistentRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody-here@example.test', password: correctPassword }),
    });
    console.log(
      '   status:',
      nonexistentRes.status === 401 ? 'OK (401)' : `FAILED (${nonexistentRes.status})`,
    );

    console.log('4. POST /auth/login — invalid request body');
    const invalidRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    console.log(
      '   status:',
      invalidRes.status === 400 ? 'OK (400)' : `FAILED (${invalidRes.status})`,
    );

    console.log('\nAll API login checks passed.');
  } finally {
    console.log('5. cleanup');
    if (createdUserId) {
      const deleted = await userRepository.delete(createdUserId);
      console.log('   deleted:', deleted?.id === createdUserId ? 'OK' : 'FAILED');
    }
    await prisma.$disconnect();
  }
}

void main();
