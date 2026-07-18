import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

let failed = false;

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`   ${label}: OK`);
  } else {
    console.log(`   ${label}: FAILED (${detail})`);
    failed = true;
  }
}

async function main(): Promise<void> {
  const email = `verify-auth-me-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple';
  let createdUserId: string | undefined;

  try {
    console.log('0. POST /auth/register — create a temporary user');
    const registerRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, firstName: 'Verify', lastName: 'AuthMe' }),
    });
    const registerBody = (await registerRes.json()) as { id?: string };
    createdUserId = registerBody.id;
    check('status', registerRes.status === 201, `${registerRes.status}`);

    console.log('1. POST /auth/login — obtain an access token');
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = (await loginRes.json()) as { accessToken?: string };
    check('status', loginRes.status === 200, `${loginRes.status}`);
    check('accessToken present', typeof loginBody.accessToken === 'string', 'missing');
    const accessToken = loginBody.accessToken ?? '';

    console.log('2. GET /auth/me — with a valid token');
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meBody = (await meRes.json()) as { email?: string; passwordHash?: string };
    check('status', meRes.status === 200, `${meRes.status}`);
    check('user.email matches', meBody.email === email, `${meBody.email}`);
    check('passwordHash not exposed', meBody.passwordHash === undefined, 'leaked');

    console.log('3. GET /auth/me — without a token');
    const noTokenRes = await fetch(`${BASE_URL}/auth/me`);
    check('status', noTokenRes.status === 401, `${noTokenRes.status}`);

    console.log('4. GET /auth/me — with an invalid token');
    const invalidTokenRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: 'Bearer this.is.not-a-valid-jwt' },
    });
    check('status', invalidTokenRes.status === 401, `${invalidTokenRes.status}`);

    if (failed) {
      console.error('\nOne or more auth/me checks FAILED.');
    } else {
      console.log('\nAll auth/me checks passed.');
    }
  } finally {
    console.log('5. cleanup');
    if (createdUserId) {
      const deleted = await userRepository.delete(createdUserId);
      console.log('   deleted:', deleted?.id === createdUserId ? 'OK' : 'FAILED');
    }
    await prisma.$disconnect();
  }

  if (failed) {
    process.exitCode = 1;
  }
}

void main();
